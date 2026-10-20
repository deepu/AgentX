/**
 * Pure helpers for the draft screens (Phase 3, docs/memwise/20-phase-3-interfaces.md §8): the
 * stage badge, the changes in plain words, which step a file is, which parts a pending chat edit
 * touched, and a draft file's full text when the draft carries it. No React, no window access.
 */

import type { TFunction } from 'i18next'
import type {
  MwDraft,
  MwDraftEdit,
  MwDraftStage,
  MwDraftSummary,
  MwFileChange,
  MwPlaybook,
  MwStructuralDiff,
} from '@memwise/shared/protocol'
import { humanize, stateTitle } from '../playbook/labels'
import { humanize as words } from '../format'

/** The playbooks that build and change playbooks (20 §3). */
export const META_PLAYBOOKS = ['create-playbook', 'change-playbook'] as const

export function isMetaPlaybook(workflowId: string | undefined): boolean {
  return !!workflowId && (META_PLAYBOOKS as readonly string[]).includes(workflowId)
}

/** A draft still being worked on (shown in lists); published and discarded ones are history. */
export function isOpenDraft(d: Pick<MwDraftSummary, 'stage'>): boolean {
  return d.stage !== 'published' && d.stage !== 'discarded'
}

export type StageTone = 'default' | 'success' | 'warning' | 'destructive' | 'muted'

const STAGE_TONE: Record<MwDraftStage, StageTone> = {
  draft: 'default',
  checked: 'success',
  failed: 'destructive',
  in_review: 'warning',
  published: 'success',
  discarded: 'muted',
}

export function stageTone(stage: MwDraftStage): StageTone {
  return STAGE_TONE[stage]
}

export function stageLabel(stage: MwDraftStage, t: TFunction): string {
  switch (stage) {
    case 'draft': return t('memwise.draft.stage.draft')
    case 'checked': return t('memwise.draft.stage.checked')
    case 'failed': return t('memwise.draft.stage.failed')
    case 'in_review': return t('memwise.draft.stage.inReview')
    case 'published': return t('memwise.draft.stage.published')
    case 'discarded': return t('memwise.draft.stage.discarded')
  }
}

/** Open drafts first (newest first), then the rest. */
export function sortDrafts<T extends Pick<MwDraftSummary, 'stage' | 'updatedAt'>>(drafts: T[]): T[] {
  return [...drafts].sort((a, b) => Number(isOpenDraft(b)) - Number(isOpenDraft(a)) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

// ---------------------------------------------------------------- files

/** `workflows/<id>/steps/<step>.md` → the step id. */
export function stepIdOfPath(path: string): string | undefined {
  const m = /^workflows\/[^/]+\/steps\/([^/]+)\.md$/.exec(path)
  return m?.[1]
}

/** `workflows/<id>/examples/<name>.yaml` → the example's name. */
export function exampleOfPath(path: string): string | undefined {
  const m = /^workflows\/[^/]+\/examples\/([^/]+)\.ya?ml$/.exec(path)
  return m?.[1]
}

/** What a file is, in plain words: a step, the playbook's shape, an example case, the domain. */
export function fileLabel(path: string, t: TFunction, playbook?: MwPlaybook | null, live?: MwPlaybook | null): string {
  const step = stepIdOfPath(path)
  if (step) return t('memwise.draft.file.step', { step: stepName(step, t, playbook, live) })
  const example = exampleOfPath(path)
  if (example) return t('memwise.draft.file.example', { name: words(example) })
  if (/^workflows\/[^/]+\/workflow\.ya?ml$/.test(path)) return t('memwise.draft.file.shape')
  if (/^workflows\/[^/]+\/policy\.ya?ml$/.test(path)) return t('memwise.draft.file.policy')
  if (/^workflows\/[^/]+\/case\.ya?ml$/.test(path)) return t('memwise.draft.file.caseType')
  if (path.startsWith('domain/')) return t('memwise.draft.file.domain')
  return path
}

/** A step's title from the draft, else the live playbook, else its id in words. */
export function stepName(stepId: string, t: TFunction, playbook?: MwPlaybook | null, live?: MwPlaybook | null): string {
  if (playbook?.steps[stepId] || playbook?.states.some(s => s.id === stepId)) return stateTitle(playbook, stepId, t)
  if (live?.steps[stepId] || live?.states.some(s => s.id === stepId)) return stateTitle(live, stepId, t)
  if (playbook) return stateTitle(playbook, stepId, t)
  return humanize(stepId)
}

/**
 * A file's full text in the draft, when the draft carries it: `fileTexts` (every file of the
 * draft's playbook, by path), a file change's `after`, or a newly added file (its one hunk is the
 * whole file). Undefined when only the changed lines are known.
 */
export function draftFileText(draft: MwDraft, path: string): string | undefined {
  const texts = (draft as MwDraft & { fileTexts?: Record<string, string> }).fileTexts
  if (texts && typeof texts[path] === 'string') return texts[path]
  const change = draft.files.find(f => f.path === path) as (MwFileChange & { after?: string }) | undefined
  if (!change) return undefined
  if (typeof change.after === 'string') return change.after
  if (change.status === 'added' && change.hunks.length === 1) {
    const hunk = change.hunks[0]!
    if (hunk.oldLines === 0 && hunk.newStart <= 1 && hunk.lines.every(l => l.kind === 'added')) {
      return hunk.lines.map(l => l.text).join('\n') + '\n'
    }
  }
  return undefined
}

// ---------------------------------------------------------------- pending chat edits

/** Chat edits waiting for the person to keep or discard them. */
export function pendingEdits(draft: Pick<MwDraft, 'edits'>): MwDraftEdit[] {
  return draft.edits.filter(e => e.status === 'pending')
}

/** The pending edits that touched a file. */
export function pendingEditsForPath(draft: Pick<MwDraft, 'edits'>, path: string): MwDraftEdit[] {
  return pendingEdits(draft).filter(e => e.paths.includes(path))
}

/** Step ids a pending edit touched (through their step files). */
export function stepsTouchedBy(edit: Pick<MwDraftEdit, 'paths'>): string[] {
  return edit.paths.map(stepIdOfPath).filter((s): s is string => !!s)
}

// ---------------------------------------------------------------- changes in plain words

export interface ChangeLine {
  kind: 'added' | 'removed' | 'changed' | 'info'
  text: string
  /** The step it is about, for highlighting and jumping to it. */
  step?: string
}

const PART_KEYS: Record<string, string> = {
  title: 'memwise.draft.part.title',
  performer: 'memwise.draft.part.performer',
  engine: 'memwise.draft.part.engine',
  strictness: 'memwise.draft.part.strictness',
  assignee: 'memwise.draft.part.assignee',
  instructions: 'memwise.draft.part.instructions',
  reads: 'memwise.draft.part.reads',
  writes: 'memwise.draft.part.writes',
  tools: 'memwise.draft.part.tools',
  model: 'memwise.draft.part.model',
  budget: 'memwise.draft.part.budget',
  checkpoint: 'memwise.draft.part.checkpoint',
  outcomes: 'memwise.draft.part.outcomes',
  map: 'memwise.draft.part.map',
  outcomeFrom: 'memwise.draft.part.outcomeFrom',
  policy: 'memwise.draft.part.policy',
}

/** A step part in plain words ("what it may use"); unknown parts in words. */
export function partLabel(part: string, t: TFunction): string {
  const key = PART_KEYS[part]
  return key ? t(key) : humanize(part)
}

const PLAYBOOK_PART_KEYS: Record<string, string> = {
  title: 'memwise.draft.playbookPart.title',
  owner: 'memwise.draft.playbookPart.owner',
  policy: 'memwise.draft.playbookPart.policy',
  start: 'memwise.draft.playbookPart.start',
}

function joinList(items: string[], lang?: string): string {
  if (items.length < 2) return items[0] ?? ''
  try {
    return new Intl.ListFormat(lang, { type: 'conjunction' }).format(items)
  } catch {
    return items.join(', ')
  }
}

const quoteAll = (names: string[]) => names.map(n => `“${n}”`)

/**
 * What a draft changes, in plain words, from its structure: the version, the playbook's own
 * fields, each step added, removed or changed (with the parts), what the steps must use, the
 * routes between steps, case fields, roles and example cases.
 */
export function changeLines(
  structure: MwStructuralDiff,
  t: TFunction,
  draftPlaybook?: MwPlaybook | null,
  livePlaybook?: MwPlaybook | null,
  lang?: string,
): ChangeLine[] {
  const out: ChangeLine[] = []
  const name = (id: string) => stepName(id, t, draftPlaybook, livePlaybook)
  const target = (id: string) => (id === 'end' ? t('memwise.playbook.endTitle') : name(id))

  const { from, to } = structure.version
  if (from === undefined && to !== undefined) out.push({ kind: 'info', text: t('memwise.draft.changes.newPlaybook', { version: to }) })
  else if (from !== undefined && to !== undefined && from !== to) out.push({ kind: 'info', text: t('memwise.draft.changes.version', { from, to }) })

  for (const part of structure.playbook) {
    const key = PLAYBOOK_PART_KEYS[part]
    out.push({ kind: 'changed', text: key ? t(key) : t('memwise.draft.changes.playbookPart', { part: humanize(part) }) })
  }

  // Steps in the draft's reading order, then removed ones
  const order = [...(draftPlaybook?.states.map(s => s.id) ?? []), ...(livePlaybook?.states.map(s => s.id) ?? [])]
  const rank = (id: string) => { const i = order.indexOf(id); return i === -1 ? order.length : i }
  const stepIds = Object.keys(structure.steps).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  for (const id of stepIds) {
    const step = structure.steps[id]!
    if (step.change === 'added') out.push({ kind: 'added', step: id, text: t('memwise.draft.changes.stepAdded', { step: name(id) }) })
    else if (step.change === 'removed') out.push({ kind: 'removed', step: id, text: t('memwise.draft.changes.stepRemoved', { step: name(id) }) })
    else {
      const parts = step.parts.length ? joinList(step.parts.map(p => partLabel(p, t)), lang) : t('memwise.draft.part.something')
      out.push({ kind: 'changed', step: id, text: t('memwise.draft.changes.stepChanged', { step: name(id), parts }) })
    }
  }
  // States without a step file (waits) that were added or removed
  for (const [id, change] of Object.entries(structure.states)) {
    if (structure.steps[id] || change === 'changed') continue
    out.push({ kind: change, step: id, text: t(change === 'added' ? 'memwise.draft.changes.stateAdded' : 'memwise.draft.changes.stateRemoved', { step: name(id) }) })
  }

  for (const r of structure.requiredTools) {
    out.push({
      kind: r.change,
      step: r.step,
      text: t(r.change === 'added' ? 'memwise.draft.changes.requiredAdded' : 'memwise.draft.changes.requiredRemoved', { step: name(r.step), tool: r.tool }),
    })
  }
  if (structure.tools.added.length) out.push({ kind: 'added', text: t('memwise.draft.changes.toolsAdded', { tools: joinList(structure.tools.added, lang) }) })
  if (structure.tools.removed.length) out.push({ kind: 'removed', text: t('memwise.draft.changes.toolsRemoved', { tools: joinList(structure.tools.removed, lang) }) })

  for (const tr of structure.transitions) {
    const outcome = tr.event === 'timeout' ? t('memwise.draft.changes.timeoutEvent') : humanize(tr.event)
    out.push({
      kind: tr.change,
      step: tr.from,
      text: t(tr.change === 'added' ? 'memwise.draft.changes.routeAdded' : 'memwise.draft.changes.routeRemoved', { step: name(tr.from), outcome, target: target(tr.to) }),
    })
  }

  const fields = structure.caseFields
  if (fields.added.length) out.push({ kind: 'added', text: t('memwise.draft.changes.fieldsAdded', { fields: joinList(quoteAll(fields.added.map(humanize)), lang) }) })
  if (fields.removed.length) out.push({ kind: 'removed', text: t('memwise.draft.changes.fieldsRemoved', { fields: joinList(quoteAll(fields.removed.map(humanize)), lang) }) })
  if (fields.changed.length) out.push({ kind: 'changed', text: t('memwise.draft.changes.fieldsChanged', { fields: joinList(quoteAll(fields.changed.map(humanize)), lang) }) })

  if (structure.roles.added.length) out.push({ kind: 'added', text: t('memwise.draft.changes.rolesAdded', { roles: joinList(structure.roles.added.map(words), lang) }) })
  if (structure.roles.removed.length) out.push({ kind: 'removed', text: t('memwise.draft.changes.rolesRemoved', { roles: joinList(structure.roles.removed.map(words), lang) }) })

  const ex = structure.examples
  if (ex.added.length) out.push({ kind: 'added', text: t('memwise.draft.changes.examplesAdded', { names: joinList(quoteAll(ex.added.map(exampleName)), lang) }) })
  if (ex.removed.length) out.push({ kind: 'removed', text: t('memwise.draft.changes.examplesRemoved', { names: joinList(quoteAll(ex.removed.map(exampleName)), lang) }) })
  if (ex.changed.length) out.push({ kind: 'changed', text: t('memwise.draft.changes.examplesChanged', { names: joinList(quoteAll(ex.changed.map(exampleName)), lang) }) })
  return out
}

/** `missing-pan.yaml` → "Missing PAN". */
function exampleName(file: string): string {
  return words(file.replace(/\.ya?ml$/, ''))
}

/** The parts of a step that differ from the live playbook (for the editor's highlights). */
export function changedParts(structure: MwStructuralDiff | undefined, stepId: string): Set<string> {
  const step = structure?.steps[stepId]
  return new Set(step?.parts ?? [])
}

/** Lines a file change adds and removes, for its header. */
export function lineCounts(file: MwFileChange): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const h of file.hunks) for (const l of h.lines) {
    if (l.kind === 'added') added++
    else if (l.kind === 'removed') removed++
  }
  return { added, removed }
}
