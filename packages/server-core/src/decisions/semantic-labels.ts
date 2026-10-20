/**
 * Decision-model hook for semantic auto-label rules (feature toggle `semanticLabels`).
 *
 * Called fire-and-forget by SessionManager after every user message. The cheap
 * exit comes first (no semantic rules in the tree → no config read at all),
 * then one resolution (Settings switch, feature toggle, key) and one or more
 * `noul` batches via `evaluateSemanticAutoLabels`. Every call is
 * recorded with feature `semantic_labels`; every failure yields no matches.
 */

import type { DecisionResult } from '@memwise/shared/decisions'
import { LabelEntrySet, foldsValueCase, type LabelConfig } from '@memwise/shared/labels'
import { collectSemanticAutoLabelRules, evaluateSemanticAutoLabels, semanticRuleEntry, type AutoLabelMatch } from '@memwise/shared/labels/auto'
import { openDecisionPoint, recordDecisionOutcome, type DecisionPointDeps } from './decision-point'

export interface SemanticLabelsDeps extends DecisionPointDeps {
  sessionId: string
  /** Label entries the session already has (by meaning, see LabelEntrySet): their rules are not asked again (no call, no double count). */
  existingEntries?: readonly string[]
}

/** True when at least one label in the tree carries a semantic rule. Sync and cheap. */
export function hasSemanticAutoLabelRules(labels: LabelConfig[]): boolean {
  return collectSemanticAutoLabelRules(labels).length > 0
}

/**
 * Evaluate the tree's semantic rules against a user message. Returns `[]`
 * whenever the layer is unavailable. Never throws.
 */
export async function evaluateSemanticLabelsForMessage(message: string, labels: LabelConfig[], deps: SemanticLabelsDeps): Promise<AutoLabelMatch[]> {
  // Cheap gate before touching config.json or the vault: most trees have no semantic rules,
  // and a rule whose label the session already carries has nothing left to add.
  const skipEntries = deps.existingEntries ?? []
  const present = new LabelEntrySet(skipEntries, foldsValueCase(labels))
  if (!collectSemanticAutoLabelRules(labels).some(({ label, rule }) => !present.has(semanticRuleEntry(label, rule)))) return []

  const decide = await openDecisionPoint({ ...deps, feature: 'semanticLabels', record: 'semantic_labels' })
  if (!decide) return []
  const results: DecisionResult[] = []
  const matches = await evaluateSemanticAutoLabels(message, labels, async request => {
    const result = await decide(request, { rules: Object.keys(request.questions).length })
    if (result) results.push(result)
    return result
  }, { skipEntries })
  // Large trees take several calls; each gets the message's total (the labels are applied together).
  for (const result of results) {
    recordDecisionOutcome(result, matches.length > 0 ? { action: 'labels', changed: true, detail: { matches: matches.length } } : { action: 'none', changed: false })
  }
  return matches
}
