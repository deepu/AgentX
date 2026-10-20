/**
 * Plain-words labels shared by the playbook view and the map: who does a step, what a state is
 * called, effect classes, policy layers and durations. Every helper takes `t` so nothing is
 * resolved at module level.
 */

import type { TFunction } from 'i18next'
import type { MwEffectClass, MwPlaybook, MwPolicyRule, MwRole, MwState, MwStep, MwToolRef } from '@memwise/shared/protocol'

export const END_STATE = 'end'

export type PerformerTone = 'agent' | 'person' | 'external' | 'system'

/** Tag colours, after the landing-page mockup: agent, person, outside party, automatic. */
export const TONE_CLASSES: Record<PerformerTone, string> = {
  agent: 'bg-accent-tint text-accent',
  person: 'bg-info-tint text-info',
  external: 'bg-fill-selected text-secondary',
  system: 'bg-success-tint text-success',
}

export function humanize(id: string): string {
  return id.replace(/^case\./, '').replace(/[_-]+/g, ' ').trim()
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function roleTitle(roleId: string, roles?: MwRole[]): string {
  return roles?.find((r) => r.id === roleId)?.title ?? capitalize(humanize(roleId))
}

export function stepOf(playbook: MwPlaybook, state: MwState): MwStep | undefined {
  return state.stepId ? playbook.steps[state.stepId] : undefined
}

export function stateTitle(playbook: MwPlaybook, stateId: string, t: TFunction): string {
  if (stateId === END_STATE) return t('memwise.playbook.endTitle')
  const state = playbook.states.find((s) => s.id === stateId)
  const step = state ? stepOf(playbook, state) : playbook.steps[stateId]
  if (step) return step.title
  if (stateId === 'needs_person') return t('memwise.playbook.needsPerson')
  return capitalize(humanize(stateId))
}

export interface PerformerLabel {
  label: string
  tone: PerformerTone
  /** Extra line, e.g. which role handles an outside party's step. */
  note?: string
}

export function performerLabel(step: MwStep | undefined, state: MwState | undefined, t: TFunction, roles?: MwRole[]): PerformerLabel {
  if (!step) {
    // A wait state with no step file: whoever handles its attention items.
    const assignee = state?.assignee
    return { label: assignee ? roleTitle(assignee, roles) : t('memwise.playbook.performer.person'), tone: 'person' }
  }
  switch (step.performer) {
    case 'agent':
      return { label: t('memwise.playbook.performer.agent'), tone: 'agent' }
    case 'system':
      return { label: t('memwise.playbook.performer.system'), tone: 'system' }
    case 'person':
      return { label: step.assignee ? roleTitle(step.assignee, roles) : t('memwise.playbook.performer.person'), tone: 'person' }
    case 'external':
      return {
        label: t('memwise.playbook.performer.external'),
        tone: 'external',
        ...(step.assignee ? { note: t('memwise.playbook.performer.externalHandledBy', { role: roleTitle(step.assignee, roles) }) } : {}),
      }
  }
}

const EFFECT_KEYS: Record<MwEffectClass, string> = {
  read: 'memwise.playbook.effect.read',
  draft: 'memwise.playbook.effect.draft',
  write: 'memwise.playbook.effect.write',
  outbound: 'memwise.playbook.effect.outbound',
  irreversible: 'memwise.playbook.effect.irreversible',
}

export const EFFECT_CLASSES: Record<MwEffectClass, string> = {
  read: 'bg-fill-selected text-secondary',
  draft: 'bg-fill-selected text-secondary',
  write: 'bg-accent-tint text-accent',
  outbound: 'bg-info-tint text-info',
  irreversible: 'bg-destructive-tint text-destructive',
}

export function effectLabel(effect: MwEffectClass, t: TFunction): string {
  return t(EFFECT_KEYS[effect])
}

const LAYER_KEYS: Record<MwPolicyRule['layer'], string> = {
  platform: 'memwise.playbook.layer.platform',
  plugin: 'memwise.playbook.layer.plugin',
  domain: 'memwise.playbook.layer.domain',
  workflow: 'memwise.playbook.layer.workflow',
  step: 'memwise.playbook.layer.step',
}

export function layerLabel(rule: MwPolicyRule, t: TFunction): string {
  return t(LAYER_KEYS[rule.layer], { name: rule.layerName })
}

const SUBJECT_KEYS: Record<string, string> = {
  ...EFFECT_KEYS,
  tokens: 'memwise.playbook.subject.tokens',
  time: 'memwise.playbook.subject.time',
  'model calls': 'memwise.playbook.subject.modelCalls',
  modelCalls: 'memwise.playbook.subject.modelCalls',
  taint: 'memwise.playbook.subject.taint',
  approvers: 'memwise.playbook.subject.approvers',
}

/** Effect classes and budgets get their plain names; anything else (a tool name) shows as written. */
export function subjectLabel(subject: string, t: TFunction): string {
  const key = SUBJECT_KEYS[subject]
  return key ? t(key) : subject
}

export type Treatment = 'allow' | 'preview' | 'approve' | 'deny'

/** Reads a policy value as a treatment, whether written as the code word or in plain words. */
export function treatmentOf(value: string): Treatment | undefined {
  const v = value.trim().toLowerCase()
  if (v === 'allow' || v === 'allowed') return 'allow'
  if (v === 'preview' || v === 'preview first') return 'preview'
  if (v === 'approve' || v === 'needs approval' || v === 'approval') return 'approve'
  if (v === 'deny' || v === 'denied' || v === 'not allowed') return 'deny'
  return undefined
}

const TREATMENT_KEYS: Record<Treatment, string> = {
  allow: 'memwise.playbook.treatment.allow',
  preview: 'memwise.playbook.treatment.preview',
  approve: 'memwise.playbook.treatment.approve',
  deny: 'memwise.playbook.treatment.deny',
}

export function valueLabel(value: string, t: TFunction): string {
  const treatment = treatmentOf(value)
  return treatment ? t(TREATMENT_KEYS[treatment]) : value
}

/** What the step's policy does with a tool: a rule on the tool itself wins over its effect class. */
export function toolTreatment(tool: MwToolRef, policy: MwPolicyRule[]): Treatment | undefined {
  const effect = tool.classified ? tool.effect : 'irreversible'
  const rule =
    policy.find((r) => r.subject === tool.name && !r.notEnforced && treatmentOf(r.value)) ??
    policy.find((r) => r.subject === effect && !r.notEnforced && treatmentOf(r.value))
  return rule ? treatmentOf(rule.value) : undefined
}

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function formatDuration(ms: number, t: TFunction): string {
  if (ms >= DAY && ms % DAY === 0) return t('memwise.playbook.duration.days', { count: ms / DAY })
  if (ms >= DAY) return t('memwise.playbook.duration.days', { count: Math.round((ms / DAY) * 10) / 10 })
  if (ms >= HOUR) return t('memwise.playbook.duration.hours', { count: Math.round(ms / HOUR) })
  return t('memwise.playbook.duration.minutes', { count: Math.max(1, Math.round(ms / MINUTE)) })
}

export interface NextLine {
  kind: 'outcome' | 'remind' | 'timeout'
  text: string
  target?: string
  back?: boolean
}

/** "What happens next" for a state, in plain words. */
export function nextLines(playbook: MwPlaybook, state: MwState, t: TFunction): NextLine[] {
  const order = playbook.states.map((s) => s.id)
  const here = order.indexOf(state.id)
  const lines: NextLine[] = []
  for (const [outcome, target] of Object.entries(state.on)) {
    const title = stateTitle(playbook, target, t)
    const there = order.indexOf(target)
    const back = target !== END_STATE && there !== -1 && there <= here
    const text =
      target === END_STATE
        ? t('memwise.playbook.next.ifEnd', { outcome: humanize(outcome) })
        : back
          ? t('memwise.playbook.next.ifBack', { outcome: humanize(outcome), target: title })
          : t('memwise.playbook.next.if', { outcome: humanize(outcome), target: title })
    lines.push({ kind: 'outcome', text, target, back })
  }
  const wait = state.wait
  if (wait?.remindMs !== undefined && wait.timeout) {
    lines.push({
      kind: 'remind',
      text: t('memwise.playbook.next.remindAndTimeout', {
        remind: formatDuration(wait.remindMs, t),
        timeout: formatDuration(wait.timeout.afterMs, t),
        target: stateTitle(playbook, wait.timeout.target, t),
      }),
      target: wait.timeout.target,
    })
  } else if (wait?.remindMs !== undefined) {
    lines.push({ kind: 'remind', text: t('memwise.playbook.next.remind', { remind: formatDuration(wait.remindMs, t) }) })
  } else if (wait?.timeout) {
    lines.push({
      kind: 'timeout',
      text:
        wait.timeout.target === END_STATE
          ? t('memwise.playbook.next.timeoutEnd', { timeout: formatDuration(wait.timeout.afterMs, t) })
          : t('memwise.playbook.next.timeout', { timeout: formatDuration(wait.timeout.afterMs, t), target: stateTitle(playbook, wait.timeout.target, t) }),
      target: wait.timeout.target,
    })
  }
  return lines
}

/** Case field type for a read like `case.pan`, when the playbook knows it. */
export function readType(playbook: MwPlaybook | undefined, read: string): string | undefined {
  const name = read.replace(/^case\./, '')
  return playbook?.caseFields.find((f) => f.name === name)?.type
}
