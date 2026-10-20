import { describe, expect, it } from 'bun:test'
import {
  SystemOneClient,
  normalizeDecisionLayerSettings,
  resolveDecisionEndpoint,
  type DecisionClientResolution,
} from '@memwise/shared/decisions'
import { buildTitleDriftRequest, isSmallTalk, SMALL_TALK_MAX_CHARS, titleNoLongerFits, TITLE_DRIFT_MAX_MESSAGE_CHARS } from './smart-titles'

function answering(key: string, noul: number): () => Promise<DecisionClientResolution> {
  return async () => {
    const settings = normalizeDecisionLayerSettings({ enabled: true, provider: 'openrouter', features: { smartTitles: true } })
    const endpoint = resolveDecisionEndpoint(settings)
    const fetchImpl = (async () => new Response(JSON.stringify({
      model: 'jev-1.13.0',
      answers: { [key]: { type: 'noul', noul } },
      usage: { input_tokens: 5, output_tokens: 1 },
    }), { status: 200 })) as unknown as typeof fetch
    const client = new SystemOneClient({ baseUrl: endpoint.baseUrl, apiKey: 'k', model: endpoint.model, fetch: fetchImpl })
    return { ok: true, value: { client, settings, provider: 'openrouter', endpoint, keySource: 'provider' } }
  }
}
const off = async () => ({ ok: false as const, failure: { kind: 'disabled' as const, message: 'off' } })

describe('isSmallTalk', () => {
  it('treats long messages as requests without asking', async () => {
    let asked = 0
    const result = await isSmallTalk('x'.repeat(SMALL_TALK_MAX_CHARS + 1), { resolveClient: async () => { asked++; return off() } })
    expect(result).toBe(false)
    expect(asked).toBe(0)
  })

  it('is null when the feature is off', async () => {
    expect(await isSmallTalk('hi', { resolveClient: off })).toBeNull()
  })

  it('is small talk only when the model is confident the message asks for nothing', async () => {
    expect(await isSmallTalk('hi', { resolveClient: answering('asks_for_something', 0.05) })).toBe(true)
    expect(await isSmallTalk('fix the login bug', { resolveClient: answering('asks_for_something', 0.9) })).toBe(false)
    expect(await isSmallTalk('ok so', { resolveClient: answering('asks_for_something', 0.4) })).toBe(false)
  })
})

describe('titleNoLongerFits', () => {
  it('sends the title and the last few user messages, clipped', () => {
    const state = buildTitleDriftRequest('Login bug', ['a', 'b', 'c', 'x'.repeat(1_000)]).state as { title: string; recent_user_messages: string[] }
    expect(state.title).toBe('Login bug')
    expect(state.recent_user_messages).toHaveLength(3)
    expect(state.recent_user_messages[2]!.length).toBe(TITLE_DRIFT_MAX_MESSAGE_CHARS + 1)
  })

  it('refreshes only when the model is confident the title no longer fits', async () => {
    expect(await titleNoLongerFits('Login bug', ['now about billing'], { resolveClient: answering('still_fits', 0.1) })).toBe(true)
    expect(await titleNoLongerFits('Login bug', ['more on login'], { resolveClient: answering('still_fits', 0.8) })).toBe(false)
    expect(await titleNoLongerFits('Login bug', ['x'], { resolveClient: off })).toBeNull()
    expect(await titleNoLongerFits('Login bug', [], { resolveClient: answering('still_fits', 0.1) })).toBeNull()
  })
})
