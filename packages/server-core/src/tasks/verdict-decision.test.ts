import { describe, it, expect } from 'bun:test'
import type { DecisionResult } from '@memwise/shared/decisions'
import {
  buildVerdictDecisionRequest,
  classifyVerdictWithDecision,
  interpretVerdictDecision,
  DECIDED_FAIL_REASON,
  VERDICT_MAX_NODE_QUESTIONS,
  VERDICT_QUESTION_KEY,
} from './verdict-decision'

function resultWith(answers: DecisionResult['answers']): DecisionResult {
  return {
    model: 'jev-1.13.0',
    modelReported: true,
    requestedModel: 'jev-1.13.0',
    answers,
    usage: { inputTokens: 10, outputTokens: 1 },
    latencyMs: 100,
    state: { sha256: 'x', bytes: 10, truncated: false },
  }
}

const choice = (choice: 'pass' | 'fail' | 'unclear', p: number, confidence: number) => ({
  type: 'choice' as const,
  choice,
  confidence,
  probabilities: { pass: choice === 'pass' ? p : (1 - p) / 2, fail: choice === 'fail' ? p : (1 - p) / 2, unclear: choice === 'unclear' ? p : 0 },
})

describe('buildVerdictDecisionRequest', () => {
  it('asks one choice question and, for multi-node tasks, one noul per node', () => {
    const single = buildVerdictDecisionRequest('Looks fine.', ['a'])
    expect(Object.keys(single.questions)).toEqual([VERDICT_QUESTION_KEY])
    expect(single.questions[VERDICT_QUESTION_KEY]!.type).toBe('choice')
    expect((single.state as Record<string, unknown>).verifier_reply).toBe('Looks fine.')
    expect((single.state as Record<string, unknown>).subtasks).toEqual(['a'])

    const multi = buildVerdictDecisionRequest('The report node is weak.', ['research', 'report'])
    expect(Object.keys(multi.questions)).toEqual([VERDICT_QUESTION_KEY, 'rework:research', 'rework:report'])
    expect(multi.questions['rework:report']!.type).toBe('noul')
    expect(String(multi.questions['rework:report']!.instructions)).toContain('"report"')
  })

  it('caps node questions and truncates very long replies', () => {
    const ids = Array.from({ length: 80 }, (_, i) => `n${i}`)
    const request = buildVerdictDecisionRequest('x'.repeat(20_000), ids)
    expect(Object.keys(request.questions)).toHaveLength(1 + VERDICT_MAX_NODE_QUESTIONS)
    expect(((request.state as Record<string, unknown>).verifier_reply as string).length).toBe(8_000)
  })
})

describe('interpretVerdictDecision', () => {
  const nodes = ['research', 'report']
  const reply = 'I checked everything.\n\nThe summary is complete and accurate, nothing to fix.'

  it('accepts a confident PASS', () => {
    const decided = interpretVerdictDecision(resultWith({ verdict: choice('pass', 0.95, 0.92) }), nodes, reply)
    expect(decided).toEqual({ result: 'pass', confidence: 0.92 })
  })

  it('accepts a confident FAIL with the fixed reason and the flagged nodes', () => {
    const decided = interpretVerdictDecision(
      resultWith({
        verdict: choice('fail', 0.9, 0.85),
        'rework:research': { type: 'noul', noul: 0.2 },
        'rework:report': { type: 'noul', noul: 0.93 },
      }),
      nodes,
      'The research is fine.\nThe report misses the revenue table and must be redone.',
    )
    expect(decided?.result).toBe('fail')
    expect(decided?.nodes).toEqual(['report'])
    // Never quotes the reply: an arbitrary line would mislead the re-run prompt.
    expect(decided?.reason).toBe(DECIDED_FAIL_REASON)
    expect(decided?.reason).not.toContain('must be redone')
  })

  it('compares flagged nodes against the nodes it actually asked about', () => {
    const ids = Array.from({ length: VERDICT_MAX_NODE_QUESTIONS + 10 }, (_, i) => `n${i}`)
    const answers: DecisionResult['answers'] = { verdict: choice('fail', 0.9, 0.85) }
    for (let i = 0; i < VERDICT_MAX_NODE_QUESTIONS; i++) answers[`rework:n${i}`] = { type: 'noul', noul: 0.9 }
    // every asked node flagged → whole-DAG repair, not "the first 50"
    expect(interpretVerdictDecision(resultWith(answers), ids, reply)?.nodes).toBeUndefined()
  })

  it('treats "every node flagged" the same as "none flagged" (whole-DAG repair)', () => {
    const decided = interpretVerdictDecision(
      resultWith({
        verdict: choice('fail', 0.9, 0.85),
        'rework:research': { type: 'noul', noul: 0.9 },
        'rework:report': { type: 'noul', noul: 0.9 },
      }),
      nodes,
      reply,
    )
    expect(decided?.result).toBe('fail')
    expect(decided?.nodes).toBeUndefined()
  })

  it('returns null for unclear, low-confidence or low-probability answers', () => {
    expect(interpretVerdictDecision(resultWith({ verdict: choice('unclear', 0.9, 0.9) }), nodes, reply)).toBeNull()
    expect(interpretVerdictDecision(resultWith({ verdict: choice('pass', 0.95, 0.5) }), nodes, reply)).toBeNull()
    expect(interpretVerdictDecision(resultWith({ verdict: { type: 'choice', choice: 'fail', confidence: 0.85, probabilities: { pass: 0.35, fail: 0.6, unclear: 0.05 } } }), nodes, reply)).toBeNull()
    expect(interpretVerdictDecision(resultWith({ other: choice('pass', 0.95, 0.95) }), nodes, reply)).toBeNull()
    expect(interpretVerdictDecision(resultWith({ verdict: { type: 'noul', noul: 0.99 } }), nodes, reply)).toBeNull()
  })
})

describe('classifyVerdictWithDecision', () => {
  it('reports unavailable (no decision ran) on null, thrown errors and empty replies', async () => {
    expect(await classifyVerdictWithDecision('some text', ['a'], async () => null)).toEqual({ kind: 'unavailable' })
    expect(await classifyVerdictWithDecision('some text', ['a'], async () => { throw new Error('boom') })).toEqual({ kind: 'unavailable' })
    let called = false
    expect(await classifyVerdictWithDecision('   ', ['a'], async () => { called = true; return null })).toEqual({ kind: 'unavailable' })
    expect(called).toBe(false)
  })

  it('reports unsure when the model answered without enough confidence', async () => {
    expect(await classifyVerdictWithDecision('hmm', ['a'], async () => resultWith({ verdict: choice('unclear', 0.9, 0.9) }))).toEqual({ kind: 'unsure' })
    expect(await classifyVerdictWithDecision('hmm', ['a'], async () => resultWith({ verdict: choice('pass', 0.95, 0.4) }))).toEqual({ kind: 'unsure' })
  })

  it('passes the built request through and interprets the answer', async () => {
    let seen: unknown
    const outcome = await classifyVerdictWithDecision('All good, ship it.', ['a'], async (request) => {
      seen = request
      return resultWith({ verdict: choice('pass', 0.99, 0.98) })
    })
    expect(outcome).toEqual({ kind: 'decided', verdict: { result: 'pass', confidence: 0.98 } })
    expect((seen as { questions: Record<string, unknown> }).questions[VERDICT_QUESTION_KEY]).toBeDefined()
  })
})
