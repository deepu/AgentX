/**
 * The `playbook_*` session tools' callbacks (docs/memwise/20-phase-3-interfaces.md §4), wired by
 * SessionManager for a chat anchored to a conversation step. Each call resolves the chat's
 * anchor (mw.chat_anchors → the step run → its run, case, draft and person) and acts as that
 * person through `kernel.authoring`; finishing answers the step with `submitStep({ via })`.
 *
 * Loaded by SessionManager at module level, so no kernel imports here except lazily.
 */
import type { MemwisePageToolCallbacks, MemwiseRecordToolCallbacks, MemwiseToolCallbacks, PlaybookToolDiagnostic, RecordKeepRowResult } from '@memwise/session-tools-core'
import { untrustedRecordData } from '@memwise/session-tools-core'
import type { Diagnostic, DraftDiff, DraftMeta, DraftReport } from '@memwise/defs'
import { emitMemwiseChange, getMemwiseService } from './host'
import { authoringOf, conversationState, isConversationStep, type ConversationState } from './conversation'
import type { MemwiseService, PersonActor } from './service'
import type { ProjectDefs } from '@memwise/defs'
import type { PageView, PageWriteResult, RecordField, RecordFieldSource, RecordPage, RecordQueryResult, RecordsService } from '@memwise/runtime'

export interface MemwiseChatToolsOptions {
  sessionId: string
  log?: (message: string) => void
}

const DIFF_TEXT_MAX = 30_000

function diag(d: Diagnostic): PlaybookToolDiagnostic {
  return {
    severity: d.severity, code: d.code, message: d.path && !d.line ? `${d.message} (${d.path})` : d.message,
    ...(d.file ? { file: d.file } : {}), ...(d.line ? { line: d.line } : {}),
  }
}

const humanize = (id: string) => {
  const w = id.replace(/[_-]+/g, ' ').trim()
  return w ? w[0]!.toUpperCase() + w.slice(1) : id
}

/** The draft diff in a form a model reads well: the structural changes, then unified file diffs. */
export function diffForChat(diff: DraftDiff): Record<string, unknown> {
  let budget = DIFF_TEXT_MAX
  const files = diff.files.map((f) => {
    const body = f.hunks.map((h) => [
      `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
      ...h.lines.map((l) => `${l.kind === 'added' ? '+' : l.kind === 'removed' ? '-' : ' '}${l.text}`),
    ].join('\n')).join('\n')
    const text = body.length <= budget ? body : `${body.slice(0, Math.max(0, budget))}\n… (cut; playbook_read the file for the rest)`
    budget = Math.max(0, budget - text.length)
    return { path: f.path, status: f.status, ...(f.conflict ? { conflict: true } : {}), diff: text }
  })
  return {
    draftId: diff.draftId,
    workflowId: diff.workflowId,
    ...(diff.structure ? { structure: diff.structure } : { structure: null, note: 'The draft does not load as a playbook yet; see the checks.' }),
    ...(diff.conflicts.length ? { conflicts: diff.conflicts } : {}),
    files,
  }
}

export function reportForChat(r: DraftReport): Record<string, unknown> {
  return {
    outcome: r.outcome,
    summary: r.summary,
    errors: r.errors,
    warnings: r.warnings,
    diagnostics: r.diagnostics.map(diag),
    examples: r.examples,
    pastCases: r.pastCases.map((p) => ({ title: p.title, status: p.status, differences: p.differences })),
    ...(r.impact ? { impact: r.impact.summary } : {}),
  }
}

export function buildMemwiseToolCallbacks(opts: MemwiseChatToolsOptions): MemwiseToolCallbacks {
  const { sessionId } = opts
  /** Step runs this chat finished: the step's record catches up a moment later. */
  const finished = new Set<string>()

  async function ctx(): Promise<{ svc: MemwiseService; actor: PersonActor; s: ConversationState }> {
    const svc = getMemwiseService()
    if (!svc) throw new Error('Playbooks are not running in this app right now.')
    const { PgChatAnchorStore } = await import('@memwise/db')
    const store = new PgChatAnchorStore()
    const anchor = await store.get(svc.kernel.pool, sessionId)
    if (!anchor || anchor.anchorKind !== 'step') throw new Error('This chat is not building or changing a playbook.')
    if (!anchor.personId) throw new Error('This chat has no person to act for.')
    const actor = await svc.kernel.people.actorFor(anchor.personId)
    const s = await conversationState(svc, anchor.anchorId, actor)
    // After a review sent it back, the step has a new attempt: the chat follows it.
    if (s.stepRunId !== anchor.anchorId) {
      await store.set(svc.kernel.pool, { chatId: sessionId, anchorKind: 'step', anchorId: s.stepRunId, personId: anchor.personId })
    }
    return { svc, actor, s }
  }

  async function ensureDraft(svc: MemwiseService, actor: PersonActor, s: ConversationState, args: { playbook?: string; title?: string }): Promise<DraftMeta> {
    if (s.draft) return s.draft
    const authoring = authoringOf(svc)
    const { project } = await svc.kernel.project()
    const caseId = typeof s.values.playbook === 'string' && s.values.playbook.trim() ? s.values.playbook.trim() : undefined
    const live = caseId ? project.workflows[caseId] : undefined
    const change = s.workflowId === 'change-playbook' || !!live
    const workflowId = change ? (caseId ?? args.playbook) : (args.playbook ?? caseId)
    if (!workflowId) throw new Error('Give the new playbook an id on the first write (the `playbook` argument, kebab-case, e.g. "engagement-letter").')
    if (!change && project.workflows[workflowId]) throw new Error(`A playbook "${workflowId}" already exists; pick another id.`)
    const title = args.title ?? (typeof s.values.title === 'string' && s.values.title.trim() ? s.values.title.trim() : undefined)
      ?? project.workflows[workflowId]?.title ?? humanize(workflowId)
    const meta = await authoring.createDraft({ workflowId, title, kind: change ? 'change' : 'create', runId: s.runId }, actor)
    opts.log?.(`[memwise] chat ${sessionId} started draft ${meta.id} (${meta.kind} ${workflowId})`)
    return meta
  }

  function requireWaiting(s: ConversationState): void {
    if (s.status !== 'waiting' || finished.has(s.stepRunId)) throw new Error('This step is no longer waiting on the chat (it was finished, or the case moved on).')
  }

  return {
    async vocabulary() {
      const { svc } = await ctx()
      return authoringOf(svc).vocabulary()
    },

    async read(input) {
      const { svc, s } = await ctx()
      const authoring = authoringOf(svc)
      if (input.playbook) return authoring.read({ workflowId: input.playbook, ...(input.path ? { path: input.path } : {}) })
      if (s.draft && !input.live) return authoring.read({ draftId: s.draft.id, ...(input.path ? { path: input.path } : {}) })
      const playbook = typeof s.values.playbook === 'string' && s.values.playbook ? s.values.playbook : undefined
      return authoring.read({ ...(playbook ? { workflowId: playbook } : {}), ...(input.path ? { path: input.path } : {}) })
    },

    async write(input) {
      const { svc, actor, s } = await ctx()
      requireWaiting(s)
      const draft = await ensureDraft(svc, actor, s, input)
      const { edit, diagnostics } = await authoringOf(svc).write({
        draftId: draft.id, files: input.files, summary: input.summary, via: 'chat', chatId: sessionId,
      }, actor)
      emitMemwiseChange({ kind: 'drafts', id: draft.id })
      const errors = diagnostics.filter((d) => d.severity === 'error').length
      return {
        draftId: draft.id,
        editId: edit.id,
        status: edit.status,
        paths: edit.files.map((f) => f.path),
        errors,
        warnings: diagnostics.length - errors,
        diagnostics: diagnostics.map(diag),
        ...(errors ? { next: 'Fix the errors before finishing.' } : {}),
      }
    },

    async diff() {
      const { svc, s } = await ctx()
      if (!s.draft) return { draftId: null, note: 'Nothing written yet: the first playbook_write creates the draft.' }
      return diffForChat(await authoringOf(svc).diff(s.draft.id))
    },

    async check(input) {
      const { svc, s } = await ctx()
      if (!s.draft) throw new Error('Nothing to check yet: write the playbook into the draft first.')
      const report = await authoringOf(svc).check(s.draft.id, { ...(input.pastCases !== undefined ? { pastCases: input.pastCases } : {}) })
      emitMemwiseChange({ kind: 'drafts', id: s.draft.id })
      return reportForChat(report)
    },

    async finish(input) {
      const { svc, actor, s } = await ctx()
      requireWaiting(s)
      if (!s.draft) return { applied: false, message: 'Nothing was written yet: build the playbook in the draft first.' }
      const authoring = authoringOf(svc)
      const diagnostics = await authoring.quickCheck(s.draft.id)
      const errors = diagnostics.filter((d) => d.severity === 'error')
      if (errors.length) {
        return {
          applied: false,
          message: `The draft has ${errors.length} error${errors.length === 1 ? '' : 's'}; fix them first: ${errors.slice(0, 5).map((d) => diag(d).message).join('; ')}`,
          diagnostics: errors.map(diag),
        }
      }
      const { project } = await svc.kernel.project()
      const step = project.workflows[s.workflowId]?.steps[s.stepId]
      if (step && !isConversationStep(step)) return { applied: false, message: 'This step is not answered from a chat.' }
      const outcomes = step?.outcomes ?? []
      const outcome = input.outcome ?? (outcomes.length === 1 ? outcomes[0]! : 'drafted')
      if (outcomes.length && !outcomes.includes(outcome)) {
        return { applied: false, message: `"${outcome}" is not one of this step's outcomes (${outcomes.join(', ')}).` }
      }
      const draft = s.draft
      const candidate: Record<string, unknown> = {
        draft: draft.id,
        playbook: draft.workflowId,
        title: input.title ?? draft.title,
        summary: input.summary,
      }
      const writes = step ? new Set(Object.values(step.writes).map((w) => w.field)) : new Set(Object.keys(candidate))
      const values = Object.fromEntries(Object.entries(candidate).filter(([k]) => writes.has(k)))
      let r: Awaited<ReturnType<typeof svc.kernel.submitStep>>
      try {
        r = await svc.kernel.submitStep({
          stepRunId: s.stepRunId, outcome, values, by: actor,
          via: { chatId: sessionId, ...(input.rationale ? { rationale: input.rationale } : { rationale: input.summary }) },
        })
      } catch (e) {
        opts.log?.(`[memwise] chat ${sessionId}: finishing ${s.stepRunId} failed: ${e instanceof Error ? e.message : String(e)}`)
        return { applied: false, message: 'The step could not be finished just now; try again in a moment.' }
      }
      if (!r.applied) {
        const why = r.errors ? Object.entries(r.errors).map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ') : undefined
        return { applied: false, message: r.message ?? why ?? `The step could not be finished (${r.status}).`, status: r.status }
      }
      finished.add(s.stepRunId)
      emitMemwiseChange({ kind: 'drafts', id: draft.id })
      return {
        applied: true,
        draftId: draft.id,
        outcome,
        next: 'The draft goes to the checks and then to an approver; the person can follow it in the inbox and on the case.',
      }
    },
  }
}


// ---------------------------------------------------------------- record chats (25 §6)

/** Longest text value a `record_query` row carries; `record_get` gives the whole value. */
const QUERY_TEXT_MAX = 1500
/** Related rows per relationship in `record_get` and the chat's digest. */
const RELATED_ROWS_MAX = 50

/** The entities of a domain a record chat may keep (`keep_from_chat`), with their names. */
export function keepableEntities(project: Pick<ProjectDefs, 'entities'>, domain: string): { entity: string; name: string }[] {
  return Object.entries(project.entities)
    .filter(([, def]) => (def.domain ?? 'domain') === domain && def.keepFromChat === true)
    .map(([key, def]) => ({ entity: key, name: def.entity }))
    .sort((a, b) => (a.entity < b.entity ? -1 : 1))
}

/** Where a value came from, in a few words the model can repeat. */
export function sourceLabel(src: RecordFieldSource): string {
  switch (src.kind) {
    case 'step': return `step ${src.stepRunId}${src.workflowId ? ` of ${src.workflowId}` : ''}`
    case 'person': return `person ${src.name ?? src.personId}`
    case 'plugin': return `plugin ${src.plugin}`
    case 'link': return `linked ${src.domain}.${src.entity}${src.recordId ? ` ${src.recordId}` : ''}`
    case 'source': return `source ${src.source}`
    case 'calculated': return 'calculated'
    case 'domain': return 'entered'
  }
}

/** The words a value was read from, and whether they are in the page's text. */
interface ValueQuote { quote: string; found: boolean }

/**
 * The quote of each of the record's values, by field: the page's text viewers light them up
 * (`texts[*].highlights` of kind `value`, 25 §4). A value quoted in two viewers keeps the first.
 */
export function valueQuotes(page: RecordPage): Map<string, ValueQuote> {
  const out = new Map<string, ValueQuote>()
  for (const view of Object.values(page.texts ?? {})) {
    for (const h of view.highlights) {
      if (h.kind === 'value' && h.quote && !out.has(h.field)) out.set(h.field, { quote: h.quote, found: h.found })
    }
  }
  return out
}

/** One field of a record as the chat sees it: value, type, source, and its quote when it has one. */
function fieldForChat(f: RecordField, quote: ValueQuote | undefined): Record<string, unknown> {
  return {
    field: f.name,
    type: f.type,
    value: f.value,
    source: sourceLabel(f.source),
    ...(quote ? { quote: quote.quote, quoteFound: quote.found } : {}),
    ...(f.ref ? { ref: { entity: f.ref.entity, id: f.ref.id, title: f.ref.title } } : {}),
  }
}

/** A record page as `record_get` returns it: what the person may see, nothing they may not. */
export function recordForChat(page: RecordPage): Record<string, unknown> {
  const visible = page.fields.filter((f) => !f.hidden)
  const hidden = page.fields.filter((f) => f.hidden).map((f) => f.name)
  const quotes = valueQuotes(page)
  return {
    entity: page.entity,
    id: page.id,
    title: page.title,
    entityName: page.entityName,
    domain: page.domain,
    ...(page.status ? { status: page.status } : {}),
    ...(page.parents.length ? { parents: page.parents.map((p) => ({ entity: p.entity, id: p.id, title: p.title })) } : {}),
    values: visible.map((f) => fieldForChat(f, quotes.get(f.name))),
    ...(hidden.length ? { hiddenFields: hidden } : {}),
    related: Object.fromEntries(Object.entries(page.related).map(([rel, r]) => [rel, {
      entity: r.entity,
      total: r.total,
      rows: r.rows.slice(0, RELATED_ROWS_MAX).map((row) => ({ id: row.id, title: row.title, ...(row.status ? { status: row.status } : {}), values: row.values })),
      ...(r.total > RELATED_ROWS_MAX ? { more: `${r.total - RELATED_ROWS_MAX} more; use record_query on ${r.entity}` } : {}),
    }])),
    ...(page.flags.length ? { flags: page.flags.filter((f) => !f.closedAt).map((f) => f.message) } : {}),
    ...(page.lifecycle ? {
      lifecycle: {
        ...(page.lifecycle.current ? { current: page.lifecycle.current } : {}),
        transitions: page.lifecycle.transitions.map((t) => ({ name: t.name, to: t.to, allowed: t.allowed, ...(t.reason ? { reason: t.reason } : {}) })),
      },
    } : {}),
    ...(page.notes?.body ? { notes: page.notes.body } : {}),
  }
}

const clipText = (v: unknown): unknown => (typeof v === 'string' && v.length > QUERY_TEXT_MAX ? `${v.slice(0, QUERY_TEXT_MAX)}… (cut; record_get has the whole value)` : v)

/** A query result as `record_query` returns it (long text cut; record_get has the rest). */
export function queryForChat(r: RecordQueryResult): Record<string, unknown> {
  return {
    entity: r.entity,
    total: r.total,
    returned: r.rows.length,
    columns: r.columns.map((c) => `${c.name} (${c.type})`),
    rows: r.rows.map((row) => ({
      id: row.id,
      title: row.title,
      ...(row.status ? { status: row.status } : {}),
      values: Object.fromEntries(Object.entries(row.values).filter(([k]) => !row.hidden.includes(k)).map(([k, v]) => [k, clipText(v)])),
      ...(row.refs && Object.keys(row.refs).length ? { refs: Object.fromEntries(Object.entries(row.refs).map(([k, ref]) => [k, { id: ref.id, title: ref.title }])) } : {}),
    })),
    ...(r.groups ? { groups: r.groups } : {}),
  }
}

export interface RecordChatContext {
  svc: MemwiseService
  actor: PersonActor
  records: RecordsService
  project: ProjectDefs
  /** The anchored record. */
  entity: string
  id: string
  domain: string
}

/**
 * The record tools' callbacks (`record_get`, `record_query`, `record_keep`; doc 25 §6), wired by
 * SessionManager for a chat anchored to a record. Each call resolves the chat's anchor
 * (mw.chat_anchors → the record and the person) and acts as that person, with their access.
 */
export function buildMemwiseRecordToolCallbacks(opts: MemwiseChatToolsOptions & {
  /** Tests: the anchor context without the process's service. */
  resolve?: () => Promise<RecordChatContext>
}): MemwiseRecordToolCallbacks {
  const { sessionId } = opts

  async function ctx(): Promise<RecordChatContext> {
    if (opts.resolve) return opts.resolve()
    const svc = getMemwiseService()
    if (!svc) throw new Error('MemWise is not running in this app right now.')
    const { PgChatAnchorStore, parseRecordAnchorId } = await import('@memwise/db')
    const anchor = await new PgChatAnchorStore().get(svc.kernel.pool, sessionId)
    // A chat anchored to a page (26 §4) reads the records of the page's project too.
    if (anchor?.anchorKind === 'page') {
      if (!anchor.personId) throw new Error('This chat has no person to act for.')
      const records = (svc.kernel as { records?: RecordsService }).records
      if (!records) throw new Error('Records are not available in this version.')
      const { rows } = await svc.kernel.pool.query<{ domain: string }>('select domain from mw.pages where id = $1', [anchor.anchorId])
      if (!rows[0]) throw new Error('The page this chat is about was not found.')
      const actor = await svc.kernel.people.actorFor(anchor.personId)
      const { project } = await svc.kernel.project()
      return { svc, actor, records, project, entity: '', id: '', domain: rows[0].domain }
    }
    const rec = anchor?.anchorKind === 'record' ? parseRecordAnchorId(anchor.anchorId) : undefined
    if (!anchor || !rec) throw new Error('This chat is not about a record.')
    if (!anchor.personId) throw new Error('This chat has no person to act for.')
    const records = (svc.kernel as { records?: RecordsService }).records
    if (!records) throw new Error('Records are not available in this version.')
    const actor = await svc.kernel.people.actorFor(anchor.personId)
    const { project } = await svc.kernel.project()
    const domain = project.entities[rec.entity]?.domain ?? rec.entity.split('.')[0] ?? 'domain'
    return { svc, actor, records, project, entity: rec.entity, id: rec.id, domain }
  }

  /** A bare entity name is looked up in the anchored record's domain. */
  function entityKey(c: RecordChatContext, entity: string): string {
    if (c.project.entities[entity]) return entity
    if (!entity.includes('.')) {
      const inDomain = Object.entries(c.project.entities).find(([key, def]) => (def.domain ?? 'domain') === c.domain && (key === `${c.domain}.${entity}` || def.entity.toLowerCase() === entity.toLowerCase()))
      if (inDomain) return inDomain[0]
    }
    return entity
  }

  return {
    async get(input) {
      const c = await ctx()
      const page = await c.records.page(entityKey(c, input.entity), input.id, c.actor)
      if (!page) throw new Error(`No ${input.entity} ${input.id} that this person may see.`)
      return recordForChat(page)
    },

    async query(input) {
      const c = await ctx()
      const r = await c.records.query({
        entity: entityKey(c, input.entity),
        ...(input.filter ? { filter: input.filter } : {}),
        ...(input.sort?.length ? { sort: input.sort } : {}),
        ...(input.columns?.length ? { columns: input.columns } : {}),
        limit: Math.min(Math.max(input.limit ?? 50, 1), 200),
      }, c.actor)
      return queryForChat(r)
    },

    async keep(input) {
      const c = await ctx()
      const entity = entityKey(c, input.entity)
      const allowed = keepableEntities(c.project, c.domain)
      if (!allowed.some((k) => k.entity === entity)) {
        throw new Error(allowed.length
          ? `${input.entity} can't be kept from this chat; it keeps ${allowed.map((k) => k.entity).join(', ')}.`
          : 'Nothing in this record\'s domain can be kept from chat.')
      }
      if (typeof (c.records as Partial<RecordsService>).keep !== 'function') throw new Error('Keeping from chat is not available in this version.')
      const out = await c.records.keep({ entity, rows: input.rows, chatId: sessionId }, c.actor)
      const rows: RecordKeepRowResult[] = (out.rows ?? []).map((r) => ({
        ...(r.id ? { id: r.id } : {}),
        ...(typeof r.quoteFound === 'boolean' ? { quoteFound: r.quoteFound } : {}),
        ...(r.error || r.errors ? { error: r.error ?? Object.entries(r.errors ?? {}).map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ') } : {}),
      }))
      if (rows.some((r) => r.id)) emitMemwiseChange({ kind: 'records', entity })
      opts.log?.(`[memwise] chat ${sessionId} kept ${rows.filter((r) => r.id).length} ${entity} row(s)`)
      return { entity, rows }
    },

    /**
     * A chat opened from a domain's question box fills in its own draft (the anchored record),
     * only while that record is still in its lifecycle's first state: once the person keeps it,
     * it changes through its playbooks and its page.
     */
    async update(input) {
      const c = await ctx()
      if (!c.entity) throw new Error('This chat is about a page: change it with page_update.')
      const initial = c.project.entities[c.entity]?.lifecycleChart?.initial
      const page = await c.records.page(c.entity, c.id, c.actor)
      if (!page) throw new Error('The draft was not found, or this person may not see it.')
      if (!initial || page.status !== initial) {
        return { applied: false, message: `${page.title} is no longer a draft (it is ${page.status ?? 'kept'}); change it on its page now.` }
      }
      const r = await c.records.update({ entity: c.entity, id: c.id, values: input.values, reason: 'Filled in from chat' }, c.actor)
      if (r.applied) emitMemwiseChange({ kind: 'records', entity: c.entity, id: c.id })
      opts.log?.(`[memwise] chat ${sessionId} filled in ${Object.keys(input.values).join(', ')} on ${c.entity} ${c.id}: ${r.status}`)
      return { applied: r.applied, ...(r.message ? { message: r.message } : {}), ...(r.errors ? { errors: r.errors } : {}) }
    },
  }
}

/** The page as `page_get` returns it: the body as written, its place in the tree, its refresh. */
export function pageForChat(p: PageView): Record<string, unknown> {
  return {
    id: p.id, title: p.title, status: p.status, version: p.version, project: p.project,
    ...(p.question ? { question: p.question } : {}),
    ...(p.breadcrumb.length ? { under: p.breadcrumb.map((b) => `${b.title} (${b.id})`).join(' › ') } : {}),
    body: p.written,
    ...(p.sumsChildren ? { sums_children: true } : {}),
    ...(p.children.length ? { sub_pages: p.children.map((c) => ({ id: c.id, title: c.title, status: c.status, in_summary: c.inSummary, headline: c.headline })) } : {}),
    ...(p.refresh ? { refresh: { every: p.refresh.every, ...(p.refresh.last ? { last: p.refresh.last } : {}), ...(p.refresh.next ? { next: p.refresh.next } : {}) } } : {}),
    ...(p.pendingChange ? { answer_change_waiting: p.pendingChange.label ?? true } : {}),
    ...(p.regulated && p.status === 'kept' ? { note: 'A kept page in a regulated project: it changes through a change request, not from chat.' } : {}),
  }
}

/** What a page write returns to the chat. */
function writeForChat(r: PageWriteResult): { applied: boolean; message?: string; status?: string; [k: string]: unknown } {
  return {
    applied: r.applied, ...(r.status ? { status: r.status } : {}), ...(r.message ? { message: r.message } : {}),
    ...(r.page ? { page: { id: r.page.id, title: r.page.title, status: r.page.status, version: r.page.version } } : {}),
  }
}

export interface PageChatContext {
  svc: MemwiseService
  actor: PersonActor
  /** The page the chat is anchored to. */
  pageId: string
}

/**
 * The page tools' callbacks (`page_get`, `page_update`, `page_create`; 26 §4), wired by
 * SessionManager for a chat anchored to a page. Each call resolves the anchor (mw.chat_anchors →
 * the page and the person) and acts as that person: every write is a new version that says it
 * came from this chat (`via: chat:<id>`), with Undo on the page. The chat changes its own page and
 * the pages it made; a kept page in a regulated project is refused by the kernel.
 */
export function buildMemwisePageToolCallbacks(opts: MemwiseChatToolsOptions & {
  /** Tests: the anchor context without the process's service. */
  resolve?: () => Promise<PageChatContext>
}): MemwisePageToolCallbacks {
  const { sessionId } = opts
  const via = `chat:${sessionId}`

  async function ctx(): Promise<PageChatContext> {
    if (opts.resolve) return opts.resolve()
    const svc = getMemwiseService()
    if (!svc) throw new Error('MemWise is not running in this app right now.')
    const { PgChatAnchorStore } = await import('@memwise/db')
    const anchor = await new PgChatAnchorStore().get(svc.kernel.pool, sessionId)
    if (!anchor || anchor.anchorKind !== 'page') throw new Error('This chat is not about a page.')
    if (!anchor.personId) throw new Error('This chat has no person to act for.')
    return { svc, actor: await svc.kernel.people.actorFor(anchor.personId), pageId: anchor.anchorId }
  }

  /** The anchored page, or a page this chat made. */
  async function writable(c: PageChatContext, id: string | undefined): Promise<string> {
    const target = id ?? c.pageId
    if (target === c.pageId) return target
    const p = await c.svc.kernel.pages.get(target, c.actor)
    if (!p) throw new Error(`There is no page ${target}.`)
    if (p.chatId !== sessionId) throw new Error(`This chat changes only its own page and the pages it made; open ${p.title} to change it.`)
    return target
  }

  return {
    async get(input) {
      const c = await ctx()
      const p = await c.svc.kernel.pages.get(input.page ?? c.pageId, c.actor)
      if (!p) throw new Error(`There is no page ${input.page ?? c.pageId}.`)
      return pageForChat(p)
    },

    async update(input) {
      const c = await ctx()
      const id = await writable(c, input.page)
      const r = await c.svc.kernel.pages.update(id, {
        ...(input.title ? { title: input.title } : {}), ...(input.body !== undefined ? { body: input.body } : {}),
        via, reason: input.reason ?? 'Changed from chat',
      }, c.actor)
      opts.log?.(`[memwise] chat ${sessionId} changed page ${id}: ${r.status ?? (r.applied ? 'applied' : 'refused')}`)
      return writeForChat(r)
    },

    async create(input) {
      const c = await ctx()
      const here = await c.svc.kernel.pages.get(c.pageId, c.actor)
      if (!here) throw new Error('The page this chat is about was not found.')
      const r = await c.svc.kernel.pages.create({
        project: here.project, title: input.title, ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.question ? { question: input.question } : {}), ...(input.parent ? { parent: input.parent } : {}),
        chatId: sessionId, via, reason: input.question ? 'Asked a question' : 'Made from chat',
      }, c.actor)
      opts.log?.(`[memwise] chat ${sessionId} made page ${r.page?.id ?? '(refused)'}`)
      return writeForChat(r)
    },
  }
}

/** Longest record digest put into a record chat's context (the system prompt). */
const RECORD_DIGEST_MAX = 16_000
const DIGEST_VALUE_MAX = 600
/** Longest text value in the digest; `record_get` gives the whole value. */
const DIGEST_TEXT_MAX = 300
const DIGEST_RELATED_MAX = 25

/** One page block in plain words ("chart: Included papers by year (bar of screenings by year)"). */
function describeBlock(block: { kind: string; [k: string]: unknown }): string {
  const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : '')
  switch (block.kind) {
    case 'fields': return `fields: ${list(block.fields)}`
    case 'kpis': return `tiles: ${list(block.fields)}`
    case 'related': return `related: ${list(block.relationships)}`
    case 'viewer': return `viewer: ${String(block.field)} (the text, with the quotes of its values lit)`
    case 'markdown': return `page: ${String(block.field)} (markdown, with chart blocks)`
    case 'chart': {
      const what = block.chart === 'interval'
        ? `interval of ${String(block.of)}: ${String(block.value ?? '')} with ${String(block.low ?? '')}–${String(block.high ?? '')}${block.label ? `, labelled ${String(block.label)}` : ''}`
        : `${String(block.chart)} of ${String(block.of)}${block.by ? ` by ${String(block.by)}` : ''}`
      return `chart: ${block.title ? `${String(block.title)} (${what})` : what}${block.where ? ` where ${String(block.where)}` : ''}`
    }
    case 'chat': return 'chat: the "Ask in chat" button (this chat)'
    default: return block.kind
  }
}

/**
 * The context of a chat anchored to a record (doc 25 §6), from its page as the person sees it:
 * its values (with where each came from and its quote), related rows (titles and ids), open
 * flags, cases, and what the page shows. What the record holds was written by people, plugins
 * and sources, so it goes in an `<untrusted_record_data>` block, as the record tools' results
 * do: data, never instructions. Long text is cut (record_get has it whole).
 */
export function recordDigest(page: RecordPage): string {
  const clip = (v: unknown, n = DIGEST_VALUE_MAX) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    return s && s.length > n ? `${s.slice(0, n)}…` : s
  }
  const clipText = (v: unknown) => (typeof v === 'string' && v.length > DIGEST_TEXT_MAX ? `${v.slice(0, DIGEST_TEXT_MAX)}… (use record_get for the full text)` : clip(v))
  const quotes = valueQuotes(page)
  const lines: string[] = [
    `${page.entityName} "${page.title}" (entity ${page.entity}, id ${page.id}) in the domain ${page.domain}${page.status ? `, status ${page.status}` : ''}.`,
  ]
  if (page.parents.length) lines.push(`Under: ${page.parents.map((p) => `${p.title} (${p.entity} ${p.id})`).join(' › ')}`)
  lines.push('Values:')
  for (const f of page.fields) {
    if (f.hidden) { lines.push(`- ${f.name}: (not visible to this person)`); continue }
    if (f.value === null || f.value === undefined || f.value === '') continue
    const quote = quotes.get(f.name)
    const shown = f.ref ? `${f.ref.title} (${f.ref.entity} ${f.ref.id})` : clipText(f.value)
    const quoted = quote ? ` quote${quote.found ? '' : ' (not found in the text)'}: "${clip(quote.quote, DIGEST_TEXT_MAX)}"` : ''
    lines.push(`- ${f.name} (${f.type}): ${shown} [${sourceLabel(f.source)}]${quoted}`)
  }
  const related = Object.entries(page.related)
  if (related.length) {
    lines.push('Related:')
    for (const [rel, r] of related) {
      const rows = r.rows.slice(0, DIGEST_RELATED_MAX).map((row) => `${row.title} [${row.id}]${row.status ? ` (${row.status})` : ''}`)
      lines.push(`- ${rel} (${r.entity}, ${r.total}): ${rows.join('; ') || 'none'}${r.total > rows.length ? `; … ${r.total - rows.length} more (record_query ${r.entity})` : ''}`)
    }
  }
  const flags = page.flags.filter((f) => !f.closedAt)
  if (flags.length) lines.push('Open flags:', ...flags.map((f) => `- ${f.message}`))
  if (page.cases.length) lines.push('Cases:', ...page.cases.slice(0, 10).map((c) => `- ${c.title} (${c.workflowId}, ${c.state}, ${c.status}) [${c.caseId}]`))
  if (page.lifecycle?.transitions.length) {
    lines.push(`Lifecycle: ${page.lifecycle.states.join(' → ')}; now ${page.lifecycle.current ?? '?'}; moves: ${page.lifecycle.transitions.map((t) => `${t.name}${t.allowed ? '' : ' (not for this person now)'}`).join(', ')}`)
  }
  // What the page shows comes from the entity's definition, not from the record.
  const areas = Object.entries(page.layout.areas) as [string, { kind: string }[]][]
  const layoutLines = [`The page shows (${page.layout.layout} layout; header: ${page.layout.header.join(', ') || 'title'}):`]
  for (const [area, blocks] of areas) {
    if (blocks?.length) layoutLines.push(`- ${area}: ${blocks.map((b) => describeBlock(b as { kind: string; [k: string]: unknown })).join('; ')}`)
  }
  const layout = layoutLines.join('\n')
  const budget = Math.max(0, RECORD_DIGEST_MAX - layout.length - untrustedRecordData('').length)
  let record = lines.join('\n')
  if (record.length > budget) record = `${record.slice(0, budget)}\n… (shortened; use record_get and record_query)`
  return `${untrustedRecordData(record)}\n${layout}`
}
