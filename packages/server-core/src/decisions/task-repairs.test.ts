import { describe, expect, it } from 'bun:test'
import type { DecisionResult } from '@memwise/shared/decisions'
import { buildRepairScopePicker, buildRepairScopeRequest, readRepairScope, REPAIR_MAX_NODES } from './task-repairs'

function nouls(values: Record<string, number>): DecisionResult {
  const answers: DecisionResult['answers'] = {}
  for (const [key, noul] of Object.entries(values)) answers[key] = { type: 'noul', noul }
  return { model: 'jev', requestedModel: 'jev', modelReported: true, answers, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 } as unknown as DecisionResult
}

describe('task repair scoping', () => {
  it('asks one yes/no per subtask', () => {
    const nodes = Array.from({ length: REPAIR_MAX_NODES }, (_, i) => ({ id: `n${i}`, description: `step ${i}` }))
    const request = buildRepairScopeRequest('totals missing', nodes)
    expect(Object.keys(request.questions)).toHaveLength(REPAIR_MAX_NODES)
    expect(request.state).toEqual({ failure_reason: 'totals missing' })
  })

  it('repairs a task with more subtasks than one call can ask about whole, without asking', async () => {
    let asked = 0
    const pick = buildRepairScopePicker({ resolveClient: async () => { asked++; return { ok: false, failure: { kind: 'disabled', message: 'off' } } } })
    const nodes = Array.from({ length: REPAIR_MAX_NODES + 1 }, (_, i) => ({ id: `n${i}`, description: `step ${i}` }))
    expect(await pick('totals missing', nodes, { slug: 's', runId: 'r' })).toBeNull()
    expect(asked).toBe(0)
  })

  it('returns the implicated subtasks, or null when none clears the threshold', () => {
    expect(readRepairScope(nouls({ 'implicated:a': 0.2, 'implicated:b': 0.9, 'implicated:c': 0.71 }))).toEqual(['b', 'c'])
    expect(readRepairScope(nouls({ 'implicated:a': 0.2 }))).toBeNull()
    expect(readRepairScope(null)).toBeNull()
  })

  it('is null without a reason, without subtasks, or when the feature is off', async () => {
    const off = async () => ({ ok: false as const, failure: { kind: 'disabled' as const, message: 'off' } })
    const pick = buildRepairScopePicker({ resolveClient: off })
    const context = { slug: 's', runId: 'r' }
    expect(await pick('', [{ id: 'a', description: 'x' }], context)).toBeNull()
    expect(await pick('reason', [], context)).toBeNull()
    expect(await pick('reason', [{ id: 'a', description: 'x' }], context)).toBeNull()
  })
})
