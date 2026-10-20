/**
 * Phase 4 exit test (22 §11): plugins and bindings through the app API, driven as the owner,
 * staff and a manager against a real Postgres with scripted models. The plugins' example cases run
 * out of process through the real TestRunner (the `memwise` CLI from source); the sample CRM is a
 * real stdio MCP server.
 *
 * 1. A fresh domain (`memwise init`, empty) with its own `Customer` (`email` owned by the CRM) and
 *    the roles staff and manager. The three example plugins are installed; nothing is bound.
 * 2. sample-email is bound: every tool is classified, so check → propose → dry_run → review; the
 *    manager approves; freeze, link, end.
 * 3. client-intake is bound: `Client → Customer` with `tax_id → gstin`, `email_send → email.send`;
 *    its example cases pass through the binding; once frozen it is a live playbook "from Client
 *    intake 1.0.0", and a case on it writes a `Customer`.
 * 4. sample-crm (a Claude plugin over MCP) is bound: its tools come in unclassified, the binder
 *    classifies them, `contact → Customer` is mapped and the dry run maps the sample contacts; the
 *    manager approves; `link` links the contact with the same GSTIN, sends a near name to the inbox
 *    (confirmed there) and leaves an unrelated one unlinked. The customer's record shows the CRM's
 *    email, read through the link.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, PgEntityStore, postgresAvailable, type TestDatabase } from '@memwise/db'
import { initProject, nameSimilarity, parseExampleFile, type ExampleCase, type ScriptedTurn } from '@memwise/defs'
import type {
  MwBindingView, MwCase, MwCaseSummary, MwEntityRecord, MwEntityRow, MwIdentityCandidate, MwInboxItem, MwInstallChoices,
  MwPlaybook, MwPlaybookSummary, MwPluginDetail, MwPluginSummary, MwStepRecord,
} from '@memwise/shared/protocol'
import { RPC_CHANNELS } from '@memwise/shared/protocol'
import type { RequestContext } from '../../transport/types'
import { ctxFor, fakeServer, fakeSessions, quiet, until } from './api-harness'
import { registerMemwiseHandlers } from '../../handlers/rpc/memwise'
import type { HandlerDeps } from '../../handlers/handler-deps'
import { resetMemwiseHost } from '../host'
import type { ModelResolverInput, ResolvedModels } from '../models'
import { startMemwiseService, type MemwiseService } from '../service'

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..')
const PLUGINS = join(REPO, 'examples', 'plugins')
const INTAKE_EXAMPLES = join(PLUGINS, 'client-intake', 'workflows', 'client-intake', 'examples')
const ch = RPC_CHANNELS.memwise

const EMAIL = 'memwise/sample-email'
const INTAKE = 'memwise/client-intake'
const CRM = 'claude/sample-crm'
const GSTIN = '29AAACA1234A1Z5'

/** The domain's own customer: the CRM owns `email` (`crm` is the sample CRM's tool namespace). */
const CUSTOMER_YAML = `entity: Customer
fields:
  name:  PersonName
  email: Email
  gstin: Identifier(GSTIN)
  pan:   Identifier(PAN)
ownership:
  email: crm
`

/** The other customer already in the domain, and the CRM's contacts (SAMPLE_CRM_SEED). */
const MENON = 'Menon Exporters'
const CONTACTS = [
  // The intake customer's GSTIN in lower case with spaces around it: the mapping and the key normalise it.
  { id: 'c-201', company_name: 'Acme Traders Private Limited', email: 'accounts@acme-traders.example', gst_number: ` ${GSTIN.toLowerCase()} `, phone: '+91 80 4000 1010' },
  // A near name of Menon Exporters, no GSTIN: between the review (0.75) and auto (0.95) thresholds.
  { id: 'c-202', company_name: 'Menon Exports', email: 'ravi@menon-exports.example', phone: '+91 22 4000 2020' },
  // Nobody in the domain.
  { id: 'c-203', company_name: 'Brightline Software', email: 'hello@brightline.example', gst_number: '27AABCB1234C1Z1' },
]

const exampleFile = (name: string): ExampleCase => {
  const file = join(INTAKE_EXAMPLES, `${name}.yaml`)
  const parsed = parseExampleFile(readFileSync(file, 'utf8'), file)
  if (!parsed.value) throw new Error(`${file}: ${JSON.stringify(parsed.diagnostics)}`)
  return parsed.value
}

/** The binder classifies what the MCP hints left open (create_contact), then finishes. */
const BINDER: ScriptedTurn[] = [
  { toolCalls: [{ name: 'plugins.classify_tools', args: {
    classes: { 'crm.list_contacts': 'read', 'crm.get_contact': 'read', 'crm.create_contact': 'write' },
    reasons: {
      'crm.list_contacts': 'It only lists contacts.',
      'crm.get_contact': 'It only reads one contact.',
      'crm.create_contact': 'It adds a contact to the CRM, which can be removed there.',
    },
  } }] },
  { toolCalls: [{ name: 'step.finish', args: { outcome: 'proposed', rationale: 'Listing and reading contacts only read; creating one writes to the CRM.' } }] },
]

/**
 * Scripted models: the binder's turns, and client intake's own clean-application script (from the
 * plugin's example case; the playbook is not in the domain until its binding freezes).
 */
async function phase4Models(input: ModelResolverInput): Promise<ResolvedModels> {
  const { scriptedProvider } = await import('@memwise/gateway')
  const clean = exampleFile('clean-application')
  const script: Record<string, ScriptedTurn[]> = { ...(clean.model as Record<string, ScriptedTurn[]>), binder: BINDER }
  const roles = [...new Set([...input.roles, ...Object.keys(script)])]
  return {
    modelRoles: Object.fromEntries(roles.map((r) => [r, { provider: 'scripted', model: 'scripted' }])),
    providers: [scriptedProvider(script)],
    configured: true,
    message: 'Scripted answers for the Phase 4 exit test.',
    example: clean,
  }
}

describe.skipIf(!postgresAvailable())('Phase 4 exit: plugins and bindings', () => {
  let db: TestDatabase
  let dir: string
  let project: string
  let svc: MemwiseService
  const api = fakeServer()
  const sessions = fakeSessions()
  const owner = ctxFor('owner-client')
  let staff: RequestContext
  let manager: RequestContext

  async function caseAt(who: RequestContext, caseId: string, state: string, timeoutMs = 180_000): Promise<MwCase> {
    return until(`case ${caseId} at ${state}`, () => api.call<MwCase>(who, ch.CASES_GET, caseId),
      (c) => c.state === state || c.status !== 'active', timeoutMs)
  }

  async function inboxItem<K extends MwInboxItem['kind']>(who: RequestContext, kind: K, pick: (i: Extract<MwInboxItem, { kind: K }>) => boolean, timeoutMs = 60_000) {
    const items = await until(`a ${kind} item`, () => api.call<MwInboxItem[]>(who, ch.INBOX_LIST),
      (list) => list.some((i) => i.kind === kind && pick(i as Extract<MwInboxItem, { kind: K }>)), timeoutMs)
    return items.find((i) => i.kind === kind && pick(i as Extract<MwInboxItem, { kind: K }>)) as Extract<MwInboxItem, { kind: K }>
  }

  const plugin = async (id: string) => (await api.call<MwPluginSummary[]>(manager, ch.PLUGINS_LIST)).find((p) => p.id === id)
  const playbookIds = async () => (await api.call<MwPlaybookSummary[]>(staff, ch.PLAYBOOKS_LIST)).map((p) => p.id).sort()
  const boundTools = async () => (await svc.kernel.authoring!.vocabulary()).tools.map((t) => t.name).sort()
  let freshTools: string[] = []

  /**
   * The manager approves a bind-plugin case waiting in review (an inbox item that opens the binding
   * review), and the case freezes, links and ends.
   */
  async function managerApprovesBinding(pluginId: string, caseId: string): Promise<MwCase> {
    const review = await inboxItem(manager, 'decision', (i) => i.caseId === caseId)
    expect(review.workflowId).toBe('bind-plugin')
    expect(review.outcomes).toEqual(['approved', 'changes_requested'])
    expect(review.binding).toMatchObject({ pluginId, mode: 'review', draftId: expect.any(String) })
    // Staff don't review bindings.
    expect((await api.call<MwInboxItem[]>(staff, ch.INBOX_LIST)).some((i) => i.caseId === caseId)).toBe(false)
    expect(await api.call<any>(manager, ch.INBOX_SUBMIT, { stepRunId: review.stepRunId, outcome: 'approved' })).toEqual({ applied: true })
    const done = await until(`the binding of ${pluginId} done`, () => api.call<MwCase>(manager, ch.CASES_GET, caseId), (c) => c.status !== 'active', 180_000)
    expect(done).toMatchObject({ status: 'done', state: 'end' })
    return done
  }

  beforeAll(async () => {
    db = await createTestDatabase('mw_exit4', { migrate: false })
    const admin = new URL(db.url)
    admin.pathname = '/postgres'
    dir = mkdtempSync(join(tmpdir(), 'mw-exit4-'))

    // `memwise init` (empty): roles, the domain policy, the meta playbooks and domain/bindings/.
    project = join(dir, 'project')
    const files = await initProject(project, { template: 'empty' })
    expect(files).toEqual(expect.arrayContaining([
      'domain/roles.yaml', 'domain/policy.yaml', 'domain/bindings/.gitkeep', 'workflows/bind-plugin/workflow.yaml',
    ]))
    expect(readFileSync(join(project, 'domain/roles.yaml'), 'utf8')).toMatch(/staff:[\s\S]*manager:/)
    mkdirSync(join(project, 'domain', 'entities'), { recursive: true })
    writeFileSync(join(project, 'domain', 'entities', 'customer.yaml'), CUSTOMER_YAML)

    svc = (await startMemwiseService({
      configDir: dir,
      projectDir: project,
      databaseUrl: db.url,
      // The owner's desktop: it may install a plugin folder from anywhere on this machine.
      mode: 'desktop',
      modelResolver: phase4Models,
      logger: quiet,
      exampleRoots: [REPO],
      watch: false,
      throwOnError: true,
      owner: { name: 'Owner', email: 'owner@example.com' },
      // The plugins' example cases run in the `memwise test` CLI on throwaway databases of this cluster.
      testDatabaseUrl: admin.toString(),
    }))!
    expect(svc.seeded).toBe(false)
    registerMemwiseHandlers(api.server, { sessionManager: sessions.manager, platform: { logger: quiet } } as unknown as HandlerDeps)
    const priya = await svc.kernel.people.create({ name: 'Priya', email: 'priya@example.com', roles: ['staff'] })
    const ravi = await svc.kernel.people.create({ name: 'Ravi', email: 'ravi@example.com', roles: ['manager'] })
    staff = ctxFor('staff-client', priya.id)
    manager = ctxFor('manager-client', ravi.id)
  }, 180_000)

  afterAll(async () => {
    await svc?.stop()
    resetMemwiseHost()
    await db?.drop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }, 60_000)

  // ------------------------------------------------------------------ 1. a fresh domain, three plugins installed

  it('a fresh domain has its own Customer, the meta playbooks and no plugins', async () => {
    expect(svc.kernel.project && (await svc.kernel.project()).diagnostics.filter((x) => x.severity === 'error')).toEqual([])
    expect(await playbookIds()).toEqual(['bind-plugin', 'change-playbook', 'create-playbook'])
    expect(await api.call<MwPluginSummary[]>(manager, ch.PLUGINS_LIST)).toEqual([])
    const types = await api.call<{ name: string }[]>(staff, ch.ENTITIES_TYPES)
    expect(types.map((t) => t.name)).toEqual(['Customer'])
    expect((await api.call<{ id: string }[]>(staff, ch.ROLES_LIST)).map((r) => r.id).sort()).toEqual(['manager', 'staff'])
    // Nothing the plugins bring is bound.
    freshTools = await boundTools()
    expect(freshTools).not.toContain('gst.validate_gstin')
    expect(freshTools).not.toContain('email.send')
  }, 60_000)

  it('the three example plugins install from the app; nothing new is bound', async () => {
    // Only the owner's own connection may install, from the examples the Install dialog offers.
    const choices = await api.call<MwInstallChoices>(owner, ch.PLUGINS_EXAMPLES)
    expect(choices.canInstall).toBe(true)
    const dirOf = (slug: string) => choices.examples.find((x) => x.slug === slug)!.dir
    expect(choices.examples.map((x) => x.slug)).toEqual(expect.arrayContaining(['client-intake', 'sample-crm', 'sample-email']))
    expect((await api.call<MwInstallChoices>(manager, ch.PLUGINS_EXAMPLES)).canInstall).toBe(false)
    await expect(api.call(manager, ch.PLUGINS_INSTALL, { path: dirOf('sample-email') })).rejects.toThrow(/owner/)

    const email = await api.call<MwPluginSummary>(owner, ch.PLUGINS_INSTALL, { path: dirOf('sample-email') })
    expect(email).toMatchObject({ id: EMAIL, version: '1.0.0', trust: 'first-party', provides: ['email_send'], binding: { status: 'unbound' } })
    const intake = await api.call<MwPluginSummary>(owner, ch.PLUGINS_INSTALL, { path: dirOf('client-intake') })
    expect(intake).toMatchObject({ id: INTAKE, version: '1.0.0', requires: ['email_send'], workflows: ['client-intake'], binding: { status: 'unbound' } })

    // The sample CRM as someone would set it up: the example folder, its server started from a
    // contacts file (SAMPLE_CRM_SEED in the server's env in .mcp.json).
    const seed = join(dir, 'crm-contacts.json')
    writeFileSync(seed, JSON.stringify(CONTACTS, null, 2))
    const crmDir = join(dir, 'sample-crm')
    cpSync(dirOf('sample-crm'), crmDir, { recursive: true })
    const mcp = JSON.parse(readFileSync(join(crmDir, '.mcp.json'), 'utf8'))
    mcp.mcpServers.crm.env = { SAMPLE_CRM_SEED: seed }
    writeFileSync(join(crmDir, '.mcp.json'), JSON.stringify(mcp, null, 2))
    const crm = await api.call<MwPluginSummary>(owner, ch.PLUGINS_INSTALL, { path: crmDir })
    expect(crm).toMatchObject({ id: CRM, version: '1.0.0', trust: 'community', imported: 'claude-plugin', tools: 3, binding: { status: 'unbound' } })

    // Its tools were found on the MCP server; only the read-only hints gave classes.
    const detail = await api.call<MwPluginDetail>(manager, ch.PLUGINS_GET, CRM)
    const classes = Object.fromEntries(detail.toolList.map((t) => [t.name, t]))
    expect(Object.keys(classes).sort()).toEqual(['crm.create_contact', 'crm.get_contact', 'crm.list_contacts'])
    expect(classes['crm.list_contacts']).toMatchObject({ from: 'annotations' })
    expect(classes['crm.create_contact']).toMatchObject({ from: 'none' })
    expect(classes['crm.create_contact']!.effect).toBeUndefined()

    expect((await api.call<MwPluginSummary[]>(manager, ch.PLUGINS_LIST)).map((p) => [p.id, p.binding.status]))
      .toEqual([[CRM, 'unbound'], [INTAKE, 'unbound'], [EMAIL, 'unbound']])
    // Installed, not bound: no new playbook, no new tool.
    expect(await playbookIds()).toEqual(['bind-plugin', 'change-playbook', 'create-playbook'])
    expect(await boundTools()).toEqual(freshTools)
    for (const t of ['gst.validate_gstin', 'email.send', 'crm.list_contacts', 'crm.get_contact', 'crm.create_contact']) expect(freshTools).not.toContain(t)
  }, 120_000)

  // ------------------------------------------------------------------ 2. sample-email: all classified

  it('sample-email is bound: check, propose, dry run, review; the manager approves; it freezes', async () => {
    await expect(api.call(staff, ch.PLUGINS_BIND, EMAIL)).rejects.toThrow(/manager/)
    const { caseId } = await api.call<{ runId: string; caseId: string }>(manager, ch.PLUGINS_BIND, EMAIL)
    const atReview = await caseAt(manager, caseId, 'review')
    expect(atReview.state).toBe('review')
    expect(atReview.path).toEqual(['check', 'propose', 'dry_run', 'review'])
    expect(atReview.values.gaps?.value).toBe(0)
    expect((await plugin(EMAIL))!.binding).toMatchObject({ status: 'binding', caseId })

    const view = await api.call<MwBindingView>(manager, ch.BINDINGS_GET, { pluginId: EMAIL })
    expect(view).toMatchObject({ pluginId: EMAIL, editable: true, report: { outcome: 'passed' } })
    expect(view.binding.tools['email.send']).toMatchObject({ effect: 'outbound' })

    const done = await managerApprovesBinding(EMAIL, caseId)
    expect(done.path).toEqual(['check', 'propose', 'dry_run', 'review', 'freeze', 'link', 'end'])
    expect(done.values.binding_version?.value).toBe(1)
    expect((await plugin(EMAIL))!.binding).toMatchObject({ status: 'bound', version: 1, pluginVersion: '1.0.0', frozenByName: 'Ravi' })
    expect(await boundTools()).toContain('email.send')
  }, 300_000)

  // ------------------------------------------------------------------ 3. client-intake through the guided binding

  it('client-intake is bound: Client → Customer, tax_id → gstin, email_send → email.send; its example cases pass', async () => {
    const { caseId } = await api.call<{ runId: string; caseId: string }>(manager, ch.PLUGINS_BIND, INTAKE)
    const atReview = await caseAt(manager, caseId, 'review', 600_000)
    expect(atReview.state).toBe('review')
    expect(atReview.path).toEqual(['check', 'propose', 'dry_run', 'review'])

    const view = await api.call<MwBindingView>(manager, ch.BINDINGS_GET, { pluginId: INTAKE })
    expect(view.binding.entities).toEqual({ Client: { entity: 'Customer', fields: { name: 'name', email: 'email', tax_id: 'gstin', pan: 'pan' } } })
    expect(view.binding.capabilities).toEqual({ email_send: 'email.send' })
    expect(view.binding.roles).toEqual({ staff: 'staff', manager: 'manager' })
    expect(view.gaps).toEqual([])
    expect(view.report).toMatchObject({ outcome: 'passed', errors: 0 })
    // The plugin's example cases ran through the binding, out of process.
    expect(view.report!.examples.map((e) => [e.name, e.status]).sort()).toEqual([
      ['client-intake/clean-application', 'pass'], ['client-intake/full-intake', 'pass'],
      ['client-intake/onboard-creates-client', 'pass'], ['client-intake/pan-mismatch', 'pass'],
    ])
    // Not live yet.
    expect(await playbookIds()).not.toContain('client-intake')

    await managerApprovesBinding(INTAKE, caseId)
    expect((await plugin(INTAKE))!.binding).toMatchObject({ status: 'bound', version: 1 })
    expect(await boundTools()).toEqual(expect.arrayContaining(['gst.validate_gstin', 'intake.extract_fields']))
  }, 900_000)

  it('client-intake is a live playbook "from Client intake 1.0.0", in the domain\'s terms', async () => {
    const list = await until('client-intake listed', () => api.call<MwPlaybookSummary[]>(staff, ch.PLAYBOOKS_LIST), (l) => l.some((p) => p.id === 'client-intake'))
    const origin = { kind: 'plugin' as const, plugin: INTAKE, pluginTitle: 'Client intake', pluginVersion: '1.0.0', bindingVersion: 1 }
    expect(list.find((p) => p.id === 'client-intake')).toMatchObject({ title: 'Client intake', origin })
    const pb = await api.call<MwPlaybook>(staff, ch.PLAYBOOKS_GET, 'client-intake')
    expect(pb.origin).toEqual(origin)
    expect(`from ${pb.origin!.pluginTitle} ${pb.origin!.pluginVersion}`).toBe('from Client intake 1.0.0')
    expect(pb.diagnostics.filter((x) => x.severity === 'error')).toEqual([])
    // Resolved through the binding: the customer is a Customer, the onboard step creates one.
    expect(pb.caseFields.find((f) => f.name === 'customer')?.type).toBe('Ref<Customer>')
    expect(JSON.stringify(pb.steps.onboard)).toContain('domain.customer.create')
    expect(JSON.stringify(pb.steps.onboard)).not.toContain('domain.client.create')
    expect(pb.steps.verify).toMatchObject({ assignee: 'manager' })
  }, 60_000)

  let customerId = ''

  it('a case runs on it: staff fill the form, the agent checks, the manager approves, a Customer is written', async () => {
    const started = await api.call<MwCaseSummary>(staff, ch.CASES_START, { workflowId: 'client-intake', values: {} })
    expect(started).toMatchObject({ state: 'fill', workflowVersion: 1 })
    const form = await inboxItem(staff, 'input', (i) => i.caseId === started.caseId)
    const doc = (name: string, text: string) => api.call(staff, ch.FILES_UPLOAD, { name, mime: 'application/pdf', data: Buffer.from(text).toString('base64') })
    const documents = [await doc('pan-card.pdf', 'PAN AAACA1234A'), await doc('gst-certificate.pdf', `GSTIN ${GSTIN}`)]
    expect(await api.call<any>(staff, ch.INBOX_SUBMIT, {
      stepRunId: form.stepRunId, outcome: 'submitted',
      values: {
        client_name: 'Asha Rao', client_email: 'asha@acme-traders.example', pan: 'AAACA1234A', gstin: GSTIN,
        annual_turnover: { amount: 42000000, currency: 'INR' }, documents,
      },
    })).toEqual({ applied: true })

    const atVerify = await caseAt(manager, started.caseId, 'verify')
    expect(atVerify.state).toBe('verify')
    expect(atVerify.values.gstin_ok?.value).toBe(true)
    // The plugin's tools ran through the binding (builtin routes): the registry and the documents.
    const check = await api.call<MwStepRecord>(manager, ch.STEPS_GET, atVerify.timeline.find((t) => t.stepId === 'check')!.stepRunId)
    const calls = check.journal.filter((j) => j.kind === 'tool').map((j) => [j.name, j.error ?? 'ok'])
    expect(calls).toEqual([['gst.validate_gstin', 'ok'], ['intake.extract_fields', 'ok']])
    expect(atVerify.values.legal_name?.value).toBe('Acme Traders Private Limited')
    const verify = await inboxItem(manager, 'decision', (i) => i.caseId === started.caseId)
    expect(verify.binding).toBeUndefined()
    expect(await api.call<any>(manager, ch.INBOX_SUBMIT, { stepRunId: verify.stepRunId, outcome: 'approved' })).toEqual({ applied: true })

    const done = await until('the intake case done', () => api.call<MwCase>(manager, ch.CASES_GET, started.caseId), (c) => c.status !== 'active', 120_000)
    expect(done).toMatchObject({ status: 'done', state: 'end' })
    const customers = await api.call<MwEntityRow[]>(manager, ch.ENTITIES_LIST, 'Customer')
    expect(customers).toHaveLength(1)
    expect(customers[0]!.values).toMatchObject({ name: { value: 'Asha Rao' }, email: { value: 'asha@acme-traders.example' }, gstin: { value: GSTIN }, pan: { value: 'AAACA1234A' } })
    customerId = customers[0]!.id
    expect(done.values.customer?.value).toBe(customerId)
  }, 240_000)

  // ------------------------------------------------------------------ 4. sample-crm: a Claude plugin over MCP

  let menonId = ''

  it('sample-crm is bound: the binder classifies its tools; the dry run maps the sample contacts', async () => {
    // Another customer already in the domain, whose name the CRM has slightly differently.
    const customer = (await svc.kernel.project()).project.entities.Customer!
    menonId = await new PgEntityStore().create(svc.kernel.pool, customer, { name: MENON })
    const similarity = nameSimilarity(MENON, 'Menon Exports')
    expect(similarity).toBeGreaterThanOrEqual(0.75)
    expect(similarity).toBeLessThan(0.95)
    for (const name of ['Asha Rao', MENON]) expect(nameSimilarity(name, 'Brightline Software')).toBeLessThan(0.75)

    const { caseId } = await api.call<{ runId: string; caseId: string }>(manager, ch.PLUGINS_BIND, CRM)
    const atReview = await caseAt(manager, caseId, 'review')
    expect(atReview.state).toBe('review')
    // Unclassified after propose, so the binder agent classified them first.
    expect(atReview.path).toEqual(['check', 'propose', 'classify', 'dry_run', 'review'])
    expect(String(atReview.values.unclassified?.value)).toContain('crm.create_contact')
    const classify = atReview.timeline.find((t) => t.stepId === 'classify')!
    expect(classify).toMatchObject({ outcome: 'proposed' })

    const view = await api.call<MwBindingView>(manager, ch.BINDINGS_GET, { pluginId: CRM })
    expect(view.binding.tools).toMatchObject({
      'crm.list_contacts': { effect: 'read' },
      'crm.get_contact': { effect: 'read' },
      'crm.create_contact': { effect: 'write', reason: 'It adds a contact to the CRM, which can be removed there.' },
    })
    expect(view.tools.find((t) => t.name === 'crm.create_contact')).toMatchObject({ effect: 'write' })
    expect(view.binding.records.contact).toMatchObject({
      entity: 'Customer',
      fields: {
        name: { from: 'company_name' },
        email: { from: 'email', transform: ['trim', 'lower'] },
        gstin: { from: 'gst_number', transform: ['trim', 'upper'] },
      },
      identity: { keys: ['gstin', 'email'], fuzzy: { field: 'name', auto: 0.95, review: 0.75 } },
    })

    // The sample contacts, before and after the mapping.
    const report = view.report!
    expect(report.outcome).toBe('passed')
    expect(report.records.map((r) => r.externalId)).toEqual(['c-201', 'c-202', 'c-203'])
    const acme = report.records[0]!
    expect(acme.raw).toMatchObject({ company_name: 'Acme Traders Private Limited', gst_number: ` ${GSTIN.toLowerCase()} ` })
    expect(acme.values).toEqual({ name: 'Acme Traders Private Limited', email: 'accounts@acme-traders.example', gstin: GSTIN })
    expect(acme.extra).toEqual({ 'crm.phone': '+91 80 4000 1010' })
    expect(report.records.every((r) => r.errors.length === 0)).toBe(true)
    expect(report.records[1]!.values).toEqual({ name: 'Menon Exports', email: 'ravi@menon-exports.example' })

    const done = await managerApprovesBinding(CRM, caseId)
    expect(done.path).toEqual(['check', 'propose', 'classify', 'dry_run', 'review', 'freeze', 'link', 'end'])
    expect([done.values.linked?.value, done.values.candidates?.value]).toEqual([1, 1])
    expect((await plugin(CRM))!.binding).toMatchObject({ status: 'bound', version: 1 })
  }, 300_000)

  it('link: the same GSTIN linked by key, the near name waits in the manager\'s inbox and is confirmed', async () => {
    // The GSTIN contact linked by itself.
    const rows = await api.call<MwEntityRow[]>(manager, ch.ENTITIES_LIST, 'Customer')
    expect(rows.find((r) => r.id === customerId)?.links).toEqual([expect.objectContaining({ plugin: CRM, source: 'contact', method: 'key' })])

    // The near name is an identity match for the bind-plugin owner role (manager), not for staff.
    const item = await inboxItem(manager, 'identity', (i) => i.recordId === menonId)
    expect(item).toMatchObject({ plugin: CRM, source: 'contact', externalId: 'c-202', entity: 'Customer' })
    expect(item.score).toBeGreaterThanOrEqual(0.75)
    expect(item.score).toBeLessThan(0.95)
    expect((await api.call<MwInboxItem[]>(staff, ch.INBOX_LIST)).some((i) => i.kind === 'identity')).toBe(false)
    const pending = await api.call<MwIdentityCandidate[]>(manager, ch.IDENTITY_LIST, { status: 'pending' })
    expect(pending.map((c) => [c.externalId, c.recordId])).toEqual([['c-202', menonId]])
    expect(pending[0]!.recordTitle).toBe(MENON)

    expect(await api.call<any>(staff, ch.IDENTITY_DECIDE, { candidateId: item.candidateId, decision: 'confirm' })).toMatchObject({ applied: false })
    expect(await api.call<any>(manager, ch.IDENTITY_DECIDE, { candidateId: item.candidateId, decision: 'confirm' })).toEqual({ applied: true })
    expect(await api.call<any>(manager, ch.IDENTITY_DECIDE, { candidateId: item.candidateId, decision: 'reject' })).toMatchObject({ applied: false, code: 'identity.decided' })
    expect((await api.call<MwInboxItem[]>(manager, ch.INBOX_LIST)).some((i) => i.kind === 'identity')).toBe(false)
    expect(await api.call<MwIdentityCandidate[]>(manager, ch.IDENTITY_LIST, { status: 'confirmed' }))
      .toEqual([expect.objectContaining({ externalId: 'c-202', recordId: menonId, decidedByName: 'Ravi' })])

    const menon = await api.call<MwEntityRecord>(manager, ch.ENTITIES_RECORD, { entity: 'Customer', id: menonId })
    expect(menon.links).toEqual([expect.objectContaining({ externalId: 'c-202', method: 'person', linkedByName: 'Ravi' })])
    expect(menon.readThrough.email).toMatchObject({ plugin: CRM, value: 'ravi@menon-exports.example' })

    // The unrelated contact stays unlinked, and nothing was created for it.
    const after = await api.call<MwEntityRow[]>(manager, ch.ENTITIES_LIST, 'Customer')
    expect(after).toHaveLength(2)
    const linked = (await Promise.all(after.map((r) => api.call<MwEntityRecord>(manager, ch.ENTITIES_RECORD, { entity: 'Customer', id: r.id }))))
      .flatMap((r) => r.links.map((l) => l.externalId)).sort()
    expect(linked).toEqual(['c-201', 'c-202'])
    // Resolving again is idempotent: two linked, the unrelated one unmatched.
    expect(await svc.kernel.identity.resolve({ plugin: CRM })).toEqual({ linked: 2, candidates: 0, unmatched: 1, created: 0 })
  }, 120_000)

  it('the intake customer\'s record shows the link and its CRM email, read through the link', async () => {
    const rec = await api.call<MwEntityRecord>(staff, ch.ENTITIES_RECORD, { entity: 'Customer', id: customerId })
    expect(rec).toMatchObject({ entity: 'Customer', id: customerId, title: 'Asha Rao' })
    // The domain's own value stays; the CRM owns email, so the record shows the CRM's.
    expect(rec.values.email?.value).toBe('asha@acme-traders.example')
    expect(rec.links).toHaveLength(1)
    expect(rec.links[0]).toMatchObject({
      plugin: CRM, pluginTitle: 'sample-crm', source: 'contact', externalId: 'c-201', method: 'key', reasons: ['same GSTIN'],
      values: { name: 'Acme Traders Private Limited', email: 'accounts@acme-traders.example', gstin: GSTIN },
    })
    expect(rec.links[0]!.error).toBeUndefined()
    expect(rec.readThrough).toEqual({ email: { plugin: CRM, pluginTitle: 'sample-crm', value: 'accounts@acme-traders.example' } })
  }, 60_000)
})
