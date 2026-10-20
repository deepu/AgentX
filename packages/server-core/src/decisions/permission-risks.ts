/**
 * Risk badges on permission prompts via the decision model (feature toggle `riskBadges`).
 *
 * Before a permission prompt is shown, a handful of yes/no questions ask what
 * the action does (deletes data, sends something out, publishes, touches
 * secrets, changes the system, spends money). Answers at or above the
 * threshold become badges on the prompt. Informational only: the prompt, its
 * buttons and its outcome are unchanged, and no answer means no badges.
 */

import type { PermissionRisk } from '@memwise/core/types'
import type { DecisionRequest, DecisionResult } from '@memwise/shared/decisions'
import { openDecisionPoint, recordDecisionOutcome, type DecisionPointDeps } from './decision-point'

/** "Yes" probability that shows a badge. */
export const PERMISSION_RISK_THRESHOLD = 0.75
/** What the prompt shows is cut to this many characters before it is sent. */
export const PERMISSION_RISK_MAX_CHARS = 4_000

const QUESTIONS: Record<PermissionRisk, string> = {
  deletes: 'Does this action delete, overwrite or destroy files or data?',
  sends: 'Does this action send data, files or messages to another person, service or server?',
  publishes: 'Does this action publish, deploy or push changes that other people will see?',
  credentials: 'Does this action read, print, change or transmit passwords, tokens, keys or other secrets?',
  system: 'Does this action change system settings, install or remove software, or need administrator rights?',
  spends: 'Does this action spend money, make a purchase or change billing?',
}

const RISKS = Object.keys(QUESTIONS) as PermissionRisk[]

export interface PermissionPromptSummary {
  toolName: string
  description: string
  command?: string
}

export function buildPermissionRiskRequest(prompt: PermissionPromptSummary): DecisionRequest {
  const clip = (text: string) => (text.length > PERMISSION_RISK_MAX_CHARS ? `${text.slice(0, PERMISSION_RISK_MAX_CHARS)}…` : text)
  return {
    state: {
      tool: prompt.toolName,
      description: clip(prompt.description),
      ...(prompt.command ? { command: clip(prompt.command) } : {}),
    },
    questions: Object.fromEntries(RISKS.map(risk => [risk, { type: 'noul' as const, instructions: QUESTIONS[risk] }])),
  }
}

/** Badges at or above the threshold, in a fixed order; `null` without a result. */
export function readPermissionRisks(result: DecisionResult | null): PermissionRisk[] | null {
  if (!result) return null
  return RISKS.filter(risk => {
    const answer = result.answers[risk]
    return answer?.type === 'noul' && answer.noul >= PERMISSION_RISK_THRESHOLD
  })
}

export interface PermissionRiskDeps extends DecisionPointDeps {
  sessionId?: string
}

/** Badges for a prompt; `null` when switched off, unavailable or failed. Never throws. */
export async function assessPermissionRisks(prompt: PermissionPromptSummary, deps: PermissionRiskDeps = {}): Promise<PermissionRisk[] | null> {
  const decide = await openDecisionPoint({ ...deps, feature: 'riskBadges', record: 'risk_badges' })
  if (!decide) return null
  const result = await decide(buildPermissionRiskRequest(prompt), { tool: prompt.toolName })
  const risks = readPermissionRisks(result)
  recordDecisionOutcome(result, risks && risks.length > 0
    ? { action: 'badges', changed: true, detail: { risks } }
    : { action: 'none', changed: false })
  return risks
}
