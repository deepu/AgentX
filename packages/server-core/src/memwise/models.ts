/**
 * Model roles for the kernel (19 §9): checker, verifier, extractor and explainer resolve to the
 * default LLM connection when pi-ai can call it with an API key, on the provider's mid-tier model
 * (the newest Claude Sonnet) unless `MEMWISE_PLAYBOOK_MODEL` names one. Otherwise a stand-in provider
 * answers every call with "No model connected", so agent steps stop and need a person.
 * `MEMWISE_SCRIPTED_MODELS=1` plays the example cases' scripted turns instead (demos, exit test).
 * API keys are passed to the provider and never logged.
 */
import type { ExampleCase, ProjectDefs, ScriptedTurn } from '@memwise/defs'
import type { ModelProvider, ModelRoleConfig } from '@memwise/gateway'

export const MODEL_ROLES = ['checker', 'verifier', 'extractor', 'explainer'] as const

export const NO_MODEL_MESSAGE = 'No model connected. Connect a model in Settings to let agent steps run; until then they wait for a person.'

export interface ResolvedModels {
  modelRoles: Record<string, ModelRoleConfig>
  providers: ModelProvider[]
  configured: boolean
  /** Plain words: which model is used, or why none. */
  message: string
  /** Scripted mode: the example whose tool stubs go with the scripts. */
  example?: ExampleCase
}

export interface ModelResolverInput {
  /** Every model role the project uses (from steps and the domain policy), beyond MODEL_ROLES. */
  roles: string[]
  project?: ProjectDefs
}

export type ModelResolver = (input: ModelResolverInput) => Promise<ResolvedModels>

/** Roles a project uses: the standard ones plus every step's own role. */
export function projectModelRoles(project?: ProjectDefs): string[] {
  const roles = new Set<string>(MODEL_ROLES)
  for (const wf of Object.values(project?.workflows ?? {})) {
    for (const step of Object.values(wf.steps)) if (step.model) roles.add(step.model)
  }
  for (const r of project?.domainPolicy?.modelRoles ?? []) roles.add(r)
  for (const r of project?.workspace?.policy?.modelRoles ?? []) roles.add(r)
  for (const d of Object.values(project?.domains ?? {})) for (const r of d.policy?.modelRoles ?? []) roles.add(r)
  return [...roles]
}

/** A provider for when nothing is connected: every call fails with a message a person can act on. */
export function noModelProvider(): ModelProvider {
  return {
    id: 'none',
    async complete() {
      throw new Error(NO_MODEL_MESSAGE)
    },
  }
}

function allRoles(roles: string[], provider: string, model: string): Record<string, ModelRoleConfig> {
  return Object.fromEntries(roles.map((r) => [r, { provider, model }]))
}

export function unconfiguredModels(roles: string[], message = NO_MODEL_MESSAGE): ResolvedModels {
  return { modelRoles: allRoles(roles, 'none', 'none'), providers: [noModelProvider()], configured: false, message }
}

/**
 * Scripted turns from the project's example cases. One example's script drives every step run
 * (the scripted provider picks the reply by conversation turn); roles it has no script for are
 * taken from the other examples. `MEMWISE_SCRIPTED_EXAMPLE` names the example; default the
 * first whose check passes cleanly.
 */
export async function scriptedModels(input: ModelResolverInput, exampleName = process.env.MEMWISE_SCRIPTED_EXAMPLE): Promise<ResolvedModels> {
  const { scriptedProvider } = await import('@memwise/gateway')
  const examples = Object.values(input.project?.workflows ?? {}).flatMap((wf) => wf.examples).filter((e) => e.model)
  const chosen = (exampleName ? examples.find((e) => e.name === exampleName) : undefined)
    ?? examples.find((e) => e.expect.outcome === 'checked')
    ?? examples[0]
  const script: Record<string, ScriptedTurn[]> = { ...(chosen?.model ?? {}) }
  for (const e of examples) {
    for (const [role, turns] of Object.entries(e.model ?? {})) script[role] ??= turns
  }
  return {
    modelRoles: allRoles([...new Set([...input.roles, ...Object.keys(script)])], 'scripted', 'scripted'),
    providers: [scriptedProvider(script)],
    configured: true,
    message: chosen ? `Using the scripted answers from the example "${chosen.name}".` : 'Using scripted answers (no example has any).',
    example: chosen,
  }
}

/** What the app's LLM connection settings say, kept to the fields we need. */
export interface ConnectionInfo {
  slug: string
  name: string
  providerType: string
  authType: string
  piAuthProvider?: string
  baseUrl?: string
  defaultModel?: string
  apiKey: string | null
}

/** pi-ai provider ids we can call with a plain API key, from an app connection. */
export function piAiProviderIdFor(conn: Pick<ConnectionInfo, 'providerType' | 'authType' | 'piAuthProvider'>): 'anthropic' | 'openai' | undefined {
  if (conn.authType !== 'api_key' && conn.authType !== 'api_key_with_endpoint') return undefined
  if (conn.providerType === 'anthropic') return 'anthropic'
  if (conn.providerType === 'pi' && (conn.piAuthProvider === 'anthropic' || conn.piAuthProvider === 'openai')) return conn.piAuthProvider
  return undefined
}

/**
 * OpenAI models in order of preference, when the connection's own model isn't in pi-ai's catalog.
 * Anthropic connections don't use a list: they take the newest Sonnet the catalog has (MID_TIER).
 */
const PREFERRED: Record<string, string[]> = {
  openai: ['gpt-5', 'gpt-4.1', 'gpt-4o'],
}

/**
 * The provider's mid-tier family, newest first: playbook steps make many model calls, so they run
 * on it rather than on the connection's (often top-tier) chat model. `claude-sonnet-5-5`, with a
 * dated snapshot (`-20250929`) only when the catalog has no alias of that version.
 */
const MID_TIER: Record<string, RegExp> = {
  anthropic: /^claude-sonnet-(\d+)(?:-(\d{1,2}))?(?:-(\d{8}))?$/,
}

/** The newest model of the provider's mid-tier family in `ids`, else undefined. */
export function newestMidTier(id: string, ids: string[]): string | undefined {
  const re = MID_TIER[id]
  if (!re) return undefined
  const ranked = ids.flatMap((m) => {
    const hit = re.exec(m)
    return hit ? [{ m, major: Number(hit[1]), minor: Number(hit[2] ?? 0), dated: !!hit[3] }] : []
  })
  ranked.sort((a, b) => b.major - a.major || b.minor - a.minor || Number(a.dated) - Number(b.dated))
  return ranked[0]?.m
}

const bareModel = (m: string | undefined) => m?.trim().replace(/^pi\//, '').replace(/^(anthropic|openai)\//, '') || undefined

/**
 * The model playbook steps use, from pi-ai's catalog `ids`: the model `MEMWISE_PLAYBOOK_MODEL`
 * names (when the catalog has it); else, for Anthropic, the newest Sonnet; else the connection's
 * own model; else the first preferred one. OpenAI keeps the connection's model before its list.
 */
export function pickPlaybookModel(id: 'anthropic' | 'openai', ids: string[], wanted?: string, override = process.env.MEMWISE_PLAYBOOK_MODEL): string | undefined {
  const named = bareModel(override)
  if (named && ids.includes(named)) return named
  const mid = newestMidTier(id, ids)
  if (mid) return mid
  const own = bareModel(wanted)
  if (own && ids.includes(own)) return own
  for (const p of PREFERRED[id] ?? []) {
    const hit = ids.find((m) => m === p || m.startsWith(`${p}-`))
    if (hit) return hit
  }
  return ids[0]
}

/** The model playbook steps use, from pi-ai's catalog for the provider (pickPlaybookModel). */
async function catalogModel(id: 'anthropic' | 'openai', wanted?: string): Promise<string | undefined> {
  const mod = id === 'anthropic'
    ? await import('@earendil-works/pi-ai/providers/anthropic').then((m) => m.anthropicProvider())
    : await import('@earendil-works/pi-ai/providers/openai').then((m) => m.openaiProvider())
  const ids = mod.getModels().map((m: { id: string }) => m.id)
  return pickPlaybookModel(id, ids, wanted)
}

/** Model roles from an app connection; unconfigured when pi-ai can't call it. */
export async function connectionModels(input: ModelResolverInput, conn: ConnectionInfo | null): Promise<ResolvedModels> {
  if (!conn) return unconfiguredModels(input.roles)
  const id = piAiProviderIdFor(conn)
  if (!id) {
    return unconfiguredModels(input.roles, `The default model connection "${conn.name}" can't run playbook steps yet (it needs an Anthropic or OpenAI API key). Add a connection with an API key in Settings → AI; it doesn't have to be the default. Agent steps wait for a person.`)
  }
  if (!conn.apiKey) return unconfiguredModels(input.roles, `The default model connection "${conn.name}" has no API key saved.`)
  const model = await catalogModel(id, conn.defaultModel)
  if (!model) return unconfiguredModels(input.roles)
  const { piAiProvider } = await import('@memwise/gateway')
  return {
    modelRoles: allRoles(input.roles, id, model),
    providers: [piAiProvider({ id, apiKey: conn.apiKey, ...(conn.baseUrl && conn.authType === 'api_key_with_endpoint' ? { baseUrl: conn.baseUrl } : {}) })],
    configured: true,
    message: `Agent steps use ${model} through "${conn.name}".`,
  }
}

/** A connection with its saved key. */
async function withKey(conn: { slug: string; name: string; providerType: string; authType: string; piAuthProvider?: string; baseUrl?: string; defaultModel?: string }): Promise<ConnectionInfo> {
  let apiKey: string | null = null
  try {
    const { getCredentialManager } = await import('@memwise/shared/credentials')
    apiKey = await getCredentialManager().getLlmApiKey(conn.slug)
  } catch {
    apiKey = null
  }
  return {
    slug: conn.slug, name: conn.name, providerType: conn.providerType, authType: conn.authType,
    piAuthProvider: conn.piAuthProvider, baseUrl: conn.baseUrl, defaultModel: conn.defaultModel, apiKey,
  }
}

/**
 * The connection playbook steps use: the app's default when it has an API key we can call, else the
 * first other connection that does (a Claude subscription can stay the default for chat).
 */
export function pickPlaybookConnection(defaultConn: ConnectionInfo | null, others: ConnectionInfo[]): ConnectionInfo | null {
  const usable = (c: ConnectionInfo | null) => !!c && !!piAiProviderIdFor(c) && !!c.apiKey
  if (usable(defaultConn)) return defaultConn
  return others.find((c) => c.slug !== defaultConn?.slug && usable(c)) ?? defaultConn
}

/** Reads the connection playbook steps use, with its key. */
export async function readDefaultConnection(): Promise<ConnectionInfo | null> {
  const { getDefaultLlmConnection, getLlmConnection, getLlmConnections } = await import('@memwise/shared/config')
  const slug = getDefaultLlmConnection()
  const def = slug ? getLlmConnection(slug) : null
  const defaultConn = def ? await withKey(def) : null
  if (defaultConn && piAiProviderIdFor(defaultConn) && defaultConn.apiKey) return defaultConn
  const others = await Promise.all(getLlmConnections().filter((c) => c.slug !== slug && piAiProviderIdFor(c)).map(withKey))
  return pickPlaybookConnection(defaultConn, others)
}

/** The default resolver: scripted when asked for, else the default LLM connection. */
export const defaultModelResolver: ModelResolver = async (input) => {
  if (process.env.MEMWISE_SCRIPTED_MODELS === '1' || process.env.MEMWISE_SCRIPTED_MODELS === 'true') return scriptedModels(input)
  try {
    return await connectionModels(input, await readDefaultConnection())
  } catch {
    return unconfiguredModels(input.roles)
  }
}
