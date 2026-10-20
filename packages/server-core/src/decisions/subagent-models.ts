/**
 * Subagent model choice via the decision model (feature toggle `subagentModels`).
 *
 * Before a Claude subagent starts, the model rates its task on a four-level rubric: simple
 * lookups run on Haiku, reading and substantial analysis on Sonnet, and hard reasoning keeps the
 * session's model. The shared side (`core/subagent-model.ts`) applies the pick only to Agent calls
 * that name no model and only when it is cheaper than the session's model; no confident answer
 * leaves the user's Settings default in charge.
 */

import type { SubagentModelPicker, SubagentTask } from '@memwise/shared/agent'
import type { SubagentModel } from '@memwise/shared/config/storage'
import { isDecisionFeatureActive, type DecisionRequest, type DecisionResult } from '@memwise/shared/decisions'
import { FOREGROUND_MAX_DEADLINE_MS, openDecisionPoint, recordDecisionOutcome, type DecisionPointDeps } from './decision-point'

/** The rated level must come with this much confidence. */
export const SUBAGENT_MODEL_MIN_CONFIDENCE = 0.6
/** The task prompt is cut to this many characters before it is sent. */
export const SUBAGENT_MODEL_MAX_PROMPT_CHARS = 4_000

/** Model per rubric level; `session` keeps the session's model. */
const MODEL_BY_LEVEL: readonly (SubagentModel | 'session')[] = ['haiku', 'sonnet', 'sonnet', 'session']

export function buildSubagentTaskRequest(task: SubagentTask): DecisionRequest {
  const prompt = task.prompt.length > SUBAGENT_MODEL_MAX_PROMPT_CHARS ? `${task.prompt.slice(0, SUBAGENT_MODEL_MAX_PROMPT_CHARS)}…` : task.prompt
  return {
    state: {
      task: prompt,
      ...(task.description ? { summary: task.description } : {}),
      ...(task.subagentType ? { agent_type: task.subagentType } : {}),
    },
    questions: {
      demand: {
        type: 'score',
        instructions: 'How capable a model does this delegated task need? The agent works alone with file, search and shell tools and reports back.',
        criteria: [
          'A simple search or lookup: find files, symbols or a fact and say where they are',
          'Reading and summarizing: read some files or pages and report what they say',
          'Substantial work: trace behavior across many files, compare implementations, or write code',
          'Hard reasoning: subtle debugging, architecture, or judgment calls on ambiguous requirements',
        ],
      },
    },
  }
}

/** The pick for one task, on the answer alone: `null` without a confident answer. */
export function chooseSubagentModelLevel(result: DecisionResult | null): SubagentModel | 'session' | null {
  const demand = result?.answers.demand
  if (!demand || demand.type !== 'score' || demand.confidence < SUBAGENT_MODEL_MIN_CONFIDENCE) return null
  return MODEL_BY_LEVEL[Math.min(MODEL_BY_LEVEL.length - 1, Math.max(0, Math.round(demand.score)))]!
}

export interface SubagentModelPickerDeps extends DecisionPointDeps {
  sessionId: string
  /** Synchronous toggle gate; defaults to the `subagentModels` toggle. */
  isActive?: () => boolean
}

export function buildSubagentModelPicker(deps: SubagentModelPickerDeps): SubagentModelPicker {
  return async (task, { configured }) => {
    // Synchronous gate: with the toggle off (the default) an Agent call does no work at all.
    if (!(deps.isActive ?? (() => isDecisionFeatureActive('subagentModels')))()) return null
    // The subagent's start waits on the answer: cap it like the other foreground points.
    const decide = await openDecisionPoint({ ...deps, feature: 'subagentModels', record: 'subagent_models', maxDeadlineMs: FOREGROUND_MAX_DEADLINE_MS })
    if (!decide) return null
    const result = await decide(buildSubagentTaskRequest(task), { agentType: task.subagentType ?? 'general-purpose', configured: configured ?? 'session' })
    const pick = chooseSubagentModelLevel(result)
    // Changed = the subagent runs on another model than the Settings default would give it.
    const fallback = configured ?? 'session'
    recordDecisionOutcome(result, pick
      ? { action: `model:${pick}`, changed: pick !== fallback }
      : { action: 'default', changed: false })
    return pick
  }
}
