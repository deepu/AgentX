/**
 * Automation conditions via the decision model (feature toggle `automationConditions`).
 *
 * An automation matcher may carry `semanticCondition: { question, threshold? }`.
 * Before its prompt actions start a session, the question is answered against
 * the event (and, for session events, the session's latest exchange). A "yes"
 * probability below the condition's threshold (default 0.5) skips the run,
 * saving a whole agent run. `null` (feature off, unavailable, failed) means run
 * as without the condition.
 */

import type { SemanticCondition } from '@memwise/shared/automations'
import type { DecisionRequest } from '@memwise/shared/decisions'
import { openDecisionPoint, recordDecisionOutcome, type DecisionPointDeps } from './decision-point'

/** "Yes" probability needed to run when the condition sets no threshold. */
export const AUTOMATION_CONDITION_DEFAULT_THRESHOLD = 0.5
/** Each message excerpt is cut to this many characters. */
export const AUTOMATION_CONDITION_MAX_MESSAGE_CHARS = 1_500

/** Payload fields that are identifiers or plumbing, not something to judge. */
const IGNORED_PAYLOAD_KEYS = new Set(['sessionId', 'workspaceId', 'timestamp', 'matcherId'])

export interface AutomationConditionContext {
  event: string
  automationName?: string
  payload?: Record<string, unknown>
  /** The session the event is about, when there is one. */
  session?: {
    name?: string
    labels?: string[]
    status?: string
    lastUserMessage?: string
    lastAssistantMessage?: string
  }
}

function clip(text: string | undefined): string | undefined {
  if (!text) return undefined
  return text.length > AUTOMATION_CONDITION_MAX_MESSAGE_CHARS ? `${text.slice(0, AUTOMATION_CONDITION_MAX_MESSAGE_CHARS)}…` : text
}

export function buildAutomationConditionRequest(condition: SemanticCondition, context: AutomationConditionContext): DecisionRequest {
  const trigger: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(context.payload ?? {})) {
    if (IGNORED_PAYLOAD_KEYS.has(key) || value === undefined || value === null) continue
    trigger[key] = typeof value === 'string' ? clip(value) : value
  }
  const session = context.session
  return {
    state: {
      event: context.event,
      ...(context.automationName ? { automation: context.automationName } : {}),
      ...(Object.keys(trigger).length > 0 ? { trigger } : {}),
      ...(session
        ? {
            session: {
              ...(session.name ? { name: session.name } : {}),
              ...(session.labels?.length ? { labels: session.labels } : {}),
              ...(session.status ? { status: session.status } : {}),
              ...(session.lastUserMessage ? { last_user_message: clip(session.lastUserMessage) } : {}),
              ...(session.lastAssistantMessage ? { last_assistant_message: clip(session.lastAssistantMessage) } : {}),
            },
          }
        : {}),
    },
    questions: { condition: { type: 'noul', instructions: condition.question } },
  }
}

export interface AutomationConditionVerdict {
  run: boolean
  /** "Yes" probability the model gave. */
  probability: number
}

/** Answer the condition. `null` when switched off, unavailable or failed: run as without it. Never throws. */
export async function checkAutomationCondition(
  condition: SemanticCondition,
  context: AutomationConditionContext,
  /** `sessionId`: the session the event is about, if any; `matcherId` identifies the automation in the record. */
  deps: DecisionPointDeps & { sessionId?: string; matcherId?: string } = {},
): Promise<AutomationConditionVerdict | null> {
  const decide = await openDecisionPoint({ ...deps, feature: 'automationConditions', record: 'automation_condition' })
  if (!decide) return null
  const result = await decide(buildAutomationConditionRequest(condition, context), {
    event: context.event,
    automation: context.automationName,
    ...(deps.matcherId ? { matcherId: deps.matcherId } : {}),
  })
  const answer = result?.answers.condition
  if (!answer || answer.type !== 'noul') {
    recordDecisionOutcome(result, { action: 'run', changed: false, detail: { reason: 'no_answer' } })
    return null
  }
  const threshold = condition.threshold ?? AUTOMATION_CONDITION_DEFAULT_THRESHOLD
  const run = answer.noul >= threshold
  recordDecisionOutcome(result, { action: run ? 'run' : 'skip', changed: !run, detail: { threshold } })
  return { run, probability: answer.noul }
}
