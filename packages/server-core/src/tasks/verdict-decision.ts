/**
 * Typed task verdicts via the decision model (Jev).
 *
 * The Conductor asks the orchestrator to end its verification reply with a
 * `VERDICT: PASS|FAIL` line. When the line is missing or garbled, the runner
 * used to re-ask (bounded) and eventually fail the run. With the decision layer
 * on, the reply is first classified by the decision model; only a confident
 * PASS/FAIL is accepted, everything else falls through to the old re-ask.
 *
 * Scope: parsing only. A parseable VERDICT line always wins over the model,
 * the model never changes what "PASS" or "FAIL" do, and `null` (unavailable,
 * unsure, failed) leaves the runner exactly as it was.
 */

import type { ChoiceQuestion, DecisionRequest, DecisionResult, NoulQuestion } from '@memwise/shared/decisions'
import { recordDecisionOutcome } from '../decisions/decision-point'

/** Winning option needs this much confidence… */
export const VERDICT_MIN_CONFIDENCE = 0.8
/** …and this much probability mass. */
export const VERDICT_MIN_PROBABILITY = 0.7
/** A subtask counts as "needs rework" at this "yes" probability. */
export const VERDICT_NODE_REWORK_THRESHOLD = 0.7
/** At most this many per-node questions (choice questions stay cheap; nouls are one per node). */
export const VERDICT_MAX_NODE_QUESTIONS = 50
/** The verifier's reply is cut to this many characters before it is sent. */
export const VERDICT_MAX_REPLY_CHARS = 8_000

export const VERDICT_QUESTION_KEY = 'verdict'
const NODE_QUESTION_PREFIX = 'rework:'

export interface DecidedVerdict {
  result: 'pass' | 'fail'
  /** Only for FAIL: a fixed, honest reason (the model produces no text and the reply had no verdict line). */
  reason?: string
  /** Only for FAIL with >1 subtask: nodes the reply singles out for rework. */
  nodes?: string[]
  /** Confidence of the winning verdict option. */
  confidence: number
}

/**
 * Outcome of a classification attempt:
 * - `decided`     → apply like a parsed verdict (log `via: 'decision'`)
 * - `unsure`      → the model answered but not confidently; re-ask (log `via: 'decision'`)
 * - `unavailable` → no decision ran (layer off, no key, error); re-ask (log as a plain unparsed verdict)
 */
export type VerdictClassification =
  | { kind: 'decided'; verdict: DecidedVerdict }
  | { kind: 'unsure' }
  | { kind: 'unavailable' }

/** Build the request: one choice (pass / fail / unclear) plus one noul per subtask when there are several. */
export function buildVerdictDecisionRequest(replyText: string, nodeIds: string[]): DecisionRequest {
  const reply = replyText.trim().slice(0, VERDICT_MAX_REPLY_CHARS)
  const verdict: ChoiceQuestion = {
    type: 'choice',
    instructions: {
      question: 'What verdict does this verification reply reach about the task result?',
      focus: 'Judge only the final conclusion of the verifier, not the quality of the task itself.',
    },
    criteria: {
      pass: 'The verifier concludes the result meets the acceptance criteria or approves it',
      fail: 'The verifier concludes the result does not meet the criteria, rejects it, or asks for rework',
      unclear: 'No clear judgment: the reply is a question, a partial analysis, or off-topic',
    },
  }
  const questions: Record<string, ChoiceQuestion | NoulQuestion> = { [VERDICT_QUESTION_KEY]: verdict }

  const nodes = nodeIds.length > 1 ? nodeIds.slice(0, VERDICT_MAX_NODE_QUESTIONS) : []
  for (const id of nodes) {
    questions[`${NODE_QUESTION_PREFIX}${id}`] = {
      type: 'noul',
      instructions: `Does the verifier say that the subtask "${id}" specifically has problems or must be redone?`,
    }
  }

  return {
    state: {
      verifier_reply: reply,
      subtasks: nodeIds,
    },
    questions,
  }
}

/**
 * Reason attached to a decided FAIL. Deliberately fixed: the model produces no text, and quoting an
 * arbitrary line of the reply ("Everything else looks good.") would mislead the re-run prompt.
 */
export const DECIDED_FAIL_REASON =
  "the verifier's reply had no VERDICT line and the decision model read it as a rejection; re-check the result against the acceptance criteria"

/**
 * Turn a decision result into a verdict, or `null` when the model is not sure
 * enough (the caller then re-asks the orchestrator as before).
 */
export function interpretVerdictDecision(result: DecisionResult, nodeIds: string[], replyText: string): DecidedVerdict | null {
  const answer = result.answers[VERDICT_QUESTION_KEY]
  if (!answer || answer.type !== 'choice') return null
  if (answer.choice !== 'pass' && answer.choice !== 'fail') return null
  const probability = answer.probabilities[answer.choice] ?? 0
  if (answer.confidence < VERDICT_MIN_CONFIDENCE || probability < VERDICT_MIN_PROBABILITY) return null

  if (answer.choice === 'pass') {
    return { result: 'pass', confidence: answer.confidence }
  }

  const decided: DecidedVerdict = { result: 'fail', confidence: answer.confidence, reason: DECIDED_FAIL_REASON }

  if (nodeIds.length > 1) {
    // Only the nodes we actually asked about can be flagged (the request caps them).
    const asked = nodeIds.slice(0, VERDICT_MAX_NODE_QUESTIONS)
    const flagged: string[] = []
    for (const id of asked) {
      const node = result.answers[`${NODE_QUESTION_PREFIX}${id}`]
      if (node?.type === 'noul' && node.noul >= VERDICT_NODE_REWORK_THRESHOLD) flagged.push(id)
    }
    // Flagging every asked node is the same as naming none (whole-DAG repair) — keep the log honest.
    if (flagged.length > 0 && flagged.length < asked.length) decided.nodes = flagged
  }
  return decided
}

/**
 * Classify an unparsed verifier reply. Never throws. Anything but `decided`
 * means "behave as before" (re-ask); `unavailable` additionally means no
 * decision ran, so the run-log must not claim one did.
 */
export async function classifyVerdictWithDecision(
  replyText: string,
  nodeIds: string[],
  decide: (request: DecisionRequest) => Promise<DecisionResult | null>,
): Promise<VerdictClassification> {
  if (!replyText.trim()) return { kind: 'unavailable' }
  try {
    const result = await decide(buildVerdictDecisionRequest(replyText, nodeIds))
    if (!result) return { kind: 'unavailable' }
    const verdict = interpretVerdictDecision(result, nodeIds, replyText)
    recordDecisionOutcome(result, verdict ? { action: `verdict:${verdict.result}`, changed: true } : { action: 'reask', changed: false })
    return verdict ? { kind: 'decided', verdict } : { kind: 'unsure' }
  } catch {
    return { kind: 'unavailable' }
  }
}
