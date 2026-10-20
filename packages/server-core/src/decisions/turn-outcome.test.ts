import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DecisionRecorder,
  SystemOneClient,
  normalizeDecisionLayerSettings,
  resolveDecisionEndpoint,
  type DecisionClientResolution,
  type DecisionResult,
} from '@memwise/shared/decisions'
import {
  buildTurnOutcomeRequest,
  classifyTurnOutcome,
  readTurnOutcome,
  TURN_OUTCOME_MAX_REPLY_CHARS,
  TURN_OUTCOME_MAX_REQUEST_CHARS,
} from './turn-outcome'

function outcomeResult(choice: string, confidence: number, probability: number): DecisionResult {
  return {
    model: 'jev',
    requestedModel: 'jev',
    modelReported: true,
    answers: { outcome: { type: 'choice', choice, confidence, probabilities: { [choice]: probability } } },
    usage: { inputTokens: 1, outputTokens: 1 },
    latencyMs: 1,
    state: { sha256: 'x', bytes: 1, truncated: false },
  } as unknown as DecisionResult
}

function resolutionAnswering(body: unknown): DecisionClientResolution {
  const settings = normalizeDecisionLayerSettings({ enabled: true, provider: 'openrouter', features: { turnOutcome: true } })
  const endpoint = resolveDecisionEndpoint(settings)
  const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
  const client = new SystemOneClient({ baseUrl: endpoint.baseUrl, apiKey: 'k', model: endpoint.model, fetch: fetchImpl })
  return { ok: true, value: { client, settings, provider: 'openrouter', endpoint, keySource: 'provider' } }
}

describe('buildTurnOutcomeRequest', () => {
  it('keeps the end of a long reply and the start of the request', () => {
    const reply = `${'x'.repeat(10_000)} Which environment should I deploy to?`
    const request = `Deploy the app. ${'y'.repeat(5_000)}`
    const state = buildTurnOutcomeRequest({ request, reply }).state as Record<string, string>
    expect(state.assistant_final_message!.endsWith('Which environment should I deploy to?')).toBe(true)
    expect(state.assistant_final_message!.length).toBe(TURN_OUTCOME_MAX_REPLY_CHARS + 1)
    expect(state.user_request!.startsWith('Deploy the app.')).toBe(true)
    expect(state.user_request!.length).toBe(TURN_OUTCOME_MAX_REQUEST_CHARS)
  })

  it('asks one choice question with an option per outcome', () => {
    const question = buildTurnOutcomeRequest({ reply: 'Done.' }).questions.outcome!
    expect(question.type).toBe('choice')
    expect(Object.keys((question as { criteria: Record<string, string> }).criteria)).toEqual(['finished', 'needs_input', 'blocked'])
  })
})

describe('readTurnOutcome', () => {
  it('accepts only a confident, probable outcome', () => {
    expect(readTurnOutcome(outcomeResult('needs_input', 0.9, 0.9))).toEqual({ outcome: 'needs_input', confidence: 0.9 })
    expect(readTurnOutcome(outcomeResult('needs_input', 0.5, 0.9))).toBeNull()
    expect(readTurnOutcome(outcomeResult('needs_input', 0.9, 0.4))).toBeNull()
    expect(readTurnOutcome(outcomeResult('something_else', 0.99, 0.99))).toBeNull()
    expect(readTurnOutcome(null)).toBeNull()
  })
})

describe('classifyTurnOutcome', () => {
  it('is null when the feature is off, and never asks for an empty reply', async () => {
    let asked = 0
    const resolveClient = async () => {
      asked++
      return { ok: false as const, failure: { kind: 'disabled' as const, message: 'off' } }
    }
    expect(await classifyTurnOutcome({ reply: 'Which one?' }, { resolveClient })).toBeNull()
    expect(await classifyTurnOutcome({ reply: '   ' }, { resolveClient })).toBeNull()
    expect(asked).toBe(1)
  })

  it('classifies and records the call with the turn_outcome tag', async () => {
    const recorder = new DecisionRecorder({ path: join(mkdtempSync(join(tmpdir(), 'turn-outcome-')), 'decisions.jsonl') })
    const body = {
      model: 'jev-1.13.0',
      answers: { outcome: { type: 'choice', choice: 'blocked', confidence: 0.92, probabilities: { finished: 0.02, needs_input: 0.03, blocked: 0.95 } } },
      usage: { input_tokens: 40, output_tokens: 1 },
    }
    const result = await classifyTurnOutcome(
      { request: 'Push the release', reply: 'I cannot push: the token lacks write access.' },
      { resolveClient: async () => resolutionAnswering(body), recorder, sessionId: 's1' },
    )
    expect(result).toEqual({ outcome: 'blocked', confidence: 0.92 })

    await recorder.append({ t: 'x', feature: 'settings_test', provider: 'typesafe', model: 'm', ok: true, questions: {}, state: null })
    const record = JSON.parse(readFileSync(recorder.path, 'utf8').trim().split('\n')[0]!)
    expect(record.feature).toBe('turn_outcome')
    expect(record.sessionId).toBe('s1')
    expect(JSON.stringify(record)).not.toContain('token lacks write access')
  })
})
