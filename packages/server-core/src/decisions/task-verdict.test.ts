import { describe, it, expect } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DecisionRecorder,
  SystemOneClient,
  normalizeDecisionLayerSettings,
  resolveDecisionEndpoint,
  type DecisionClientResolution,
} from '@memwise/shared/decisions'
import { buildTaskVerdictDecider } from './task-verdict'
import { buildVerdictDecisionRequest } from '../tasks/verdict-decision'

function resolutionWith(fetchImpl: typeof fetch): DecisionClientResolution {
  const settings = normalizeDecisionLayerSettings({ enabled: true, provider: 'openrouter', deadlineMs: 2_500 })
  const endpoint = resolveDecisionEndpoint(settings)
  const client = new SystemOneClient({ baseUrl: endpoint.baseUrl, apiKey: 'k', model: endpoint.model, fetch: fetchImpl })
  return { ok: true, value: { client, settings, provider: 'openrouter', endpoint, keySource: 'provider' } }
}

describe('task verdict decider', () => {
  it('returns null when the layer is unavailable', async () => {
    const decide = buildTaskVerdictDecider({ resolveClient: async () => ({ ok: false, failure: { kind: 'disabled', message: 'off' } }) })
    expect(await decide(buildVerdictDecisionRequest('text', ['a']), { slug: 't', runId: 'r' })).toBeNull()
    const throwing = buildTaskVerdictDecider({ resolveClient: async () => { throw new Error('vault') } })
    expect(await throwing(buildVerdictDecisionRequest('text', ['a']), { slug: 't', runId: 'r' })).toBeNull()
  })

  it('runs the request under the configured background deadline and records it with the run context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memwise-verdict-'))
    const recorder = new DecisionRecorder({ path: join(dir, 'decisions.jsonl') })
    let sentBody: { model: string; questions: Record<string, unknown> } | undefined
    let sawSignal = false
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body))
      sawSignal = init?.signal instanceof AbortSignal
      return new Response(JSON.stringify({
        model: 'jev-1.13.0',
        answers: { verdict: { type: 'choice', choice: 'pass', confidence: 0.95, probabilities: { pass: 0.97, fail: 0.02, unclear: 0.01 } } },
        usage: { input_tokens: 20, output_tokens: 2 },
      }), { status: 200 })
    }) as unknown as typeof fetch

    const decide = buildTaskVerdictDecider({ resolveClient: async () => resolutionWith(fetchImpl), recorder })
    const result = await decide(buildVerdictDecisionRequest('All good.', ['a']), { slug: 'weekly', runId: 'r7' })
    expect(result?.answers.verdict).toMatchObject({ type: 'choice', choice: 'pass' })
    expect(sentBody?.model).toBe('typesafe/jev-1.13')
    expect(sawSignal).toBe(true)

    await recorder.append({ t: 'x', feature: 'settings_test', provider: 'typesafe', model: 'm', ok: true, questions: {}, state: null })
    const record = JSON.parse(readFileSync(recorder.path, 'utf8').trim().split('\n')[0]!)
    expect(record.feature).toBe('task_verdict')
    expect(record.meta).toEqual({ slug: 'weekly', runId: 'r7', questions: 1 })
    expect(record.answers.verdict.choice).toBe('pass')
  })

  it('returns null and records the failure when the provider errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memwise-verdict-'))
    const recorder = new DecisionRecorder({ path: join(dir, 'decisions.jsonl') })
    const fetchImpl = (async () => new Response('{"error":"nope"}', { status: 529 })) as unknown as typeof fetch
    const decide = buildTaskVerdictDecider({ resolveClient: async () => resolutionWith(fetchImpl), recorder })
    expect(await decide(buildVerdictDecisionRequest('text', ['a']), { slug: 't', runId: 'r' })).toBeNull()
    await recorder.append({ t: 'x', feature: 'settings_test', provider: 'typesafe', model: 'm', ok: true, questions: {}, state: null })
    const record = JSON.parse(readFileSync(recorder.path, 'utf8').trim().split('\n')[0]!)
    expect(record.ok).toBe(false)
    expect(record.error.kind).toBe('unavailable')
  })
})
