/**
 * Pages in plain words (docs/memwise/26-projects-and-pages.md §4): a page's body cut into its
 * sections (so "Changed from chat · Undo" can mark the ones a chat changed), the refresh schedule
 * ("Refreshes every Monday"), the history line ("1 June, ATTAIN-MAINTAIN added, accepted by
 * Leah · 25 May, nothing new"), where an answer change came from ("From the page's Monday
 * refresh"), and the project's pages as a tree for the sidebar.
 */
import type { TFunction } from 'i18next'
import type { MwPageChangeFrom, MwPageHistoryEntry, MwPageSummary } from '@memwise/shared/protocol'

export interface PageSection {
  /** Absent for the text before the first `##` heading (the headline and what follows it). */
  heading?: string
  markdown: string
}

const FENCE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n?\1[ \t]*$/gm

/** The body cut at its `##` headings; headings inside fenced blocks don't count (as the kernel cuts it). */
export function splitSections(body: string): PageSection[] {
  const fences = [...body.matchAll(FENCE)].map(m => [m.index!, m.index! + m[0].length] as const)
  const inFence = (i: number) => fences.some(([a, b]) => i >= a && i < b)
  const cuts: { at: number; end: number; heading: string }[] = []
  for (const m of body.matchAll(/^##[ \t]+(.+?)[ \t#]*$/gm)) {
    if (!inFence(m.index!)) cuts.push({ at: m.index!, end: m.index! + m[0].length, heading: m[1]!.trim() })
  }
  const out: PageSection[] = []
  const pre = body.slice(0, cuts[0]?.at ?? body.length).trim()
  if (pre) out.push({ markdown: pre })
  cuts.forEach((c, i) => out.push({ heading: c.heading, markdown: body.slice(c.end, cuts[i + 1]?.at ?? body.length).trim() }))
  return out
}

/** The first section's first paragraph is the page's headline: everything before the first fence, table or heading in it. */
export function splitHeadline(markdown: string): { headline: string; rest: string } {
  const paras = markdown.split(/\n\s*\n/)
  const first = paras[0] ?? ''
  if (!first.trim() || /^(#|\||>|```|~~~|[-*]\s|\d+\.\s|<)/.test(first.trim())) return { headline: '', rest: markdown }
  return { headline: first.trim(), rest: paras.slice(1).join('\n\n').trim() }
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
const WEEKDAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

/** A weekday's name in the person's language (`mon` → "Monday"). */
export function weekdayName(every: string, lang: string): string | undefined {
  const i = WEEKDAY_INDEX[every.slice(0, 3).toLowerCase()]
  if (i === undefined) return undefined
  // 4 Jan 1970 was a Sunday.
  return new Intl.DateTimeFormat(lang, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(1970, 0, 4 + i)))
}

/** "Refreshes every Monday", "Refreshes every day", "Refreshes every month". */
export function refreshLabel(every: string | undefined, t: TFunction, lang: string): string {
  if (!every) return t('memwise.pages.keptNoSchedule')
  if (every === 'daily') return t('memwise.pages.refreshesDaily')
  if (every === 'month') return t('memwise.pages.refreshesMonthly')
  return t('memwise.pages.refreshesOn', { day: weekdayName(every, lang) ?? every })
}

export function shortDate(iso: string, lang: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'long' }).format(d)
}

/** "Mon 1 June". */
export function dayDate(iso: string, lang: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat(lang, { weekday: 'short', day: 'numeric', month: 'long' }).format(d)
}

/** "Mon" this week, else "1 May": when a page in the kept table last refreshed. */
export function refreshedWhen(iso: string | undefined, lang: string, now = new Date()): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  if (now.getTime() - d.getTime() < 6 * 86_400_000 && d.getTime() <= now.getTime() + 60_000) {
    return new Intl.DateTimeFormat(lang, { weekday: 'short' }).format(d)
  }
  return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short' }).format(d)
}

/** One history entry in a few words: "ATTAIN-MAINTAIN added, accepted by Leah", "nothing new", "made from Omar's question". */
export function historyText(h: MwPageHistoryEntry, t: TFunction): string {
  const by = h.byName
  switch (h.kind) {
    case 'accepted': return by ? t('memwise.pages.history.accepted', { text: h.text ?? t('memwise.pages.history.anUpdate'), name: by }) : (h.text ?? t('memwise.pages.history.anUpdate'))
    case 'sent_back': return by ? t('memwise.pages.history.sentBackBy', { name: by }) : t('memwise.pages.history.sentBack')
    case 'nothing_new': return t('memwise.pages.history.nothingNew')
    case 'asked': return by ? t('memwise.pages.history.askedBy', { name: by }) : t('memwise.pages.history.asked')
    case 'made': return by ? t('memwise.pages.history.madeBy', { name: by }) : t('memwise.pages.history.made')
    case 'chat': return h.text && h.text !== 'Changed from chat' ? t('memwise.pages.history.chatWhat', { text: h.text }) : t('memwise.pages.history.chat')
    case 'undo': return by ? t('memwise.pages.history.undoBy', { name: by }) : t('memwise.pages.history.undo')
    case 'refresh': return h.text ?? t('memwise.pages.history.refresh')
    default: return h.text ?? (by ? t('memwise.pages.history.changedBy', { name: by }) : t('memwise.pages.history.changed'))
  }
}

/** Where an answer change came from: "From the page's Monday refresh", "From a refresh Leah asked for". */
export function changeFromLabel(from: MwPageChangeFrom | undefined, t: TFunction, lang: string): string {
  if (!from) return t('memwise.pages.from.refresh')
  if (from.kind === 'summary') return t('memwise.pages.from.summary')
  if (from.kind === 'manual') return from.byName ? t('memwise.pages.from.manualBy', { name: from.byName }) : t('memwise.pages.from.manual')
  if (from.every === 'daily') return t('memwise.pages.from.daily')
  if (from.every === 'month') return t('memwise.pages.from.monthly')
  const day = from.every ? weekdayName(from.every, lang) : undefined
  return day ? t('memwise.pages.from.weekly', { day }) : t('memwise.pages.from.refresh')
}

/** "found by Monday's refresh, 1 June". */
export function foundByLabel(from: MwPageChangeFrom | undefined, at: string, t: TFunction, lang: string): string {
  const when = shortDate(at, lang)
  const day = from?.kind === 'schedule' && from.every ? weekdayName(from.every, lang) : undefined
  if (day) return t('memwise.pages.change.foundByDay', { day, when })
  if (from?.kind === 'manual') return from.byName ? t('memwise.pages.change.foundAskedBy', { name: from.byName, when }) : t('memwise.pages.change.foundManual', { when })
  if (from?.kind === 'summary') return t('memwise.pages.change.foundSummary', { when })
  return t('memwise.pages.change.foundRefresh', { when })
}

/** "Found by Monday's refresh", "Found by a refresh Leah asked for": the What-changed card's footnote. */
export function foundByShort(from: MwPageChangeFrom | undefined, t: TFunction, lang: string): string {
  const day = from?.kind === 'schedule' && from.every ? weekdayName(from.every, lang) : undefined
  if (day) return t('memwise.pages.whatChanged.foundByDay', { day })
  if (from?.kind === 'schedule' && from.every === 'daily') return t('memwise.pages.whatChanged.foundDaily')
  if (from?.kind === 'schedule' && from.every === 'month') return t('memwise.pages.whatChanged.foundMonthly')
  if (from?.kind === 'manual') return from.byName ? t('memwise.pages.whatChanged.foundAskedBy', { name: from.byName }) : t('memwise.pages.whatChanged.foundManual')
  if (from?.kind === 'summary') return t('memwise.pages.whatChanged.foundSummary')
  return t('memwise.pages.whatChanged.foundRefresh')
}

/** A page in the sidebar's PAGES tree. */
export interface PageTreeRow {
  page: MwPageSummary
  depth: number
  hasChildren: boolean
}

/** The project's pages as the sidebar shows them: parents before their sub-pages, with depth; collapsed parents hide theirs. */
export function pageTree(pages: MwPageSummary[], collapsed: ReadonlySet<string> = new Set()): PageTreeRow[] {
  const ids = new Set(pages.map(p => p.id))
  const byParent = new Map<string, MwPageSummary[]>()
  for (const p of pages) {
    const k = p.parent && ids.has(p.parent) ? p.parent : ''
    byParent.set(k, [...(byParent.get(k) ?? []), p])
  }
  const out: PageTreeRow[] = []
  const walk = (k: string, depth: number) => {
    for (const p of byParent.get(k) ?? []) {
      const kids = byParent.get(p.id) ?? []
      out.push({ page: p, depth, hasChildren: kids.length > 0 })
      if (!collapsed.has(p.id) && depth < 20) walk(p.id, depth + 1)
    }
  }
  walk('', 0)
  return out
}

/** "GLP-1 › Weight loss": a page's title under its parent's. */
export function pathTitle(page: MwPageSummary, pages: MwPageSummary[]): { parents: string[]; title: string } {
  const byId = new Map(pages.map(p => [p.id, p]))
  const parents: string[] = []
  for (let at = page.parent, n = 0; at && n < 10; n++) {
    const up = byId.get(at)
    if (!up) break
    parents.unshift(up.title)
    at = up.parent
  }
  return { parents, title: page.title }
}

/** The pages a page may be put under: same project, not itself or one of its own sub-pages, not archived. */
export function parentChoices(pageId: string, pages: MwPageSummary[]): MwPageSummary[] {
  const below = new Set<string>([pageId])
  let grew = true
  while (grew) {
    grew = false
    for (const p of pages) {
      if (p.parent && below.has(p.parent) && !below.has(p.id)) { below.add(p.id); grew = true }
    }
  }
  return pages.filter(p => !below.has(p.id) && p.status !== 'archived')
}

export const EVERY_CHOICES = ['mon', 'daily', 'month'] as const
export { WEEKDAYS }
