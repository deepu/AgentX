/**
 * Hosts the MemWise kernel in this process (19 §9): the database (the bundled Postgres on the
 * desktop, `MEMWISE_DATABASE_URL` on a server), the project folder (seeded from
 * examples/intake on first start, re-indexed when its files change), the model roles, the
 * people, and who each connected client acts as.
 *
 * Starting never throws to the caller unless asked: a failure is logged and shown through
 * `memwise:status`, and chat keeps working.
 */
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import type { Diagnostic, ProjectDefs } from '@memwise/defs'
import type { ToolDefinition } from '@memwise/gateway'
import type { Actor, Kernel as KernelPhase1, KernelOptions, KernelPhase2, Person } from '@memwise/runtime'
import type { DtoContext, ToolInfo } from './dto'
import { emitMemwiseChange, getMemwiseHostStatus, getMemwiseService, onMemwiseChange, setMemwiseHostStatus, setMemwiseService, type MemwiseHostStatus } from './host'
import { invalidateSkillsCache, setPluginSkillsRootProvider } from '@memwise/shared/skills'
import { defaultModelResolver, projectModelRoles, type ModelResolver } from './models'
import { addMissingMetaPlaybooks, affectsIndex, findExampleProject, findExamplePlugins, META_PLAYBOOK_DIRS, seedProject } from './seed'
import { createConnectorBridge, type SourcePluginFolder } from './connectors'
import { projectToolInfo, toDiagnostic } from './dto'
import { createPublicHandler, findFormAppDir, type PublicHandler } from './public'
import { createPublicAddress, type PublicAddress, type PublicAddressOptions } from './relay'
import { channelTools, pgSentStore } from './channels'

export interface MemwiseLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** The kernel with its Phase 2 API (the same type once `Kernel extends KernelPhase2`). */
export type Kernel = KernelPhase1 & KernelPhase2

export type PersonActor = Extract<Actor, { kind: 'person' }>

/** Who is asking: the connection, and the person it signed in as (server mode). */
export interface ClientIdentity { clientId: string; personId?: string | null }

export interface MemwiseServiceOptions {
  /** `~/.memwise` (CONFIG_DIR). Postgres data, files and the seeded project live under it. */
  configDir: string
  /** Default `<configDir>/project`, or `MEMWISE_PROJECT_DIR`. */
  projectDir?: string
  /** A server's database; default `MEMWISE_DATABASE_URL`, else the bundled Postgres. */
  databaseUrl?: string
  /** Uploads; default `<configDir>/files`. */
  filesDir?: string
  modelResolver?: ModelResolver
  logger: MemwiseLogger
  /** `desktop`: one local owner who may act as anyone. `server`: people sign in. */
  mode?: 'desktop' | 'server'
  /** Where to look for the bundled examples/intake (resources path, app root). */
  exampleRoots?: string[]
  /** Folder with initdb/pg_ctl/postgres; default the bundled ones (`MEMWISE_PG_BIN_DIR`). */
  pgBinDir?: string
  /** Tools beyond the sample set (caller tools win by name). */
  tools?: ToolDefinition[]
  /**
   * The workspace whose connectors (MCP sources) plugins may use as `{ source: <slug> }` servers.
   * Default `MEMWISE_WORKSPACE_DIR`, else the app's active workspace, looked up at each use.
   */
  workspaceRoot?: string | (() => string | undefined)
  /** Re-index when project files change. Default true. */
  watch?: boolean
  /** Tests: rethrow a startup failure instead of only reporting it. */
  throwOnError?: boolean
  /** Owner's name and email; default the OS user name. */
  owner?: { name: string; email: string }
  /** Admin URL for the throwaway databases of draft example cases; default the bundled cluster, else MEMWISE_TEST_DATABASE_URL. */
  testDatabaseUrl?: string
  /** Tests: run draft example cases in process instead of spawning the CLI. */
  testRunner?: KernelOptions['testRunner']
  /** The built form app (`apps/external-form/dist`); default found under `exampleRoots` or `MEMWISE_FORM_APP_DIR`. */
  formAppDir?: string
  /** The relay tunnel's client name (`memwise-desktop/0.16.0`); tests also swap the tunnel, identity, listener and environment. */
  publicAddress?: Pick<PublicAddressOptions, 'startTunnel' | 'loadIdentity' | 'listen' | 'env' | 'client'>
}

export interface MemwiseService {
  readonly kernel: Kernel
  readonly mode: 'desktop' | 'server'
  readonly projectDir: string
  readonly databaseUrl: string
  readonly owner: Person
  readonly modelConfigured: boolean
  /** Whether the project was seeded from the example on this start. */
  readonly seeded: boolean
  /** The bundled example plugins folder (`examples/plugins`), for "Install an example plugin". */
  readonly examplePluginsDir?: string
  /**
   * The workspace's enabled MCP connectors as installable plugin folders (`source/<slug>`), each
   * ready for `kernel.plugins.install(dir)`. Empty without a workspace or sources.
   */
  sourcePlugins(): Promise<SourcePluginFolder[]>
  status(): MemwiseHostStatus
  /** The indexed definitions with what the DTO mappers need. */
  context(): Promise<DtoContext>
  /** Phase 5: the relay tunnel and a server's own public base (Settings → Public address). */
  readonly publicAddress: PublicAddress
  /** Phase 5: answers the public routes (forms, inbox links, webhooks); the tunnel and the direct listener call it. */
  readonly publicHandler: PublicHandler
  /** The person this client acts as (the signed-in person, else who the owner switched to, else the owner). */
  personFor(client: ClientIdentity): Promise<Person>
  actorFor(client: ClientIdentity): Promise<PersonActor>
  /** The owner's connections (desktop, or the shared server token) may act as someone else. */
  canActAs(client: ClientIdentity): boolean
  actAs(client: ClientIdentity, personId: string): Promise<Person>
  forgetClient(clientId: string): void
  reindex(): Promise<Diagnostic[]>
  stop(): Promise<void>
}

const DEMO_PEOPLE = [
  { name: 'Priya (staff)', email: 'priya@example.com', roles: ['staff'] },
  { name: 'Ravi (manager)', email: 'ravi@example.com', roles: ['manager'] },
]

function ownerDefaults(mode: 'desktop' | 'server'): { name: string; email: string } {
  let name = process.env.MEMWISE_OWNER_NAME
  if (!name) {
    try { name = userInfo().username } catch { name = undefined }
  }
  name ||= mode === 'server' ? 'Administrator' : 'Owner'
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '.').replace(/^\.+|\.+$/g, '') || 'owner'
  return { name, email: process.env.MEMWISE_OWNER_EMAIL || `${slug}@memwise.local` }
}

let pluginSkillsOffered = false

/**
 * Skills of the plugins installed in the running project join chat's skills as a fourth tier,
 * `<plugin>:<skill>` (doc 25 §7): the skills loader asks for the project folder at each load,
 * and forgets what it read when plugins or definitions change.
 */
function offerPluginSkills(): void {
  setPluginSkillsRootProvider(() => getMemwiseService()?.projectDir)
  if (pluginSkillsOffered) return
  pluginSkillsOffered = true
  onMemwiseChange((c) => {
    if (c.kind === 'plugins' || c.kind === 'definitions') invalidateSkillsCache()
  })
}

function readState(file: string): { ownerId?: string } {
  try { return JSON.parse(readFileSync(file, 'utf8')) as { ownerId?: string } } catch { return {} }
}

function writeState(file: string, state: { ownerId?: string }): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(state, null, 2))
  } catch { /* the owner is found again by email */ }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function startMemwiseService(opts: MemwiseServiceOptions): Promise<MemwiseService | null> {
  const log = opts.logger
  const mode = opts.mode ?? 'desktop'
  let cluster: import('@memwise/db').Cluster | undefined
  let kernel: Kernel | undefined
  let address: PublicAddress | undefined
  setMemwiseHostStatus({ phase: 'starting', message: 'Starting the database…', diagnostics: [] })
  try {
    const db = await import('@memwise/db')
    // ---- database
    let databaseUrl = opts.databaseUrl ?? process.env.MEMWISE_DATABASE_URL
    if (!databaseUrl) {
      const dataDir = join(opts.configDir, 'postgres', 'data')
      cluster = await db.startCluster({
        dataDir,
        ...(opts.pgBinDir ?? process.env.MEMWISE_PG_BIN_DIR ? { binDir: opts.pgBinDir ?? process.env.MEMWISE_PG_BIN_DIR } : {}),
        log: (m) => log.info(`[memwise] ${m}`),
      })
      try {
        await cluster.createDatabase('memwise')
      } catch (e) {
        if ((e as { code?: string }).code !== '42P04') throw e // 42P04: it already exists
      }
      databaseUrl = cluster.url('memwise')
      const started = cluster
      process.once('exit', () => { try { started.stopSync() } catch { /* exiting anyway */ } })
    }

    // ---- project folder
    setMemwiseHostStatus({ message: 'Loading the playbooks…' })
    const projectDir = opts.projectDir ?? process.env.MEMWISE_PROJECT_DIR ?? join(opts.configDir, 'project')
    const exampleDir = findExampleProject(opts.exampleRoots)
    const seeded = seedProject(projectDir, exampleDir)
    if (seeded) log.info(`[memwise] set up the playbooks folder ${projectDir} from the example`)
    const defs = await import('@memwise/defs')
    // Phase 3: building and changing playbooks are themselves playbooks; earlier installs lack
    // them. Phase 4 adds binding plugins (bind-plugin).
    try {
      const metaIds = [...new Set<string>([...META_PLAYBOOK_DIRS, ...defs.META_PLAYBOOKS])]
      const added = addMissingMetaPlaybooks(projectDir, exampleDir, metaIds)
      if (added.length) log.info(`[memwise] added the playbooks ${added.join(', ')} to ${projectDir}`)
    } catch (e) {
      log.warn(`[memwise] could not add the meta playbooks: ${errorMessage(e)}`)
    }
    const loaded = await defs.loadProject(projectDir)
    const examplePluginsDir = findExamplePlugins(opts.exampleRoots)

    // ---- models and tools
    const models = await (opts.modelResolver ?? defaultModelResolver)({ roles: projectModelRoles(loaded.project), project: loaded.project })
    log.info(`[memwise] ${models.message}`)
    const runtime = await import('@memwise/runtime')
    // Scripted mode keeps the sample extractor (the scripted checker calls it with document
    // names); otherwise the kernel binds the quarantined reader on the extractor role.
    // The stand-in reads what the scripted example says the documents show (its tool stub), so a
    // form's extraction in scripted mode offers the same values the example's check reads.
    const sampleOpts = {
      databaseUrl,
      ...(models.example ? { extracted: exampleExtracted(models.example.tools?.['intake.extract_fields']) } : { stubExtractor: false }),
    } as Parameters<typeof runtime.sampleTools>[0]
    // Phase 4 (22 §3): the same sample implementations back plugin tools on `run: { builtin }`
    // routes. A project that binds plugins (it has domain/bindings/) gets them only that way, so
    // nothing is bound until a binding freezes; earlier projects keep them always bound.
    const samples = runtime.sampleTools(sampleOpts)
    // Phase 5 (23 §6): the real channel plugins' builtins (email over SMTP, WhatsApp). Only plugin
    // routes reach them: the channel tools are bound by their fixed names (`email.send`) through a
    // binding, never under the builtins' own names.
    const builtins = [...samples, ...channelTools({ sent: pgSentStore(() => kernel!.pool) })]
    const usesBindings = existsSync(join(projectDir, 'domain', 'bindings'))
    const tools: ToolDefinition[] = [...(opts.tools ?? []), ...(usesBindings ? [] : samples)]
    const connectors = createConnectorBridge({
      configDir: opts.configDir,
      ...(opts.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}),
      logger: log,
    })
    const infoOf = (list: ToolDefinition[]) => {
      const out = new Map<string, ToolInfo>()
      for (const t of list) {
        if (out.has(t.name)) continue
        out.set(t.name, {
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          ...(typeof t.effect === 'string' ? { effect: t.effect } : {}),
          ...(t.source?.plugin ? { plugin: t.source.plugin } : {}),
        })
      }
      return out
    }
    // A directly passed tool wins by name; builtins describe the plugin tools bound to them too.
    const directInfo = infoOf(tools)
    const builtinInfo = infoOf(builtins)
    /** The tools as the kernel binds them for this project: entity tools and frozen bindings included. */
    const toolsFor = (project: ProjectDefs): Map<string, ToolInfo> =>
      projectToolInfo(directInfo, builtinInfo, defs.entityTools(project.entities ?? {}), defs.boundPluginTools(project))

    // ---- public address (Phase 5): the handler answers 503 until the kernel is up
    const publicHandler = createPublicHandler({
      kernel: () => kernel ?? null,
      formAppDir: opts.formAppDir ?? findFormAppDir(opts.exampleRoots),
      log,
    })
    const publicAddress = createPublicAddress({
      configDir: opts.configDir,
      handler: publicHandler,
      mode,
      log,
      onChange: () => emitMemwiseChange({ kind: 'relay' }),
      ...opts.publicAddress,
    })
    address = publicAddress
    let ownerName: string | undefined
    const businessName = () => process.env.MEMWISE_BUSINESS_NAME?.trim() || ownerName

    // ---- kernel
    setMemwiseHostStatus({ message: 'Starting the playbook engine…' })
    // Example cases of a draft run out of process on throwaway databases (20 §5): on the bundled
    // cluster's admin connection, or a server's MEMWISE_TEST_DATABASE_URL; otherwise the CLI
    // starts a throwaway cluster of its own.
    const testDatabaseUrl = opts.testDatabaseUrl ?? (cluster ? cluster.url('postgres') : process.env.MEMWISE_TEST_DATABASE_URL)
    const kernelOptions: KernelOptions & { filesDir?: string } = {
      databaseUrl,
      projectDir,
      tools,
      builtins,
      resolveMcpSource: (slug) => connectors.resolveMcpSource(slug),
      modelRoles: models.modelRoles,
      providers: models.providers,
      filesDir: opts.filesDir ?? join(opts.configDir, 'files'),
      logLevel: process.env.DBOS_LOG ?? 'error',
      ...(testDatabaseUrl ? { testDatabaseUrl } : {}),
      ...(opts.testRunner ? { testRunner: opts.testRunner } : {}),
      publicUrl: () => publicAddress.publicUrl(),
      businessName,
    }
    const k = (await runtime.createKernel(kernelOptions)) as Kernel
    kernel = k
    await k.index()

    let indexed = await k.project()
    const refreshContext = async () => { indexed = await k.project() }

    // ---- people
    const stateFile = join(opts.configDir, 'memwise', 'state.json')
    const roleIds = new Set((await k.people.roles()).map((r) => r.id))
    const knownRoles = (roles: string[]) => roles.filter((r) => roleIds.has(r))
    const ownerInfo = opts.owner ?? ownerDefaults(mode)
    const state = readState(stateFile)
    // The owner's roles: staff and manager where the project has them (the intake example); in a
    // project with roles of its own (Phase 6, like the eTMF's), every role it defines, since a
    // regulated domain allows no "act as" and the owner must be able to work in it themselves.
    const ownerRoles = knownRoles(['staff', 'manager']).length ? knownRoles(['staff', 'manager']) : [...roleIds]
    let owner: Person = (state.ownerId ? await k.people.get(state.ownerId) : undefined)
      ?? (await k.people.byEmail(ownerInfo.email))
      ?? (await k.people.create({ name: ownerInfo.name, email: ownerInfo.email, roles: ownerRoles }))
    // An owner made before the project's roles changed gains the ones it is missing.
    const missing = ownerRoles.filter((r) => !owner.roles.includes(r))
    if (missing.length) owner = await k.people.setRoles(owner.id, [...owner.roles, ...missing])
    if (state.ownerId !== owner.id) writeState(stateFile, { ...state, ownerId: owner.id })
    ownerName = owner.name
    if (seeded && mode === 'desktop') {
      for (const p of DEMO_PEOPLE) {
        if (!(await k.people.byEmail(p.email))) await k.people.create({ name: p.name, email: p.email, roles: knownRoles(p.roles) })
      }
    }

    // ---- changes and re-indexing
    const unsubscribe = k.onChange((c) => {
      // Phase 6: the flow dispatcher's own wake-ups (`entity` comes with a `records` change, `flow`
      // is the hand-off queue); the app has nothing to reload for them.
      const raw = (c as { kind: string }).kind
      if (raw === 'entity' || raw === 'flow') return
      if (c.kind === 'run') emitMemwiseChange({ kind: 'run', id: c.runId, caseId: c.caseId, workflowId: c.workflowId })
      else if (c.kind === 'drafts') emitMemwiseChange({ kind: 'drafts', id: c.draftId })
      else if (c.kind === 'records') emitMemwiseChange({ kind: 'records', entity: c.entity, ...(c.recordId ? { id: c.recordId } : {}) })
      else if (c.kind === 'definitions') {
        // The kernel re-indexed (a publish, or a reindex): the app's view follows it.
        void refreshContext().then(() => {
          setMemwiseHostStatus({ diagnostics: diagnosticsOf() })
          emitMemwiseChange({ kind: 'definitions' })
        }, () => emitMemwiseChange({ kind: 'definitions' }))
      } else emitMemwiseChange({ kind: c.kind })
    })

    const diagnosticsOf = () => indexed.diagnostics.map(toDiagnostic)
    const reindex = async (): Promise<Diagnostic[]> => {
      const diagnostics = await k.index()
      await refreshContext()
      setMemwiseHostStatus({ diagnostics: diagnosticsOf() })
      log.info(`[memwise] re-read the playbooks: ${diagnostics.filter((d) => d.severity === 'error').length} error(s)`)
      return diagnostics
    }

    let watcher: FSWatcher | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    if (opts.watch !== false && existsSync(projectDir)) {
      try {
        watcher = watch(projectDir, { recursive: true }, (_event, filename) => {
          // Only domain/ and workflows/ are live; drafts/ changes on every chat edit.
          if (!affectsIndex(typeof filename === 'string' ? filename : filename ? String(filename) : null)) return
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => {
            reindex().catch((e) => log.warn(`[memwise] re-reading the playbooks failed: ${errorMessage(e)}`))
          }, 500)
        })
        watcher.on('error', () => { /* folder gone; re-indexed on next start */ })
      } catch (e) {
        log.warn(`[memwise] not watching ${projectDir} for changes: ${errorMessage(e)}`)
      }
    }

    // ---- who each client acts as
    const actingAs = new Map<string, string>()
    const ownerPerson = owner
    const personFor = async (client: ClientIdentity): Promise<Person> => {
      const id = client.personId ?? actingAs.get(client.clientId) ?? ownerPerson.id
      const p = await k.people.get(id)
      if (p && !p.disabled) return p
      if (client.personId) throw new Error('Your sign-in is no longer valid. Sign in again.')
      actingAs.delete(client.clientId)
      return (await k.people.get(ownerPerson.id)) ?? ownerPerson
    }

    const service: MemwiseService = {
      kernel: k,
      mode,
      projectDir,
      databaseUrl,
      owner: ownerPerson,
      modelConfigured: models.configured,
      seeded,
      ...(examplePluginsDir ? { examplePluginsDir } : {}),
      sourcePlugins: () => connectors.sourcePluginFolders(),
      status: getMemwiseHostStatus,
      publicAddress,
      publicHandler,
      async context() {
        const { valueTypeToJsonSchema } = await import('@memwise/defs')
        // Always the kernel's current index: a publish re-indexes inside the kernel.
        indexed = await k.project()
        return { project: indexed.project as ProjectDefs, diagnostics: indexed.diagnostics, tools: toolsFor(indexed.project as ProjectDefs), toolsFor, jsonSchema: valueTypeToJsonSchema }
      },
      personFor,
      async actorFor(client) {
        const p = await personFor(client)
        return k.people.actorFor(p.id)
      },
      canActAs: (client) => !client.personId,
      async actAs(client, personId) {
        if (client.personId) throw new Error('Only the owner of this install can act as someone else.')
        const p = await k.people.get(personId)
        if (!p || p.disabled) throw new Error('That person was not found.')
        if (p.id === ownerPerson.id) actingAs.delete(client.clientId)
        else actingAs.set(client.clientId, p.id)
        emitMemwiseChange({ kind: 'status' })
        return p
      },
      forgetClient: (clientId) => { actingAs.delete(clientId) },
      reindex,
      async stop() {
        unsubscribe()
        if (timer) clearTimeout(timer)
        watcher?.close()
        setMemwiseService(null)
        await publicAddress.stop()
        try { await k.shutdown() } catch (e) { log.warn(`[memwise] engine shutdown: ${errorMessage(e)}`) }
        if (cluster) {
          try { await cluster.stop() } catch (e) { log.warn(`[memwise] database stop: ${errorMessage(e)}`) }
        }
        setMemwiseHostStatus({ phase: 'stopped', message: 'Playbooks are stopped.' })
      },
    }

    setMemwiseService(service)
    offerPluginSkills()
    setMemwiseHostStatus({
      phase: 'ready',
      message: models.configured ? undefined : models.message,
      projectDir,
      modelConfigured: models.configured,
      diagnostics: diagnosticsOf(),
    })
    log.info(`[memwise] ready: ${Object.keys(indexed.project.workflows).length} playbook(s) from ${projectDir}`)
    // The relay connects in the background; its state shows in Settings → Public address.
    void publicAddress.start()
    return service
  } catch (e) {
    const message = errorMessage(e)
    log.error(`[memwise] could not start: ${message}`)
    try { await address?.stop() } catch { /* never started */ }
    try { await kernel?.shutdown() } catch { /* already broken */ }
    try { await cluster?.stop() } catch { /* already broken */ }
    setMemwiseService(null)
    setMemwiseHostStatus({ phase: 'failed', message: `Playbooks could not start: ${message}` })
    if (opts.throwOnError) throw e
    return null
  }
}

/** An example's `intake.extract_fields` stub as the sample extractor's per-document table. */
function exampleExtracted(stub: unknown): Record<string, { name: string; value: string; confidence?: number }[]> | undefined {
  const fields = (stub as { fields?: unknown } | undefined)?.fields
  if (!Array.isArray(fields)) return undefined
  const out: Record<string, { name: string; value: string; confidence?: number }[]> = {}
  for (const f of fields as { name?: unknown; value?: unknown; document?: unknown; confidence?: unknown }[]) {
    if (typeof f?.name !== 'string' || typeof f.document !== 'string' || f.value === undefined) continue
    ;(out[f.document] ??= []).push({ name: f.name, value: String(f.value), ...(typeof f.confidence === 'number' ? { confidence: f.confidence } : {}) })
  }
  return Object.keys(out).length ? out : undefined
}
