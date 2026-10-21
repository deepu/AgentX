/**
 * Pages as the screens get them (docs/memwise/26-projects-and-pages.md §4): the kernel's page
 * views mapped to the `Mw*` protocol types. A page's project is the domain it lives in for now
 * (Stage 1: the project id is the domain id).
 */
import type {
  MwInboxPageChange, MwPage, MwPageChange, MwPageChangeFrom, MwPageChild, MwPageSummary, MwPageVersion, MwPageWriteResult,
} from '@memwise/shared/protocol'
import type { WrittenPageVersion } from '@memwise/db'
import type { PageChangeRef, PageChangeView, PageChild, PageSummary, PageView, PageWriteResult } from '@memwise/runtime'

export type Names = ReadonlyMap<string, string>

export function toMwPageSummary(p: PageSummary, names: Names): MwPageSummary {
  const ownerName = p.owner ? names.get(p.owner) : undefined
  return {
    id: p.id, projectId: p.project, ...(p.parent ? { parent: p.parent } : {}), title: p.title, status: p.status,
    ...(p.question ? { question: p.question } : {}), headline: p.headline, ...(p.refresh ? { refresh: { ...p.refresh } } : {}),
    ...(p.refreshEnded ? { refreshEnded: true } : {}), ...(p.under ? { under: { ...p.under } } : {}),
    pinned: p.pinned, sumsChildren: p.sumsChildren, version: p.version,
    ...(p.owner ? { owner: p.owner } : {}), ...(ownerName ? { ownerName } : {}), updatedAt: p.updatedAt,
    ...(p.pendingChange ? { pendingChange: { ...p.pendingChange } } : {}),
    ...(p.lastRefresh ? { lastRefresh: { ...p.lastRefresh } } : {}),
  }
}

function toMwPageChild(c: PageChild, names: Names): MwPageChild {
  return { ...toMwPageSummary(c, names), inSummary: c.inSummary }
}

export function toMwPage(p: PageView, names: Names): MwPage {
  return {
    ...toMwPageSummary(p, names),
    body: p.body,
    written: p.written,
    ...(p.chatId ? { chatId: p.chatId } : {}),
    regulated: p.regulated,
    breadcrumb: p.breadcrumb.map((b) => ({ ...b })),
    children: p.children.map((c) => toMwPageChild(c, names)),
    history: p.history.map((h) => ({ ...h, ...(h.by && !h.byName && names.get(h.by) ? { byName: names.get(h.by)! } : {}) })),
    ...(p.changedFromChat ? { changedFromChat: { ...p.changedFromChat, sections: [...p.changedFromChat.sections] } } : {}),
    canUndo: p.canUndo,
    changes: p.changes.map((c) => ({ ...c })),
  }
}

export function toMwPageVersion(v: WrittenPageVersion, names: Names): MwPageVersion {
  const byName = v.by ? names.get(v.by) : undefined
  return {
    version: v.version, title: v.title, body: v.body, ...(v.by ? { by: v.by } : {}), ...(byName ? { byName } : {}),
    ...(v.via ? { via: v.via } : {}), ...(v.reason ? { reason: v.reason } : {}), at: v.at,
  }
}

export function toMwPageWriteResult(r: PageWriteResult, names: Names): MwPageWriteResult {
  return {
    applied: r.applied, ...(r.status ? { status: r.status } : {}), ...(r.message ? { message: r.message } : {}),
    ...(r.page ? { page: toMwPage(r.page, names) } : {}),
  }
}

function fromOf(from: { kind: 'schedule' | 'manual' | 'summary'; every?: string; by?: string } | undefined, names: Names): MwPageChangeFrom | undefined {
  if (!from) return undefined
  const byName = from.by ? names.get(from.by) : undefined
  return { kind: from.kind, ...(from.every ? { every: from.every } : {}), ...(from.by ? { by: from.by } : {}), ...(byName ? { byName } : {}) }
}

export function toMwPageChange(c: PageChangeView, names: Names): MwPageChange {
  const s = c.summary
  const from = fromOf(s.from, names)
  const reviewedByName = c.reviewedByName ?? (c.reviewedBy ? names.get(c.reviewedBy) : undefined)
  return {
    id: c.id, pageId: c.pageId, pageTitle: c.pageTitle, projectId: c.project, status: c.status, fromVersion: c.fromVersion,
    ...(c.toVersion ? { toVersion: c.toVersion } : {}),
    ...(s.label ? { label: s.label } : {}), ...(s.title ? { title: s.title } : {}),
    ...(s.before !== undefined ? { before: s.before } : {}), ...(s.after !== undefined ? { after: s.after } : {}),
    ...(s.plus ? { plus: s.plus } : {}),
    sections: (s.sections ?? []).map((x) => ({ ...x })),
    removed: [...(s.removed ?? [])],
    leftOut: (s.leftOut ?? []).map((x) => ({ ...x })),
    numbers: { added: [...(s.numbers?.added ?? [])], removed: [...(s.numbers?.removed ?? [])] },
    ...(s.chatNote ? { chatNote: s.chatNote } : {}),
    ...(from ? { from } : {}),
    beforeBody: c.before, afterBody: c.after,
    ...(c.runId ? { runId: c.runId } : {}), ...(c.caseId ? { caseId: c.caseId } : {}), ...(c.stepRunId ? { stepRunId: c.stepRunId } : {}),
    ...(c.reviewedBy ? { reviewedBy: c.reviewedBy } : {}), ...(reviewedByName ? { reviewedByName } : {}),
    ...(c.comment ? { comment: c.comment } : {}),
    at: c.at, mayDecide: c.mayDecide, ...(c.stale ? { stale: true } : {}),
  }
}

export function toMwInboxPageChange(ref: PageChangeRef, names: Names): MwInboxPageChange {
  const from = fromOf(ref.from, names)
  return {
    changeId: ref.changeId, pageId: ref.pageId, pageTitle: ref.pageTitle, projectId: ref.project,
    ...(ref.label ? { label: ref.label } : {}), ...(from ? { from } : {}), at: ref.at,
  }
}
