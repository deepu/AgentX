import { describe, expect, it } from 'bun:test'
import {
  SystemOneClient,
  normalizeDecisionLayerSettings,
  resolveDecisionEndpoint,
  type DecisionClientResolution,
} from '@memwise/shared/decisions'
import { AUTOMATION_CONDITION_MAX_MESSAGE_CHARS, buildAutomationConditionRequest, checkAutomationCondition } from './automation-condition'

function answering(noul: number): () => Promise<DecisionClientResolution> {
  return async () => {
    const settings = normalizeDecisionLayerSettings({ enabled: true, provider: 'openrouter', features: { automationConditions: true } })
    const endpoint = resolveDecisionEndpoint(settings)
    const fetchImpl = (async () => new Response(JSON.stringify({
      model: 'jev-1.13.0',
      answers: { condition: { type: 'noul', noul } },
      usage: { input_tokens: 10, output_tokens: 1 },
    }), { status: 200 })) as unknown as typeof fetch
    const client = new SystemOneClient({ baseUrl: endpoint.baseUrl, apiKey: 'k', model: endpoint.model, fetch: fetchImpl })
    return { ok: true, value: { client, settings, provider: 'openrouter', endpoint, keySource: 'provider' } }
  }
}

describe('buildAutomationConditionRequest', () => {
  it('sends the event, the payload without ids, and the session excerpt', () => {
    const request = buildAutomationConditionRequest(
      { question: 'Is it a bug report?' },
      {
        event: 'LabelAdd',
        automationName: 'Triage',
        payload: { label: 'bug', sessionId: 's-1', workspaceId: 'w', timestamp: 1 },
        session: { name: 'Crash on start', labels: ['bug'], lastUserMessage: 'x'.repeat(5_000) },
      },
    )
    const state = request.state as Record<string, any>
    expect(state.event).toBe('LabelAdd')
    expect(state.automation).toBe('Triage')
    expect(state.trigger).toEqual({ label: 'bug' })
    expect(state.session.name).toBe('Crash on start')
    expect(state.session.last_user_message.length).toBe(AUTOMATION_CONDITION_MAX_MESSAGE_CHARS + 1)
    expect(request.questions.condition).toEqual({ type: 'noul', instructions: 'Is it a bug report?' })
  })
})

describe('checkAutomationCondition', () => {
  const context = { event: 'LabelAdd', payload: { label: 'bug' } }

  it('is null when the feature is off, so the automation runs', async () => {
    const verdict = await checkAutomationCondition({ question: 'q' }, context, {
      resolveClient: async () => ({ ok: false, failure: { kind: 'disabled', message: 'off' } }),
    })
    expect(verdict).toBeNull()
  })

  it('runs at or above the threshold and skips below it', async () => {
    expect(await checkAutomationCondition({ question: 'q' }, context, { resolveClient: answering(0.5) })).toEqual({ run: true, probability: 0.5 })
    expect(await checkAutomationCondition({ question: 'q' }, context, { resolveClient: answering(0.2) })).toEqual({ run: false, probability: 0.2 })
    expect(await checkAutomationCondition({ question: 'q', threshold: 0.9 }, context, { resolveClient: answering(0.8) })).toEqual({ run: false, probability: 0.8 })
  })
})
