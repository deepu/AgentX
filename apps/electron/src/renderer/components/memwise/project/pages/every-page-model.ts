/**
 * Stage 4 of the project shell (docs/memwise/26-projects-and-pages.md §2, §5): the model behind
 * the playbook, run and record list pages. Pure functions, so the pages and the tests share them.
 */

import type {
  MwCase, MwCaseSummary, MwDraft, MwDraftSummary, MwPlaybook, MwRecordQueryResult, MwStep, MwTransitionOption,
} from '@memwise/shared/protocol'

const WEEK = 7 * 86_400_000

/** Runs of a playbook this week: those still going, and those finished in the last seven days. */
export function runsThisWeek(cases: MwCaseSummary[] | null | undefined, workflowId: string, now: number): MwCaseSummary[] {
  return (cases ?? [])
    .filter(c => c.workflowId === workflowId && (c.status === 'active' || now - Date.parse(c.updatedAt) <= WEEK))
    .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || b.updatedAt.localeCompare(a.updatedAt))
}

/** The states of a playbook that have a step, in reading order, numbered from 1. */
export function numberedSteps(playbook: Pick<MwPlaybook, 'states' | 'steps'>): { n: number; state: string; step: MwStep }[] {
  const out: { n: number; state: string; step: MwStep }[] = []
  for (const s of playbook.states) {
    const step = s.stepId ? playbook.steps[s.stepId] : undefined
    if (step) out.push({ n: out.length + 1, state: s.id, step })
  }
  return out
}

/** A step's number in its playbook (1-based), or undefined for a state without a step. */
export function stepNumber(playbook: Pick<MwPlaybook, 'states' | 'steps'> | null | undefined, state: string): number | undefined {
  return playbook ? numberedSteps(playbook).find(s => s.state === state)?.n : undefined
}

export type Who = { kind: 'system' | 'agent' | 'you' | 'external' } | { kind: 'role'; role: string }

/** Who does a step, as the page says it: System, Agent, You (a role the person has), or the role. */
export function whoDoes(step: Pick<MwStep, 'performer' | 'assignee'>, myRoles: string[]): Who {
  if (step.performer === 'system') return { kind: 'system' }
  if (step.performer === 'agent') return { kind: 'agent' }
  if (step.performer === 'external') return { kind: 'external' }
  if (step.assignee && !myRoles.includes(step.assignee)) return { kind: 'role', role: step.assignee }
  return { kind: 'you' }
}

export interface StepRow {
  n: number
  state: string
  title: string
  step: MwStep
  /** The draft changes this step: its title in the draft, and the words it adds to the live one. */
  change?: { kind: 'added' | 'changed' | 'removed'; title: string; added?: string; parts: string[] }
}

/**
 * The playbook's steps, with what an open draft changes in each. When the draft's title only adds
 * words to the live one, those words are what the page highlights ("and copy the CRA…").
 */
export function stepRows(live: Pick<MwPlaybook, 'states' | 'steps'>, draft?: Pick<MwDraft, 'structure' | 'playbook'> | null): StepRow[] {
  const rows: StepRow[] = numberedSteps(live).map(s => ({ n: s.n, state: s.state, title: s.step.title, step: s.step }))
  const changes = draft?.structure?.steps ?? {}
  for (const row of rows) {
    const c = changes[row.state]
    if (!c) continue
    const next = draft?.playbook?.steps[row.state]?.title ?? row.title
    const added = next !== row.title && next.startsWith(row.title) ? next.slice(row.title.length).replace(/^[,;]?\s*/, '') : undefined
    row.change = { kind: c.change, title: next, ...(added ? { added } : {}), parts: c.parts }
  }
  // Steps the draft adds, after the live ones.
  if (draft?.playbook) {
    for (const s of numberedSteps(draft.playbook)) {
      if (changes[s.state]?.change !== 'added' || rows.some(r => r.state === s.state)) continue
      rows.push({ n: rows.length + 1, state: s.state, title: s.step.title, step: s.step, change: { kind: 'added', title: s.step.title, parts: changes[s.state]!.parts } })
    }
  }
  return rows
}

/** How many changes a draft makes, counted as the page says them: per step, plus the rest. */
export function draftChangeCount(draft: Pick<MwDraft, 'structure' | 'changedFiles'>): number {
  const s = draft.structure
  if (!s) return draft.changedFiles
  const steps = Object.keys(s.steps).length
  const other = s.caseFields.added.length + s.caseFields.removed.length + s.caseFields.changed.length
    + s.roles.added.length + s.roles.removed.length + s.transitions.length
  const n = steps + other
  return n > 0 ? n : draft.changedFiles
}

/**
 * The draft the playbook page shows: the open draft its chat started (newest), else the newest
 * open change draft of the playbook. Drafts sent for review show too, until they are published.
 */
export function pageDraft(drafts: MwDraftSummary[] | null | undefined, workflowId: string): MwDraftSummary | undefined {
  const open = (drafts ?? []).filter(d => d.workflowId === workflowId && d.kind === 'change' && d.stage !== 'published' && d.stage !== 'discarded')
  const byNewest = [...open].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return byNewest.find(d => d.chatId) ?? byNewest[0]
}

/** Where a run is, for the "This week's runs" table. */
export function runWhere(c: Pick<MwCaseSummary, 'state' | 'stateTitle' | 'status'>, playbook: Pick<MwPlaybook, 'states' | 'steps'> | null | undefined):
  { kind: 'step'; n: number; title: string } | { kind: 'done' } | { kind: 'state'; title: string } {
  if (c.status === 'done') return { kind: 'done' }
  const n = stepNumber(playbook, c.state)
  return n ? { kind: 'step', n, title: c.stateTitle } : { kind: 'state', title: c.stateTitle }
}

// ---------------------------------------------------------------- the run page

export type TimelineStatus = 'done' | 'waiting' | 'running' | 'failed' | 'next' | 'skipped'

export interface TimelineRow {
  n: number
  state: string
  title: string
  step: MwStep
  status: TimelineStatus
  /** The latest step run of this state, when it ran. */
  run?: MwCase['timeline'][number]
}

/** The run's steps in the playbook's order, each with how far it got; the case's current state is the open one. */
export function runTimeline(kase: Pick<MwCase, 'timeline' | 'state' | 'status' | 'path'>, playbook: Pick<MwPlaybook, 'states' | 'steps'>): TimelineRow[] {
  const passed = new Set(kase.path)
  return numberedSteps(playbook).map(s => {
    const runs = kase.timeline.filter(r => r.stepId === s.step.id || r.stepRunId.endsWith(`/${s.state}`))
    const run = runs.at(-1)
    let status: TimelineStatus
    if (run?.status === 'waiting' || (kase.status === 'active' && kase.state === s.state && run?.status !== 'completed')) status = run?.status === 'running' ? 'running' : 'waiting'
    else if (run?.status === 'running') status = 'running'
    else if (run?.status === 'failed' || run?.status === 'needs_person') status = 'failed'
    else if (run?.status === 'completed') status = 'done'
    else status = passed.has(s.state) ? 'skipped' : 'next'
    return { n: s.n, state: s.state, title: s.step.title, step: s.step, status, ...(run ? { run } : {}) }
  })
}

// ---------------------------------------------------------------- record lists

export interface BoardColumn<Row> {
  state: string
  rows: Row[]
  total: number
}

/** Cards by lifecycle state, in the lifecycle's order; rows in no listed state go last. */
export function boardColumns<Row extends { status?: string }>(states: string[], rows: Row[], perColumn = 30): BoardColumn<Row>[] {
  const cols: BoardColumn<Row>[] = states.map(state => ({ state, rows: [], total: 0 }))
  for (const row of rows) {
    const col = cols.find(c => c.state === row.status)
    if (!col) continue
    col.total++
    if (col.rows.length < perColumn) col.rows.push(row)
  }
  return cols
}

/**
 * What dropping a card on a state does: a move the person may make; a signed move, which asks
 * for a signature in its review step; or a refusal with the reason (no such move, or not theirs).
 */
export type DropDecision =
  | { kind: 'same' }
  | { kind: 'move'; transition: MwTransitionOption }
  | { kind: 'sign'; transition: MwTransitionOption }
  | { kind: 'refuse'; reason: 'no-move' | 'automatic' | 'not-allowed'; message?: string; transition?: MwTransitionOption }

export function dropDecision(from: string | undefined, to: string, transitions: MwTransitionOption[]): DropDecision {
  if (from === to) return { kind: 'same' }
  const options = transitions.filter(t => t.to === to)
  const allowed = options.find(t => t.allowed && !t.signed)
  if (allowed) return { kind: 'move', transition: allowed }
  const signed = options.find(t => t.signed)
  if (signed) return { kind: 'sign', transition: signed }
  const first = options[0]
  if (!first) return { kind: 'refuse', reason: 'no-move' }
  if (first.automatic) return { kind: 'refuse', reason: 'automatic', transition: first, ...(first.reason ? { message: first.reason } : {}) }
  return { kind: 'refuse', reason: 'not-allowed', transition: first, ...(first.reason ? { message: first.reason } : {}) }
}

/** The list's columns: the title first, then the status, then the type's own fields (up to `max`). */
export function listColumns(result: Pick<MwRecordQueryResult, 'columns'>, max = 3): MwRecordQueryResult['columns'] {
  return result.columns.filter(c => c.name !== 'id' && c.name !== 'status').slice(0, max)
}

/** The fence a saved page holds for a filtered list (Stage 2's `records` block). */
export function recordsFence(input: { entity: string; filter: string; title: string; columns?: string[]; sort?: { field: string; desc?: boolean }[] }): string {
  const spec = {
    entity: input.entity,
    filter: input.filter,
    ...(input.columns?.length ? { columns: input.columns } : {}),
    ...(input.sort?.length ? { sort: input.sort.map(s => (s.desc ? `-${s.field}` : s.field)) } : {}),
    limit: 50,
    title: input.title,
  }
  return ['```records', JSON.stringify(spec, null, 2), '```'].join('\n')
}
