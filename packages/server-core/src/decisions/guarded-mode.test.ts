import { describe, expect, it } from 'bun:test'
import {
  SystemOneClient,
  normalizeDecisionLayerSettings,
  resolveDecisionEndpoint,
  type DecisionClientResolution,
  type DecisionResult,
} from '@memwise/shared/decisions'
import type { GuardedModeCall } from '@memwise/shared/agent'
import { buildGuardedModeCheck, buildGuardedModeRequest, GUARDED_MODE_MAX_ARGUMENTS_CHARS, readGuardedModeVerdict } from './guarded-mode'

const bashCall: GuardedModeCall = { toolName: 'Bash', promptType: 'bash', description: 'Execute: rm -rf ~/old', command: 'rm -rf ~/old', workingDirectory: '/repo' }

function nouls(values: Record<string, number>): DecisionResult {
  const answers: DecisionResult['answers'] = {}
  for (const [key, noul] of Object.entries(values)) answers[key] = { type: 'noul', noul }
  return { model: 'jev', requestedModel: 'jev', modelReported: true, answers, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 } as unknown as DecisionResult
}

function resolutionAnswering(answers: Record<string, number>, options: { honourAbort?: boolean } = {}): DecisionClientResolution {
  const settings = normalizeDecisionLayerSettings({ enabled: true, provider: 'openrouter', features: { guardedMode: true } })
  const endpoint = resolveDecisionEndpoint(settings)
  const body = {
    model: 'jev-1.13.0',
    answers: Object.fromEntries(Object.entries(answers).map(([key, noul]) => [key, { type: 'noul', noul }])),
    usage: { input_tokens: 20, output_tokens: 3 },
  }
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    if (options.honourAbort && init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    return new Response(JSON.stringify(body), { status: 200 })
  }) as unknown as typeof fetch
  const client = new SystemOneClient({ baseUrl: endpoint.baseUrl, apiKey: 'k', model: endpoint.model, fetch: fetchImpl })
  return { ok: true, value: { client, settings, provider: 'openrouter', endpoint, keySource: 'provider' } }
}

describe('buildGuardedModeRequest', () => {
  it('sends the command for Bash and truncated arguments for tools', () => {
    expect(buildGuardedModeRequest(bashCall).state).toEqual({ tool: 'Bash', command: 'rm -rf ~/old', project_directory: '/repo' })

    const long = { body: 'x'.repeat(10_000) }
    const state = buildGuardedModeRequest({ toolName: 'mcp__gmail__send', promptType: 'mcp_mutation', description: 'd', command: 'mcp__gmail__send', arguments: long }).state as Record<string, string>
    expect(state.command).toBeUndefined()
    expect(state.arguments!.length).toBe(GUARDED_MODE_MAX_ARGUMENTS_CHARS + 1)
  })

  it('asks three yes/no questions', () => {
    expect(Object.keys(buildGuardedModeRequest(bashCall).questions)).toEqual(['irreversible', 'outside_workspace', 'external'])
  })
})

describe('readGuardedModeVerdict', () => {
  it('reports only risks at or above the threshold', () => {
    expect(readGuardedModeVerdict(nouls({ irreversible: 0.95, outside_workspace: 0.5, external: 0.79 }))).toEqual({ risks: ['irreversible'] })
    expect(readGuardedModeVerdict(nouls({ irreversible: 0.1, outside_workspace: 0.1, external: 0.1 }))).toEqual({ risks: [] })
    expect(readGuardedModeVerdict(null)).toBeNull()
  })
})

describe('buildGuardedModeCheck', () => {
  it('is inactive for sessions nobody is watching, whatever the toggle says', () => {
    const guard = buildGuardedModeCheck({ sessionId: 's', isInteractive: () => false, resolveClient: async () => resolutionAnswering({ irreversible: 0.99 }) })
    expect(guard.isActive()).toBe(false)
  })

  it('is null when the feature is off and returns the flagged risks when on', async () => {
    const off = buildGuardedModeCheck({ sessionId: 's', isInteractive: () => true, resolveClient: async () => ({ ok: false, failure: { kind: 'disabled', message: 'off' } }) })
    expect(await off.check(bashCall)).toBeNull()

    const on = buildGuardedModeCheck({
      sessionId: 's',
      isInteractive: () => true,
      resolveClient: async () => resolutionAnswering({ irreversible: 0.97, outside_workspace: 0.9, external: 0.02 }),
    })
    expect(await on.check(bashCall)).toEqual({ risks: ['irreversible', 'outside_workspace'] })
  })

  it('gives up when the turn stops', async () => {
    const guard = buildGuardedModeCheck({
      sessionId: 's',
      isInteractive: () => true,
      resolveClient: async () => resolutionAnswering({ irreversible: 0.99, outside_workspace: 0, external: 0 }, { honourAbort: true }),
    })
    const stopped = new AbortController()
    stopped.abort()
    expect(await guard.check(bashCall, stopped.signal)).toBeNull()
  })
})
