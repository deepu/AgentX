import { describe, expect, it } from 'bun:test'
import {
  SystemOneClient,
  normalizeDecisionLayerSettings,
  resolveDecisionEndpoint,
  type DecisionClientResolution,
} from '@memwise/shared/decisions'
import { buildMidTurnRequest, decideMidTurnDelivery, isContinuation, MID_TURN_MAX_CHARS } from './mid-turn-messages'

function answering(answers: Record<string, unknown>): () => Promise<DecisionClientResolution> {
  return async () => {
    const settings = normalizeDecisionLayerSettings({ enabled: true, provider: 'openrouter', features: { midTurnMessages: true } })
    const endpoint = resolveDecisionEndpoint(settings)
    const fetchImpl = (async () => new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 })) as unknown as typeof fetch
    const client = new SystemOneClient({ baseUrl: endpoint.baseUrl, apiKey: 'k', model: endpoint.model, fetch: fetchImpl })
    return { ok: true, value: { client, settings, provider: 'openrouter', endpoint, keySource: 'provider' } }
  }
}
const delivery = (choice: string, confidence: number) => answering({ delivery: { type: 'choice', choice, confidence, probabilities: { steer: confidence, queue: 1 - confidence } } })
const off = async () => ({ ok: false as const, failure: { kind: 'disabled' as const, message: 'off' } })

describe('decideMidTurnDelivery', () => {
  it('sends the running request and the new message, clipped', () => {
    const state = buildMidTurnRequest({ runningRequest: 'x'.repeat(5_000), newMessage: 'use tabs' }).state as Record<string, string>
    expect(state.request_being_worked_on!.length).toBe(MID_TURN_MAX_CHARS + 1)
    expect(state.new_message).toBe('use tabs')
  })

  it('returns a confident steer or queue, otherwise null', async () => {
    expect(await decideMidTurnDelivery({ runningRequest: 'format the file', newMessage: 'use tabs, not spaces' }, { resolveClient: delivery('steer', 0.9) })).toBe('steer')
    expect(await decideMidTurnDelivery({ runningRequest: 'format the file', newMessage: 'later, draft the release notes' }, { resolveClient: delivery('queue', 0.85) })).toBe('queue')
    expect(await decideMidTurnDelivery({ newMessage: 'hmm' }, { resolveClient: delivery('steer', 0.55) })).toBeNull()
    expect(await decideMidTurnDelivery({ newMessage: 'hmm' }, { resolveClient: off })).toBeNull()
  })
})

describe('isContinuation', () => {
  it('merges only when the model is confident both messages are one request', async () => {
    expect(await isContinuation('rename the files', 'and keep the dates', { resolveClient: answering({ same_request: { type: 'noul', noul: 0.9 } }) })).toBe(true)
    expect(await isContinuation('rename the files', 'what is the weather', { resolveClient: answering({ same_request: { type: 'noul', noul: 0.1 } }) })).toBe(false)
    expect(await isContinuation('a', 'b', { resolveClient: off })).toBeNull()
    expect(await isContinuation('', 'b', { resolveClient: answering({ same_request: { type: 'noul', noul: 0.9 } }) })).toBeNull()
  })
})
