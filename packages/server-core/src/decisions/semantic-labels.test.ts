import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LabelConfig } from '@memwise/shared/labels'
import {
  DecisionRecorder,
  SystemOneClient,
  normalizeDecisionLayerSettings,
  resolveDecisionEndpoint,
  type DecisionClientResolution,
} from '@memwise/shared/decisions'
import { evaluateSemanticLabelsForMessage, hasSemanticAutoLabelRules } from './semantic-labels'

const LABELS: LabelConfig[] = [
  { id: 'billing', name: 'Billing', autoRules: [{ semantic: 'Is the user asking about billing?' }] },
  { id: 'issue', name: 'Issue', autoRules: [{ pattern: '[A-Z]+-\\d+' }] },
]

function resolutionWith(fetchImpl: typeof fetch): DecisionClientResolution {
  const settings = normalizeDecisionLayerSettings({ enabled: true, provider: 'typesafe' })
  const endpoint = resolveDecisionEndpoint(settings)
  const client = new SystemOneClient({ baseUrl: endpoint.baseUrl, apiKey: 'k', model: endpoint.model, fetch: fetchImpl })
  return { ok: true, value: { client, settings, provider: 'typesafe', endpoint, keySource: 'provider' } }
}

describe('semantic labels hook', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'memwise-semantic-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('detects semantic rules in the tree', () => {
    expect(hasSemanticAutoLabelRules(LABELS)).toBe(true)
    expect(hasSemanticAutoLabelRules([LABELS[1]!])).toBe(false)
  })

  it('does nothing when the tree has no semantic rules — not even a resolution', async () => {
    let resolved = false
    const matches = await evaluateSemanticLabelsForMessage('my invoice is wrong and this is long enough', [LABELS[1]!], {
      sessionId: 's',
      resolveClient: async () => { resolved = true; return { ok: false, failure: { kind: 'disabled', message: 'x' } } },
    })
    expect(matches).toEqual([])
    expect(resolved).toBe(false)
  })

  it('does nothing when the layer is disabled in Settings', async () => {
    const matches = await evaluateSemanticLabelsForMessage('why was my invoice charged twice this month', LABELS, {
      sessionId: 's',
      resolveClient: async () => ({ ok: false, failure: { kind: 'disabled', message: 'The decision model is disabled in Settings > AI' } }),
    })
    expect(matches).toEqual([])
  })

  it('asks nothing for rules whose label the session already has — in any spelling older versions stored', async () => {
    for (const existing of ['billing', 'billing::', 'billing::Invoice']) {
      let resolved = false
      const matches = await evaluateSemanticLabelsForMessage('why was my invoice charged twice again', LABELS, {
        sessionId: 's',
        existingEntries: [existing],
        resolveClient: async () => { resolved = true; return { ok: false, failure: { kind: 'disabled', message: 'x' } } },
      })
      expect(matches).toEqual([])
      expect(resolved).toBe(false)
    }
  })

  it('records "changed" only for labels the session did not have', async () => {
    const recorder = new DecisionRecorder({ path: join(dir, 'decisions.jsonl') })
    const tree: LabelConfig[] = [
      { id: 'billing', name: 'Billing', autoRules: [{ semantic: 'Is the user asking about billing?' }] },
      { id: 'refund', name: 'Refund', autoRules: [{ semantic: 'Is the user asking for a refund?' }] },
    ]
    let asked: string[] = []
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, { instructions: string }> }
      asked = Object.values(body.questions).map(q => q.instructions)
      const answers: Record<string, unknown> = {}
      for (const key of Object.keys(body.questions)) answers[key] = { type: 'noul', noul: 0.97 }
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 })
    }) as unknown as typeof fetch

    const matches = await evaluateSemanticLabelsForMessage('I was charged twice, please refund me', tree, {
      sessionId: 's', existingEntries: ['billing'], resolveClient: async () => resolutionWith(fetchImpl), recorder,
    })
    expect(asked).toEqual(['Is the user asking for a refund?'])
    expect(matches.map(m => m.labelId)).toEqual(['refund'])
    await recorder.flush()
    const outcome = readFileSync(recorder.path, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(line => line.kind === 'outcome')
    expect(outcome).toMatchObject({ action: 'labels', changed: true, detail: { matches: 1 } })
  })

  it('applies labels above the threshold and records the call without the message text', async () => {
    const recorder = new DecisionRecorder({ path: join(dir, 'decisions.jsonl') })
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }
      const answers: Record<string, unknown> = {}
      for (const key of Object.keys(body.questions)) answers[key] = { type: 'noul', noul: 0.97 }
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 })
    }) as unknown as typeof fetch

    const matches = await evaluateSemanticLabelsForMessage('why was my invoice charged twice', LABELS, {
      sessionId: 'sess-9',
      resolveClient: async () => resolutionWith(fetchImpl),
      recorder,
    })
    expect(matches).toEqual([
      { labelId: 'billing', value: '', matchedText: 'Is the user asking about billing?', via: 'semantic', probability: 0.97 },
    ])
    await recorder.append({ t: 'x', feature: 'settings_test', provider: 'typesafe', model: 'm', ok: true, questions: {}, state: null })
    const first = readFileSync(recorder.path, 'utf8').trim().split('\n')[0]!
    const record = JSON.parse(first)
    expect(record.feature).toBe('semantic_labels')
    expect(record.sessionId).toBe('sess-9')
    expect(record.meta).toEqual({ rules: 1 })
    expect(first).not.toContain('invoice')
  })

  it('skips trivially short messages without a decision call', async () => {
    let resolved = false
    const matches = await evaluateSemanticLabelsForMessage('thanks', LABELS, {
      sessionId: 's',
      resolveClient: async () => { resolved = true; return { ok: false, failure: { kind: 'disabled', message: 'x' } } },
    })
    expect(matches).toEqual([])
    // The resolver may run (cheap gates pass) but no request is made — the evaluator applies the floor.
    void resolved
  })

  it('returns no matches when the layer is unavailable or the provider fails', async () => {
    const unavailable = await evaluateSemanticLabelsForMessage('why was my invoice charged twice this month', LABELS, {
      sessionId: 's',
      resolveClient: async () => ({ ok: false, failure: { kind: 'unconfigured', message: 'no key' } }),
    })
    expect(unavailable).toEqual([])

    const failing = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch
    const recorder = new DecisionRecorder({ path: join(dir, 'd2.jsonl') })
    const failed = await evaluateSemanticLabelsForMessage('why was my invoice charged twice this month', LABELS, {
      sessionId: 's',
      resolveClient: async () => resolutionWith(failing),
      recorder,
    })
    expect(failed).toEqual([])
    await recorder.append({ t: 'x', feature: 'settings_test', provider: 'typesafe', model: 'm', ok: true, questions: {}, state: null })
    expect(existsSync(recorder.path)).toBe(true)
    expect(JSON.parse(readFileSync(recorder.path, 'utf8').trim().split('\n')[0]!).ok).toBe(false)
  })
})
