import type { AgentEventUsage } from '@memwise/core/types'

/** The cumulative counters of a session's token usage that a turn adds to. */
export interface CumulativeUsage {
  outputTokens: number
  costUsd: number
  lastRunningTotals?: { costUsd: number; outputTokens: number }
}

/**
 * Add one turn's output tokens and cost to a session's cumulative usage.
 *
 * Backends that report running totals (Claude's `total_cost_usd`/`modelUsage` keep growing across
 * turns and resumes) add only the change since the totals counted last: summing them counted every
 * earlier turn again on each new one. Totals below the last ones mean the backend started counting
 * again (/clear, a new SDK session) and count in full; all-zero totals (crash/startup results) carry
 * nothing and are skipped.
 */
export function addTurnUsage(target: CumulativeUsage, usage: AgentEventUsage): void {
  const totals = usage.runningTotals
  if (!totals) {
    target.outputTokens += usage.outputTokens
    target.costUsd += usage.costUsd ?? 0
    return
  }
  if (totals.costUsd <= 0 && totals.outputTokens <= 0) return

  const last = target.lastRunningTotals
  const base = last && totals.costUsd >= last.costUsd && totals.outputTokens >= last.outputTokens
    ? last
    : { costUsd: 0, outputTokens: 0 }
  target.outputTokens += totals.outputTokens - base.outputTokens
  target.costUsd += totals.costUsd - base.costUsd
  target.lastRunningTotals = { ...totals }
}

/** What a branch's starting totals are read from: the session it was branched from. */
export interface BranchParent {
  sdkSessionId?: string
  tokenUsage?: Pick<CumulativeUsage, 'lastRunningTotals'>
}

/**
 * The running totals a branch starts from once its fork of the parent's SDK session is established.
 *
 * A fork's first result carries the total saved in the parent's transcript, and the CLI saves it
 * when its process exits: a parent that has exited hands over its latest total, a parent still
 * running hands over none. Starting from the parent's counted totals covers both: the first is
 * counted as a change and the parent's cost isn't counted again, the second falls below them and
 * counts in full. A parent that has moved to another SDK session since counts a different
 * transcript, so its totals aren't used.
 */
export function branchStartTotals(
  parent: BranchParent | null | undefined,
  forkedSdkSessionId: string,
): CumulativeUsage['lastRunningTotals'] {
  const totals = parent?.sdkSessionId === forkedSdkSessionId ? parent.tokenUsage?.lastRunningTotals : undefined
  return totals ? { ...totals } : undefined
}
