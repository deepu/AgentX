/**
 * Mid-turn messages via the decision model (feature toggle `midTurnMessages`).
 *
 * - A text message sent while the agent works is judged against the request it
 *   is working on: a correction or addition is steered into the running turn,
 *   a separate follow-up is queued. Without a confident answer the
 *   connection's `midStreamBehavior` applies as before.
 * - A queued message that continues the one queued before it is replayed
 *   together with it as one turn instead of two.
 *
 * Nothing is dropped and nothing interrupts: the answer only picks between the
 * two delivery paths that already exist.
 */

import type { DecisionRequest } from '@memwise/shared/decisions'
import { FOREGROUND_MAX_DEADLINE_MS, openDecisionPoint, recordDecisionOutcome, type DecisionPointDeps } from './decision-point'

/** The steer/queue choice needs this much confidence. */
export const MID_TURN_MIN_CONFIDENCE = 0.7
/** "Same request" probability that merges two queued messages. */
export const CONTINUATION_MIN_PROBABILITY = 0.75
/** Each text is cut to this many characters. */
export const MID_TURN_MAX_CHARS = 1_500

const clip = (text: string) => (text.length > MID_TURN_MAX_CHARS ? `${text.slice(0, MID_TURN_MAX_CHARS)}…` : text)

export function buildMidTurnRequest(input: { runningRequest?: string; newMessage: string }): DecisionRequest {
  return {
    state: {
      ...(input.runningRequest ? { request_being_worked_on: clip(input.runningRequest) } : {}),
      new_message: clip(input.newMessage),
    },
    questions: {
      delivery: {
        type: 'choice',
        instructions: 'The user sent a new message while the assistant is still working. How should it be delivered?',
        criteria: {
          steer: 'It corrects, redirects or adds to what the assistant is doing right now, so it should reach the assistant immediately.',
          queue: 'It is a separate follow-up or a new request that can wait until the current work is finished.',
        },
      },
    },
  }
}

/** `steer` or `queue` when the model is confident; `null` keeps the configured behaviour. Never throws. */
export async function decideMidTurnDelivery(
  /** `configured`: the connection's `midStreamBehavior`, the delivery without an answer (for the outcome record). */
  input: { runningRequest?: string; newMessage: string; configured?: 'steer' | 'queue' },
  deps: DecisionPointDeps & { sessionId?: string } = {},
): Promise<'steer' | 'queue' | null> {
  if (!input.newMessage.trim()) return null
  // The message's acknowledgement waits for this answer.
  const decide = await openDecisionPoint({ ...deps, feature: 'midTurnMessages', record: 'mid_turn_messages', maxDeadlineMs: FOREGROUND_MAX_DEADLINE_MS })
  if (!decide) return null
  const result = await decide(buildMidTurnRequest(input), { check: 'delivery' })
  const answer = result?.answers.delivery
  const delivery = answer?.type === 'choice' && answer.confidence >= MID_TURN_MIN_CONFIDENCE && (answer.choice === 'steer' || answer.choice === 'queue')
    ? answer.choice
    : null
  // Without an answer the connection's midStreamBehavior decides.
  recordDecisionOutcome(result, delivery
    ? { action: delivery, changed: input.configured !== undefined && delivery !== input.configured, ...(input.configured ? { detail: { configured: input.configured } } : {}) }
    : { action: 'default', changed: false, detail: { reason: answer?.type === 'choice' ? 'low_confidence' : 'no_answer' } })
  return delivery
}

export function buildContinuationRequest(previous: string, next: string): DecisionRequest {
  return {
    state: { first_message: clip(previous), second_message: clip(next) },
    questions: {
      same_request: {
        type: 'noul',
        instructions: 'Is the second message part of the same request as the first (a correction, an addition or a detail), rather than a separate request?',
      },
    },
  }
}

/** `true` when the model is confident both queued messages form one request; `null` without an answer. Never throws. */
export async function isContinuation(previous: string, next: string, deps: DecisionPointDeps & { sessionId?: string } = {}): Promise<boolean | null> {
  if (!previous.trim() || !next.trim()) return null
  const decide = await openDecisionPoint({ ...deps, feature: 'midTurnMessages', record: 'mid_turn_messages' })
  if (!decide) return null
  const result = await decide(buildContinuationRequest(previous, next), { check: 'continuation' })
  const answer = result?.answers.same_request
  if (!answer || answer.type !== 'noul') {
    recordDecisionOutcome(result, { action: 'separate', changed: false, detail: { reason: 'no_answer' } })
    return null
  }
  const merge = answer.noul >= CONTINUATION_MIN_PROBABILITY
  recordDecisionOutcome(result, { action: merge ? 'merge' : 'separate', changed: merge })
  return merge
}
