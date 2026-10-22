/**
 * Pure helpers for the Stage 3 screens (26 §3): the app home's cells, Waiting for you's rows and
 * groups, and the words a project's template and people read in. No React, no host calls.
 */

import type { TFunction } from 'i18next'
import type { MwAppHome, MwInboxItem, MwProjectDetail, MwTemplateUpdateItem, MwWaitingGroup } from '@memwise/shared/protocol'
import { formatDate, formatPercent } from '../records/record-model'
import { humanize, inboxItemStepTitle } from '../format'

/** One app home cell: a number, a percent, a setting as written, or "n/a" when there is nothing to count. */
export function homeCell(value: number | string | null | undefined, format: 'number' | 'percent' | undefined, t: TFunction, locale?: string): string {
  if (value === null || value === undefined || value === '') return t('memwise.projects.na')
  if (typeof value === 'string') return value
  return format === 'percent' ? formatPercent(Math.round(value), locale) : new Intl.NumberFormat(locale).format(value)
}

/** "Inspection 16 Nov", "Draft · Jan": a row's next milestone. */
export function nextLabel(row: MwAppHome['rows'][number], t: TFunction, locale?: string): string {
  const when = row.next?.date ? shortDate(row.next.date, locale) : undefined
  const label = row.next ? [row.next.label, when].filter(Boolean).join(' ') : undefined
  if (row.status === 'draft') return label ? t('memwise.projects.home.draftNext', { next: label }) : t('memwise.projects.status.draft')
  if (row.status === 'archived') return t('memwise.projects.status.archived')
  return label ?? '—'
}

export function shortDate(value: string, locale?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return formatDate(value, locale)
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d)
}

/** The value a project's study tile shows: how many studies, and how many run, are drafts. */
export function homeTotalsDetail(home: MwAppHome, t: TFunction): string {
  const parts = [t('memwise.projects.home.running', { count: home.totals.active })]
  if (home.totals.draft) parts.push(t('memwise.projects.home.drafts', { count: home.totals.draft }))
  if (home.totals.archived) parts.push(t('memwise.projects.home.archivedCount', { count: home.totals.archived }))
  return parts.join(', ')
}

/** "8 in MW-301 · 61 in MW-207": who is the bottleneck. */
export function bottleneckLine(b: MwAppHome['bottlenecks'][number], t: TFunction): string {
  return b.waiting.map((w) => t('memwise.projects.home.inProject', { count: w.count, project: w.projectName })).join(' · ')
}

/** The heading line of an inbox item and the line under it. */
export function itemTitle(item: MwInboxItem, t?: TFunction): { title: string; detail?: string } {
  if (item.kind === 'approval') return { title: item.preview.summary || item.stepTitle, detail: item.caseTitle }
  const step = inboxItemStepTitle(item, t)
  if (step && step !== item.caseTitle) return { title: step, detail: item.caseTitle }
  return { title: item.caseTitle }
}

export function itemDue(item: MwInboxItem): string | undefined {
  return 'dueAt' in item && typeof item.dueAt === 'string' ? item.dueAt : undefined
}

/** How many rows of a group show before "N more in …". */
export const GROUP_SHOWN = 2

/** A group's rows: its template updates first (they are rare and decide what runs), then the items. */
export function groupRows(group: MwWaitingGroup): ({ kind: 'update'; update: MwTemplateUpdateItem } | { kind: 'item'; item: MwInboxItem })[] {
  return [
    ...group.updates.map((update) => ({ kind: 'update' as const, update })),
    ...group.items.map((item) => ({ kind: 'item' as const, item })),
  ]
}

export function groupCount(group: MwWaitingGroup): number {
  return group.items.length + group.updates.length
}

/** Groups in the order the page shows them: most waiting first, then by app and name; empty ones go. */
export function sortGroups(groups: MwWaitingGroup[]): MwWaitingGroup[] {
  return groups.filter((g) => groupCount(g) > 0)
    .sort((a, b) => groupCount(b) - groupCount(a) || a.appTitle.localeCompare(b.appTitle) || a.projectName.localeCompare(b.projectName))
}

/** The parts of a template update item's id: `template-update:<projectId>:<to>`. */
export function parseUpdateItemId(id: string): { projectId: string; to: number } | undefined {
  const m = /^template-update:([^:]+):(\d+)$/.exec(id)
  return m ? { projectId: m[1]!, to: Number(m[2]) } : undefined
}

/** "Started from Phase 3 study, version 4 · this project changed 2 playbooks". */
export function templateLine(p: MwProjectDetail, t: TFunction): string {
  const changed = new Set(p.overrides.map((o) => o.workflow ?? o.path)).size
  const from = p.from && 'project' in p.from
    ? t('memwise.projects.settings.copiedFrom', { project: p.from.project, version: p.templateVersion })
    : p.templateTitle
      ? t('memwise.projects.settings.startedFrom', { template: p.templateTitle, version: p.templateVersion })
      : t('memwise.projects.settings.startedBlank', { version: p.templateVersion })
  return changed ? `${from} · ${t('memwise.projects.settings.changed', { count: changed })}` : from
}

/** "Study manager · owner": a person's roles in the project, by role title, and their note. */
export function personRoles(person: MwProjectDetail['people'][number], roleTitle: (id: string) => string): string {
  return [person.roles.map(roleTitle).join(', '), person.note].filter(Boolean).join(' · ')
}

/** A name for an id typed by a person: "Study MW-310" → `study-mw-310` (the server makes the same). */
export function slugOf(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s)

/** Where a new project starts from: a template card, a copy of a project, or blank. */
export type ProjectSource = { kind: 'template'; id: string } | { kind: 'copy'; project: string } | { kind: 'blank' }

/** A draft's lists: its pages and playbooks, what it leaves out of its template, and its record types. */
export function draftLists(p: Pick<MwProjectDetail, 'pages' | 'playbooks' | 'without' | 'recordTypes'>): {
  pages: string[]
  pagesLeftOut: string[]
  playbooks: string[]
  playbooksLeftOut: string[]
  records: string[]
} {
  const left = (dir: string) => p.without.filter((w) => w.startsWith(`${dir}/`)).map((w) => humanize(w.slice(dir.length + 1)))
  return {
    pages: p.pages.map((x) => x.title),
    pagesLeftOut: left('pages'),
    playbooks: p.playbooks.map((x) => x.title),
    playbooksLeftOut: left('workflows'),
    records: p.recordTypes.map((x) => x.name),
  }
}

/** "Anika Rao, study manager · Priya Shah, CRA": the draft's people in one line. */
export function peopleLine(people: MwProjectDetail['people'], roleTitle: (id: string) => string): string {
  return people.map((p) => [p.name ?? p.email, p.roles.map((r) => lowerFirst(roleTitle(r))).join(', ')].filter(Boolean).join(', ')).join(' · ')
}

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s)
