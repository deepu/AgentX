/**
 * How a turn ended, read by the decision model (feature toggle `turnOutcome`).
 *
 * After a turn completes, the agent's final message is classified as
 * `finished` (did what was asked), `needs_input` (asks the user something or
 * waits for a decision or data) or `blocked` (could not proceed: an error it
 * cannot fix, missing access, a refusal). Only a confident answer counts;
 * anything else is `null` and the caller behaves as before.
 *
 * Callers: SessionManager moves open sessions that need the user to
 * Needs Review; the Tasks Conductor refuses to mark a child node done when it
 * asked for input or gave up (children run unattended, nobody would answer).
 */

import { isDecisionFeatureActive, type DecisionRequest, type DecisionResult } from '@memwise/shared/decisions'
import type { NodeOutcomeFn } from '../tasks/TaskRunner'
import { openDecisionPoint, recordDecisionOutcome, type DecisionPointDeps } from './decision-point'

export type TurnOutcome = 'finished' | 'needs_input' | 'blocked'

export interface ClassifiedTurnOutcome {
  outcome: TurnOutcome
  confidence: number
}

/** Status an open session moves to when the user is needed (the default workspace status set has it). */
export const TURN_OUTCOME_ATTENTION_STATUS = 'needs-review'

/** The winning outcome needs this much confidence… */
export const TURN_OUTCOME_MIN_CONFIDENCE = 0.7
/** …and this much probability mass. */
export const TURN_OUTCOME_MIN_PROBABILITY = 0.6
/** Questions and blockers usually come last, so the end of the reply is kept. */
export const TURN_OUTCOME_MAX_REPLY_CHARS = 3_000
/** The start of the user's request gives the model enough context. */
export const TURN_OUTCOME_MAX_REQUEST_CHARS = 800

const OUTCOMES: readonly TurnOutcome[] = ['finished', 'needs_input', 'blocked']

export function buildTurnOutcomeRequest(input: { request?: string; reply: string }): DecisionRequest {
  const reply = input.reply.trim()
  const request = input.request?.trim()
  return {
    state: {
      ...(request ? { user_request: request.slice(0, TURN_OUTCOME_MAX_REQUEST_CHARS) } : {}),
      assistant_final_message: reply.length > TURN_OUTCOME_MAX_REPLY_CHARS ? `…${reply.slice(-TURN_OUTCOME_MAX_REPLY_CHARS)}` : reply,
    },
    questions: {
      outcome: {
        type: 'choice',
        // A closing offer ("Want me to…?") is not a question the work waits on: the old wording
        // classified those as needs_input at ~1.0 and sent finished chats to Needs Review.
        instructions: 'How did the assistant end this turn? A closing offer of more help does not mean the assistant needs input.',
        criteria: {
          finished: 'The assistant did what was asked or answered the question. A closing offer of optional further help ("Want me to…?", "Let me know if…") still counts as finished.',
          needs_input: 'The requested work is not done yet: the assistant cannot continue without an answer, decision, confirmation, credentials or other information from the user.',
          blocked: 'The assistant could not complete the task: an error it cannot fix, missing access or permissions, or it declined.',
        },
      },
    },
  }
}

/** The confident outcome in a decision result, or `null`. */
export function readTurnOutcome(result: DecisionResult | null): ClassifiedTurnOutcome | null {
  const answer = result?.answers.outcome
  if (!answer || answer.type !== 'choice') return null
  const outcome = OUTCOMES.find(candidate => candidate === answer.choice)
  if (!outcome) return null
  if (answer.confidence < TURN_OUTCOME_MIN_CONFIDENCE) return null
  if ((answer.probabilities[outcome] ?? 0) < TURN_OUTCOME_MIN_PROBABILITY) return null
  return { outcome, confidence: answer.confidence }
}

export interface TurnOutcomeDeps extends DecisionPointDeps {
  sessionId?: string
  meta?: Record<string, unknown>
}

/** Classify a finished turn. `null` when switched off, unavailable, unsure or empty. Never throws. */
export async function classifyTurnOutcome(input: { request?: string; reply: string }, deps: TurnOutcomeDeps = {}): Promise<ClassifiedTurnOutcome | null> {
  if (!input.reply.trim()) return null
  const decide = await openDecisionPoint({ ...deps, feature: 'turnOutcome', record: 'turn_outcome' })
  if (!decide) return null
  const result = await decide(buildTurnOutcomeRequest(input), deps.meta)
  const classified = readTurnOutcome(result)
  // `changed`: the answer asks the caller to act (Needs Review, a failed node); the caller may still drop it.
  recordDecisionOutcome(result, classified
    ? { action: classified.outcome, changed: classified.outcome !== 'finished' }
    : { action: 'unsure', changed: false })
  return classified
}

/** Conductor seam: how a child node's final turn ended, recorded with the run context. */
export function buildNodeOutcomeClassifier(deps: DecisionPointDeps = {}): NodeOutcomeFn {
  const classify: NodeOutcomeFn = async (finalText, context) =>
    (await classifyTurnOutcome({ reply: finalText }, { ...deps, meta: context }))?.outcome ?? null
  // With the toggle off, nodes complete synchronously as before.
  classify.isActive = () => isDecisionFeatureActive('turnOutcome')
  return classify
}
