import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DecisionRecorder,
  SystemOneClient,
  normalizeDecisionLayerSettings,
  readDecisionLog,
  resolveDecisionEndpoint,
  type DecisionClientResolution,
} from '@memwise/shared/decisions'
import { buildSubagentModelPicker, buildSubagentTaskRequest, chooseSubagentModelLevel, SUBAGENT_MODEL_MAX_PROMPT_CHARS } from './subagent-models'

/** A provider that rates the task's `demand` at `score` with `confidence`. */
function rated(score: number, confidence: number): () => Promise<DecisionClientResolution> {
  return async () => {
    const settings = normalizeDecisionLayerSettings({ enabled: true, provider: 'openrouter', features: { subagentModels: true } })
    const endpoint = resolveDecisionEndpoint(settings)
    const fetchImpl = (async () => new Response(JSON.stringify({
      model: 'jev-1.13.0',
      answers: { demand: { type: 'score', score, confidence, probabilities: { '0': 0.25, '1': 0.25, '2': 0.25, '3': 0.25 } } },
      usage: { input_tokens: 5, output_tokens: 1 },
    }), { status: 200 })) as unknown as typeof fetch
    const client = new SystemOneClient({ baseUrl: endpoint.baseUrl, apiKey: 'k', model: endpoint.model, fetch: fetchImpl })
    return { ok: true, value: { client, settings, provider: 'openrouter', endpoint, keySource: 'provider' } }
  }
}

const task = { prompt: 'Find where the soccer config is loaded', description: 'Locate config loader', subagentType: 'Explore' }

describe('subagent model decision', () => {
  let dir: string
  let recorder: DecisionRecorder
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'subagent-models-'))
    recorder = new DecisionRecorder({ path: join(dir, 'decisions.jsonl') })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const pick = (score: number, confidence: number, configured?: 'haiku' | 'sonnet') =>
    buildSubagentModelPicker({ sessionId: 's1', isActive: () => true, resolveClient: rated(score, confidence), recorder })(task, { configured })

  it('runs lookups on Haiku, reading and substantial work on Sonnet, and keeps the session model for hard tasks', async () => {
    expect(await pick(0, 0.9)).toBe('haiku')
    expect(await pick(1, 0.9)).toBe('sonnet')
    expect(await pick(2.2, 0.9)).toBe('sonnet')
    expect(await pick(3, 0.9)).toBe('session')
  })

  it('leaves the Settings default in charge when unsure or off', async () => {
    expect(await pick(0, 0.4, 'sonnet')).toBeNull()
    let asked = 0
    const off = buildSubagentModelPicker({ sessionId: 's1', isActive: () => false, resolveClient: async () => { asked++; return rated(0, 0.9)() }, recorder })
    expect(await off(task, {})).toBeNull()
    expect(asked).toBe(0)
  })

  it('records whether the pick changed the model against the Settings default', async () => {
    await pick(1, 0.9, 'sonnet')
    await pick(0, 0.9, 'sonnet')
    await recorder.flush()
    const outcomes = (await readDecisionLog(recorder.path)).filter((line): line is Extract<typeof line, { kind: 'outcome' }> => (line as { kind?: string }).kind === 'outcome')
    expect(outcomes.map(o => [o.action, o.changed])).toEqual([['model:sonnet', false], ['model:haiku', true]])
  })

  it('sends the task without free-form extras and cuts long prompts', () => {
    const request = buildSubagentTaskRequest({ ...task, prompt: 'x'.repeat(10_000) })
    expect((request.state as { task: string }).task.length).toBe(SUBAGENT_MODEL_MAX_PROMPT_CHARS + 1)
    expect(Object.keys(request.state as object)).toEqual(['task', 'summary', 'agent_type'])
    expect(chooseSubagentModelLevel(null)).toBeNull()
  })
})
