/**
 * Targeted task repairs via the decision model (feature toggle `taskRepairs`).
 *
 * When a task verifier answers FAIL with a reason but names no subtasks, the
 * Conductor used to re-run the whole DAG. Here the model reads the reason and
 * answers, per subtask, whether the failure points at it; only those (and their
 * dependents) are repaired. No answer, or no subtask above the threshold, means
 * the whole DAG as before. Scoping only: FAIL still means repair, and the
 * repair budget is unchanged.
 */

import { DECISION_MAX_QUESTIONS_PER_CALL, type DecisionRequest, type DecisionResult } from '@memwise/shared/decisions'
import type { RepairScopeFn } from '../tasks/TaskRunner'
import { openDecisionPoint, recordDecisionOutcome, type DecisionPointDeps } from './decision-point'

/** A subtask counts as implicated at this "yes" probability. */
export const REPAIR_NODE_THRESHOLD = 0.7
/** One yes/no per subtask in a single call; a larger task is repaired whole. */
export const REPAIR_MAX_NODES = DECISION_MAX_QUESTIONS_PER_CALL
/** The failure reason is cut to this many characters. */
export const REPAIR_MAX_REASON_CHARS = 4_000
/** Each subtask description is cut to this many characters. */
export const REPAIR_MAX_DESCRIPTION_CHARS = 300

const KEY_PREFIX = 'implicated:'

export interface RepairCandidate {
  id: string
  description: string
}

export function buildRepairScopeRequest(reason: string, nodes: readonly RepairCandidate[]): DecisionRequest {
  const questions: DecisionRequest['questions'] = {}
  for (const node of nodes.slice(0, REPAIR_MAX_NODES)) {
    questions[`${KEY_PREFIX}${node.id}`] = {
      type: 'noul',
      instructions: `Does the failure reason point at this subtask needing rework? Subtask "${node.id}": ${node.description.slice(0, REPAIR_MAX_DESCRIPTION_CHARS)}`,
    }
  }
  return { state: { failure_reason: reason.slice(0, REPAIR_MAX_REASON_CHARS) }, questions }
}

/** Subtasks at or above the threshold; `null` when none are (or there is no result). */
export function readRepairScope(result: DecisionResult | null): string[] | null {
  if (!result) return null
  const nodes = Object.entries(result.answers)
    .filter(([key, answer]) => key.startsWith(KEY_PREFIX) && answer.type === 'noul' && answer.noul >= REPAIR_NODE_THRESHOLD)
    .map(([key]) => key.slice(KEY_PREFIX.length))
  return nodes.length > 0 ? nodes : null
}

/** Conductor seam: which subtasks a FAIL reason implicates, recorded with the run context. */
export function buildRepairScopePicker(deps: DecisionPointDeps = {}): RepairScopeFn {
  return async (reason, nodes, context) => {
    if (!reason.trim() || nodes.length === 0 || nodes.length > REPAIR_MAX_NODES) return null
    const decide = await openDecisionPoint({ ...deps, feature: 'taskRepairs', record: 'task_repairs' })
    if (!decide) return null
    const result = await decide(buildRepairScopeRequest(reason, nodes), { slug: context.slug, runId: context.runId, nodes: nodes.length })
    const scope = readRepairScope(result)
    recordDecisionOutcome(result, scope
      ? { action: 'scoped', changed: true, detail: { repair: scope.length, of: nodes.length } }
      : { action: 'whole_dag', changed: false })
    return scope
  }
}
