import { describe, expect, it } from 'bun:test'
import type { DecisionResult } from '@memwise/shared/decisions'
import { assessPermissionRisks, buildPermissionRiskRequest, PERMISSION_RISK_MAX_CHARS, readPermissionRisks } from './permission-risks'

function nouls(values: Record<string, number>): DecisionResult {
  const answers: DecisionResult['answers'] = {}
  for (const [key, noul] of Object.entries(values)) answers[key] = { type: 'noul', noul }
  return { model: 'jev', requestedModel: 'jev', modelReported: true, answers, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 } as unknown as DecisionResult
}

describe('permission risk badges', () => {
  it('asks one yes/no question per badge and clips long commands', () => {
    const request = buildPermissionRiskRequest({ toolName: 'Bash', description: 'Execute: …', command: 'x'.repeat(10_000) })
    expect(Object.keys(request.questions)).toEqual(['deletes', 'sends', 'publishes', 'credentials', 'system', 'spends'])
    expect((request.state as Record<string, string>).command!.length).toBe(PERMISSION_RISK_MAX_CHARS + 1)
  })

  it('shows badges at or above the threshold, in a fixed order', () => {
    expect(readPermissionRisks(nouls({ spends: 0.9, deletes: 0.8, sends: 0.74, publishes: 0.1, credentials: 0.2, system: 0.3 }))).toEqual(['deletes', 'spends'])
    expect(readPermissionRisks(null)).toBeNull()
  })

  it('is null when the feature is off', async () => {
    const risks = await assessPermissionRisks(
      { toolName: 'Bash', description: 'Execute: rm -rf x', command: 'rm -rf x' },
      { resolveClient: async () => ({ ok: false, failure: { kind: 'disabled', message: 'off' } }) },
    )
    expect(risks).toBeNull()
  })
})
