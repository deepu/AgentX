/**
 * Smarter session titles via the decision model (feature toggle `smartTitles`).
 *
 * - A first message that is only small talk ("hi", "thanks") gets no AI title;
 *   the next message that asks for something is titled instead.
 * - After later turns, an automatic title that no longer describes the
 *   conversation is refreshed. Titles the user set are never touched.
 *
 * `null` (feature off, unavailable, unsure) keeps today's behaviour.
 */

import type { DecisionRequest } from '@memwise/shared/decisions'
import { openDecisionPoint, recordDecisionOutcome, type DecisionPointDeps } from './decision-point'

/** Longer first messages are treated as requests without asking. */
export const SMALL_TALK_MAX_CHARS = 200
/** "Asks for something" probability at or below which a message counts as small talk. */
export const SMALL_TALK_MAX_REQUEST_PROBABILITY = 0.2
/** "Title still fits" probability at or below which an automatic title is refreshed. */
export const TITLE_DRIFT_MAX_FIT_PROBABILITY = 0.25
/** Recent user messages shown for the drift check, and how much of each. */
export const TITLE_DRIFT_RECENT_MESSAGES = 3
export const TITLE_DRIFT_MAX_MESSAGE_CHARS = 400

export function buildSmallTalkRequest(message: string): DecisionRequest {
  return {
    state: { message },
    questions: {
      asks_for_something: {
        type: 'noul',
        instructions: 'Does this message ask for something specific or describe a task, rather than being only a greeting, thanks, an acknowledgement or small talk?',
      },
    },
  }
}

/** `true` when the model is confident the message is only small talk; `null` without an answer. Never throws. */
export async function isSmallTalk(message: string, deps: DecisionPointDeps & { sessionId?: string } = {}): Promise<boolean | null> {
  const text = message.trim()
  if (!text || text.length > SMALL_TALK_MAX_CHARS) return text ? false : null
  const decide = await openDecisionPoint({ ...deps, feature: 'smartTitles', record: 'smart_titles' })
  if (!decide) return null
  const result = await decide(buildSmallTalkRequest(text), { check: 'small_talk' })
  const answer = result?.answers.asks_for_something
  if (!answer || answer.type !== 'noul') {
    recordDecisionOutcome(result, { action: 'title_now', changed: false, detail: { reason: 'no_answer' } })
    return null
  }
  const smallTalk = answer.noul <= SMALL_TALK_MAX_REQUEST_PROBABILITY
  recordDecisionOutcome(result, { action: smallTalk ? 'defer_title' : 'title_now', changed: smallTalk })
  return smallTalk
}

export function buildTitleDriftRequest(title: string, recentUserMessages: readonly string[]): DecisionRequest {
  return {
    state: {
      title,
      recent_user_messages: recentUserMessages
        .slice(-TITLE_DRIFT_RECENT_MESSAGES)
        .map(message => (message.length > TITLE_DRIFT_MAX_MESSAGE_CHARS ? `${message.slice(0, TITLE_DRIFT_MAX_MESSAGE_CHARS)}…` : message)),
    },
    questions: {
      still_fits: { type: 'noul', instructions: 'Does this title still describe what the conversation is about now?' },
    },
  }
}

/** `true` when the model is confident the title no longer fits; `null` without an answer. Never throws. */
export async function titleNoLongerFits(
  title: string,
  recentUserMessages: readonly string[],
  deps: DecisionPointDeps & { sessionId?: string } = {},
): Promise<boolean | null> {
  if (!title.trim() || recentUserMessages.length === 0) return null
  const decide = await openDecisionPoint({ ...deps, feature: 'smartTitles', record: 'smart_titles' })
  if (!decide) return null
  const result = await decide(buildTitleDriftRequest(title, recentUserMessages), { check: 'title_drift' })
  const answer = result?.answers.still_fits
  if (!answer || answer.type !== 'noul') {
    recordDecisionOutcome(result, { action: 'keep_title', changed: false, detail: { reason: 'no_answer' } })
    return null
  }
  const drifted = answer.noul <= TITLE_DRIFT_MAX_FIT_PROBABILITY
  recordDecisionOutcome(result, { action: drifted ? 'refresh_title' : 'keep_title', changed: drifted })
  return drifted
}
