/**
 * The MemWise app API for regulated projects (Stage 5 of "Projects and pages",
 * docs/memwise/26-projects-and-pages.md §7, §8; D115–D119): change requests and their chat, the
 * project audit log (signed export, verify), inspector links and their questions, the TMF index.
 * Shapes in @memwise/shared/protocol (memwise-regulated.ts). Requests act as the client's person;
 * the kernel checks every role and signature.
 */
import { RPC_CHANNELS } from '@memwise/shared/protocol'
import type {
  MwAuditExport, MwAuditLog, MwAuditQuery, MwAuditVerifyResult, MwChangeRequest, MwChangeRequestStatus, MwChangeRequestSummary,
  MwChangeSignResult, MwChangeValidation, MwInspectorLink, MwInspectorLinkCreated, MwInspectorLinkInput, MwInspectorQuestion,
  MwChatAnchor, MwFindChatResult, MwOpenChangeInput, MwOpenChangeResult, MwTmfIndex, MwValidationSet,
} from '@memwise/shared/protocol'
import type { ChangeRequestView } from '@memwise/runtime'
import type { RequestContext, RpcServer } from '@memwise/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { emitMemwiseChange } from '../../memwise/host'
import type { MemwiseService, PersonActor } from '../../memwise/service'
import { authoringOf, personName } from '../../memwise/conversation'
import {
  changeChatBlock, regulatedOf, toAuditEntry, toAuditVerify, toChangeRequest, toChangeSignResult, toChangeSummary, toChangeValidation,
  toInspectorLink, toInspectorQuestion, toTmfIndex,
} from '../../memwise/regulated'
import { clientOf, requireService } from './memwise'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.memwise.CHANGES_LIST,
  RPC_CHANNELS.memwise.CHANGES_GET,
  RPC_CHANNELS.memwise.CHANGES_OPEN,
  RPC_CHANNELS.memwise.CHANGES_UPDATE,
  RPC_CHANNELS.memwise.CHANGES_VALIDATE,
  RPC_CHANNELS.memwise.CHANGES_SIGN,
  RPC_CHANNELS.memwise.CHANGES_WITHDRAW,
  RPC_CHANNELS.memwise.CHANGES_CHAT,
  RPC_CHANNELS.memwise.AUDIT_LOG,
  RPC_CHANNELS.memwise.AUDIT_LOG_EXPORT,
  RPC_CHANNELS.memwise.AUDIT_VERIFY,
  RPC_CHANNELS.memwise.INSPECTORS_LIST,
  RPC_CHANNELS.memwise.INSPECTORS_CREATE,
  RPC_CHANNELS.memwise.INSPECTORS_REVOKE,
  RPC_CHANNELS.memwise.INSPECTORS_EXTEND,
  RPC_CHANNELS.memwise.INSPECTORS_QUESTIONS,
  RPC_CHANNELS.memwise.INSPECTORS_ANSWER,
  RPC_CHANNELS.memwise.TMF_INDEX,
] as const

const STATUSES: readonly MwChangeRequestStatus[] = ['open', 'in_review', 'published', 'withdrawn']
/** Largest audit export pasted into verify (a JSON file of a whole project's trail). */
const MAX_VERIFY_JSON = 50 * 1024 * 1024
const MAX_AUDIT_PAGE = 2000

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
/** Entries of the trail a chat about it is given (the latest). */
const PAGE_CHAT_ENTRIES = 150

/** The project shell's Stage 5 chat anchors. */
export type StageFiveAnchor = Extract<MwChatAnchor, { kind: 'change' | 'audit' | 'tmf' }>
export const isStageFiveAnchor = (a: MwChatAnchor | undefined): a is StageFiveAnchor => a?.kind === 'change' || a?.kind === 'audit' || a?.kind === 'tmf'
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

function requireId(v: unknown, what: string): string {
  const s = str(v)
  if (!s) throw new Error(`Say which ${what}.`)
  return s
}

/** The audit query a client sent, cleaned (unknown fields dropped). */
function auditQuery(q: MwAuditQuery | undefined): MwAuditQuery {
  const project = requireId(q?.project, 'project')
  const limit = typeof q?.limit === 'number' && q.limit > 0 ? Math.min(Math.floor(q.limit), MAX_AUDIT_PAGE) : undefined
  return {
    project,
    ...(str(q?.entity) ? { entity: str(q!.entity)! } : {}),
    ...(str(q?.recordId) ? { recordId: str(q!.recordId)! } : {}),
    ...(str(q?.caseId) ? { caseId: str(q!.caseId)! } : {}),
    ...(Array.isArray(q?.actorKinds) && q!.actorKinds.length ? { actorKinds: q!.actorKinds.filter((k) => typeof k === 'string') } : {}),
    ...(Array.isArray(q?.actions) && q!.actions.length ? { actions: q!.actions.filter((a) => typeof a === 'string') } : {}),
    ...(typeof q?.afterSeq === 'number' ? { afterSeq: q.afterSeq } : {}),
    ...(limit ? { limit } : {}),
  }
}

function validationSet(v: MwValidationSet | undefined): MwValidationSet | undefined {
  if (!v || typeof v !== 'object') return undefined
  return {
    ...(str(v.label) ? { label: str(v.label)! } : {}),
    ...(Array.isArray(v.caseIds) ? { caseIds: v.caseIds.filter((c) => typeof c === 'string' && c) } : {}),
    ...(str(v.since) ? { since: str(v.since)! } : {}),
    ...(str(v.until) ? { until: str(v.until)! } : {}),
    ...(v.where && typeof v.where === 'object' ? { where: v.where } : {}),
    ...(typeof v.limit === 'number' && v.limit > 0 ? { limit: Math.min(Math.floor(v.limit), 500) } : {}),
  }
}

/** The handler implementations, callable directly (tests) or through `registerMemwiseRegulatedHandlers`. */
export function createRegulatedApi(deps: Pick<HandlerDeps, 'sessionManager' | 'platform'>) {
  const log = deps.platform.logger

  async function begin(ctx: RequestContext): Promise<{ svc: MemwiseService; actor: PersonActor; r: ReturnType<typeof regulatedOf> }> {
    const svc = requireService()
    const actor = await svc.actorFor(clientOf(ctx))
    return { svc, actor, r: regulatedOf(svc) }
  }

  async function requireView(svc: MemwiseService, actor: PersonActor, crId: unknown, project?: string): Promise<ChangeRequestView> {
    const v = await regulatedOf(svc).changes.get(requireId(crId, 'change request'), actor, project)
    if (!v) throw new Error('That change request was not found.')
    return v
  }

  /**
   * The request a call changes (or anchors a chat to): by its id, or by its label with its project.
   * A bare `CR-014` isn't enough: numbers are per project, and it could be another project's.
   */
  async function requireTarget(svc: MemwiseService, actor: PersonActor, crId: unknown, project: unknown): Promise<ChangeRequestView> {
    const id = requireId(crId, 'change request')
    const p = str(project)
    if (!id.startsWith('cr_') && !p) throw new Error(`Say which project ${id} is in: change request numbers are per project.`)
    return requireView(svc, actor, id, id.startsWith('cr_') ? undefined : p)
  }

  /**
   * The person's chat on a change request (anchor kind `change`): reused while its session is
   * there, else made, with the request as its `<memwise_context>` and the `playbook_*` tools on
   * the request's draft. `request` becomes its first, visible message; without one the agent
   * speaks first.
   */
  async function openChangeChat(svc: MemwiseService, actor: PersonActor, workspaceId: string, v: ChangeRequestView, request?: string, reuse = true): Promise<string> {
    const { PgChatAnchorStore } = await import('@memwise/db')
    const store = new PgChatAnchorStore()
    const send = (sessionId: string, text: string, hidden: boolean) => {
      deps.sessionManager.sendMessage(sessionId, text, undefined, undefined, hidden ? { hidden: true } : undefined).catch((e: unknown) => {
        log.warn(`[memwise] change request chat ${sessionId}: a turn failed: ${errText(e)}`)
      })
    }
    for (const a of reuse ? await store.forAnchor(svc.kernel.pool, 'change', v.id, actor.personId) : []) {
      if (!(await deps.sessionManager.getSession(a.chatId).catch(() => null))) continue
      if (request) send(a.chatId, request, false)
      return a.chatId
    }
    const who = (await personName(svc, actor.personId)) ?? 'the person in this chat'
    let files: string[] = []
    try {
      const listed = await authoringOf(svc).read({ draftId: v.draftId })
      if ('files' in listed) files = listed.files
    } catch { /* the files list is a convenience */ }
    // Ask mode whatever the workspace default: draft writes run without prompts (D29), and
    // nothing in this chat can publish (QA's signature does).
    const session = await deps.sessionManager.createSession(workspaceId, { name: `${v.label}: ${v.title}`, permissionMode: 'ask' })
    await store.set(svc.kernel.pool, { chatId: session.id, anchorKind: 'change', anchorId: v.id, personId: actor.personId })
    deps.sessionManager.setMemwiseContext(session.id, {
      anchor: { kind: 'change', id: v.id },
      conversation: true,
      block: changeChatBlock(v, who, actor, files),
      personName: who,
    })
    await regulatedOf(svc).changes.setChat(v.id, session.id)
    send(session.id, request ?? `Start: greet me briefly, say in a sentence what ${v.label} changes and where its validation stands (from the MemWise context), and ask what to change.`, !request)
    emitMemwiseChange({ kind: 'regulated', project: v.project })
    return session.id
  }

  /**
   * A chat about a project's audit trail or TMF index (the project shell, doc 26 §2, §7, §8): the
   * page as the person sees it goes into its context, and it looks records up with `record_get`
   * and `record_query` as the person. It starts with the person's own question.
   */
  async function openPageChat(svc: MemwiseService, actor: PersonActor, workspaceId: string, kind: 'audit' | 'tmf', project: string, message?: string): Promise<string> {
    const r = regulatedOf(svc)
    const who = (await personName(svc, actor.personId)) ?? undefined
    const domain = (await svc.kernel.project().catch(() => undefined))?.project.domains?.[project]
    const name = domain?.name ?? project
    const lines: string[] = []
    if (kind === 'audit') {
      const out = await r.auditLog.list({ project, limit: 5000 }, actor)
      const entries = out.entries.map(toAuditEntry).slice(-PAGE_CHAT_ENTRIES)
      lines.push(`The audit trail of the project ${name}: every change by people and AI, append-only, each entry chained to the one before (chain ${out.chain.ok ? 'intact' : `broken: ${out.chain.message ?? 'an entry changed'}`}).`)
      lines.push(out.entries.length > entries.length ? `The latest ${entries.length} of ${out.entries.length} entries, oldest first:` : `All ${entries.length} entries, oldest first:`)
      for (const e of entries) lines.push(`- #${e.seq} ${e.at} · ${e.actorKind}${e.actorLabel ? ` ${e.actorLabel}` : ` ${e.actor}`} · ${e.action}${e.recordTitle ? ` · ${e.recordTitle}` : e.recordId ? ` · ${e.entity}:${e.recordId}` : ''}${e.stepTitle ? ` · step ${e.stepTitle}` : ''} · ${clip(JSON.stringify(e.data), 400)}`)
      lines.push('')
      lines.push('This chat is about the audit trail above. An AI entry names its model and quotes the sentence it relied on: say so when you cite one. Entries cannot be edited; the trail is exported, signed, from its page.')
    } else {
      const idx = toTmfIndex(await r.tmf.index({ project }, actor))
      const k = idx.kpis
      lines.push(`The TMF index of the project ${name}${idx.study ? ` (${idx.study.label})` : ''}, built from the TMF Reference Model with the expected documents from the study plan.`)
      lines.push(`Filed ${k.filed} of ${k.expected} expected; missing ${k.missing}; waiting for QC ${k.inQc}${k.oldestInQcDays !== null ? ` (oldest ${k.oldestInQcDays} days)` : ''}; filed late ${k.filedLate} (more than ${k.lateAfterDays} days after final).`)
      lines.push('Zones (number · name · expected · filed · missing · in QC · filed late):')
      for (const z of idx.zones) lines.push(`- ${z.number} · ${z.name} · ${z.expected} · ${z.filed} · ${z.missing} · ${z.inQc} · ${z.filedLate}`)
      if (idx.unplaced.length) lines.push(`Artifacts with no zone yet: ${idx.unplaced.join(', ')}.`)
      lines.push('')
      lines.push('This chat is about the TMF index above. Look at documents and expected documents with record_get and record_query; say "not recorded" when the records do not say.')
    }
    const session = await deps.sessionManager.createSession(workspaceId, { name: message ? clip(message, 60) : kind === 'audit' ? `Audit trail · ${name}` : `TMF index · ${name}` })
    const { PgChatAnchorStore } = await import('@memwise/db')
    await new PgChatAnchorStore().set(svc.kernel.pool, { chatId: session.id, anchorKind: kind, anchorId: project, personId: actor.personId })
    deps.sessionManager.setMemwiseContext(session.id, { anchor: { kind, id: project }, block: lines.join('\n'), ...(who ? { personName: who } : {}) })
    if (message) {
      deps.sessionManager.sendMessage(session.id, message).catch((e: unknown) => log.warn(`[memwise] ${kind} chat ${session.id}: a turn failed: ${errText(e)}`))
    }
    return session.id
  }

  /** Where a Stage 5 anchor's chats are stored: a change request by its id (the anchor may name its label). */
  async function anchorKeyOf(svc: MemwiseService, actor: PersonActor, anchor: StageFiveAnchor): Promise<{ kind: 'change' | 'audit' | 'tmf'; id: string }> {
    if (anchor.kind === 'change') return { kind: 'change', id: (await requireTarget(svc, actor, anchor.id, anchor.project)).id }
    return { kind: anchor.kind, id: requireId(anchor.id, 'project') }
  }

  async function chatsOn(svc: MemwiseService, actor: PersonActor, key: { kind: 'change' | 'audit' | 'tmf'; id: string }, limit: number): Promise<string[]> {
    const { PgChatAnchorStore } = await import('@memwise/db')
    const found: string[] = []
    for (const a of await new PgChatAnchorStore().forAnchor(svc.kernel.pool, key.kind, key.id, actor.personId)) {
      if (found.includes(a.chatId)) continue
      if (await deps.sessionManager.getSession(a.chatId).catch(() => null)) found.push(a.chatId)
      if (found.length >= limit) break
    }
    return found
  }

  return {
    // ---------------------------------------------------------------- the project shell's chats

    /** `memwise:chat:find` for a change request, audit trail or TMF index anchor. */
    async findChat(ctx: RequestContext, anchor: StageFiveAnchor): Promise<MwFindChatResult> {
      const { svc, actor } = await begin(ctx)
      const recent = await chatsOn(svc, actor, await anchorKeyOf(svc, actor, anchor), 8)
      return { sessionId: recent[0] ?? null, recent }
    },

    /**
     * `memwise:chat:open` for those anchors: continues the person's latest chat there (`reuse`),
     * else starts one with their message. A change request's chat edits its draft.
     */
    async openChat(ctx: RequestContext, workspaceId: string, input: { anchor: StageFiveAnchor; message?: string; reuse?: boolean }): Promise<{ sessionId: string }> {
      const { svc, actor } = await begin(ctx)
      const message = str(input.message)
      if (input.anchor.kind === 'change') {
        const v = await requireTarget(svc, actor, input.anchor.id, input.anchor.project)
        return { sessionId: await openChangeChat(svc, actor, workspaceId, v, message, !!input.reuse) }
      }
      const key = await anchorKeyOf(svc, actor, input.anchor)
      if (input.reuse) {
        const [found] = await chatsOn(svc, actor, key, 1)
        if (found) {
          if (message) deps.sessionManager.sendMessage(found, message).catch((e: unknown) => log.warn(`[memwise] ${key.kind} chat ${found}: a turn failed: ${errText(e)}`))
          return { sessionId: found }
        }
      }
      return { sessionId: await openPageChat(svc, actor, workspaceId, key.kind as 'audit' | 'tmf', key.id, message) }
    },

    // ---------------------------------------------------------------- change requests

    async listChanges(ctx: RequestContext, filter: { project?: string; workflowId?: string; status?: MwChangeRequestStatus | MwChangeRequestStatus[] }): Promise<MwChangeRequestSummary[]> {
      const { actor, r } = await begin(ctx)
      const wanted = filter?.status === undefined ? undefined : (Array.isArray(filter.status) ? filter.status : [filter.status]).filter((s) => STATUSES.includes(s))
      const list = await r.changes.list({
        ...(str(filter?.project) ? { project: str(filter.project)! } : {}),
        ...(str(filter?.workflowId) ? { workflowId: str(filter.workflowId)! } : {}),
        ...(wanted?.length ? { status: wanted } : {}),
      }, actor)
      return list.map(toChangeSummary)
    },

    async getChange(ctx: RequestContext, input: { crId: string; project?: string }): Promise<MwChangeRequest | null> {
      const { actor, r } = await begin(ctx)
      const v = await r.changes.get(requireId(input?.crId, 'change request'), actor, str(input?.project))
      return v ? toChangeRequest(v) : null
    },

    async openChange(ctx: RequestContext, workspaceId: string, input: MwOpenChangeInput): Promise<MwOpenChangeResult> {
      const { svc, actor, r } = await begin(ctx)
      const set = validationSet(input?.validationSet)
      const workflowId = requireId(input?.workflowId, 'playbook')
      // A project whose change log continues a paper one starts at the next paper number.
      const number = typeof input.number === 'number' && Number.isInteger(input.number) && input.number > 0 ? input.number : undefined
      if (number) {
        const project = (await svc.kernel.project()).project.workflows[workflowId]?.domain
        if (project && !(await r.changes.list({ project }, actor)).some((c) => c.number >= number)) await r.changes.setNextNumber(project, number)
      }
      const v = await r.changes.open({
        workflowId,
        ...(str(input.title) ? { title: str(input.title)! } : {}),
        ...(str(input.reason) ? { reason: str(input.reason)! } : {}),
        ...(str(input.draftId) ? { draftId: str(input.draftId)! } : {}),
        ...(set ? { validationSet: set } : {}),
      }, actor)
      const request = str(input.request)
      const sessionId = request ? await openChangeChat(svc, actor, workspaceId, v, request) : undefined
      const fresh = sessionId ? (await r.changes.get(v.id, actor)) ?? v : v
      return { changeRequest: toChangeRequest(fresh), ...(sessionId ? { sessionId } : {}) }
    },

    async updateChange(ctx: RequestContext, input: { crId: string; project?: string; title?: string; reason?: string; validationSet?: MwValidationSet }): Promise<MwChangeRequest> {
      const { svc, actor, r } = await begin(ctx)
      const v = await requireTarget(svc, actor, input?.crId, input?.project)
      const set = validationSet(input.validationSet)
      return toChangeRequest(await r.changes.update(v.id, {
        ...(typeof input.title === 'string' ? { title: input.title } : {}),
        ...(typeof input.reason === 'string' ? { reason: input.reason } : {}),
        ...(set ? { validationSet: set } : {}),
      }, actor))
    },

    async validateChange(ctx: RequestContext, input: { crId: string; project?: string; set?: MwValidationSet }): Promise<MwChangeValidation> {
      const { svc, actor, r } = await begin(ctx)
      const v = await requireTarget(svc, actor, input?.crId, input?.project)
      const set = validationSet(input.set)
      return toChangeValidation(await r.changes.validate(v.id, actor, set ? { set } : {}))
    },

    async signChange(ctx: RequestContext, input: { crId: string; project?: string; password: string }): Promise<MwChangeSignResult> {
      const { svc, actor, r } = await begin(ctx)
      const v = await requireTarget(svc, actor, input?.crId, input?.project)
      const result = toChangeSignResult(await r.changes.sign(v.id, { password: typeof input.password === 'string' ? input.password : '' }, actor))
      const retryAfter = result.status === 'locked' ? (await svc.kernel.people.get(actor.personId).catch(() => undefined))?.lockedUntil : undefined
      return retryAfter ? { ...result, retryAfter } : result
    },

    async withdrawChange(ctx: RequestContext, input: { crId: string; project?: string; reason?: string }): Promise<MwChangeRequest> {
      const { svc, actor, r } = await begin(ctx)
      const v = await requireTarget(svc, actor, input?.crId, input?.project)
      return toChangeRequest(await r.changes.withdraw(v.id, actor, str(input.reason)))
    },

    async changeChat(ctx: RequestContext, workspaceId: string, input: { crId: string; project?: string }): Promise<{ sessionId: string }> {
      const { svc, actor } = await begin(ctx)
      const v = await requireTarget(svc, actor, input?.crId, input?.project)
      return { sessionId: await openChangeChat(svc, actor, workspaceId, v) }
    },

    // ---------------------------------------------------------------- the audit log

    async auditLog(ctx: RequestContext, query: MwAuditQuery): Promise<MwAuditLog> {
      const { actor, r } = await begin(ctx)
      const out = await r.auditLog.list(auditQuery(query), actor)
      return { entries: out.entries.map(toAuditEntry), chain: { ...out.chain } }
    },

    async auditLogExport(ctx: RequestContext, query: MwAuditQuery): Promise<MwAuditExport> {
      const { actor, r } = await begin(ctx)
      const q = auditQuery(query)
      const doc = await r.auditLog.export(q, actor)
      const day = doc.exportedAt.slice(0, 10)
      const scope = q.recordId ? `-${q.recordId}` : q.caseId ? `-${q.caseId}` : ''
      return {
        name: `audit-trail-${q.project}${scope}-${day}.json`,
        mime: 'application/json',
        dataBase64: Buffer.from(JSON.stringify(doc, null, 2)).toString('base64'),
      }
    },

    async auditVerify(ctx: RequestContext, input: { project: string } | { exportJson: string }): Promise<MwAuditVerifyResult> {
      const { r } = await begin(ctx)
      if (input && 'exportJson' in input && typeof input.exportJson === 'string') {
        if (input.exportJson.length > MAX_VERIFY_JSON) throw new Error('That file is too large to check here.')
        let parsed: unknown
        try { parsed = JSON.parse(input.exportJson) } catch {
          return { ok: false, entries: 0, chain: { ok: false, message: 'not JSON' }, message: 'This is not an audit trail export (it is not JSON).' }
        }
        return toAuditVerify(await r.auditLog.verify({ export: parsed }))
      }
      const project = requireId((input as { project?: string })?.project, 'project')
      return toAuditVerify(await r.auditLog.verify({ project }))
    },

    // ---------------------------------------------------------------- inspectors

    async listInspectors(ctx: RequestContext, input: { project: string }): Promise<MwInspectorLink[]> {
      const { actor, r } = await begin(ctx)
      return (await r.inspectors.list(requireId(input?.project, 'project'), actor)).map(toInspectorLink)
    },

    async createInspector(ctx: RequestContext, input: MwInspectorLinkInput): Promise<MwInspectorLinkCreated> {
      const { actor, r } = await begin(ctx)
      const inspectors = Array.isArray(input?.inspectors)
        ? input.inspectors.filter((p) => p && str(p.name)).map((p) => ({
          name: str(p.name)!, ...(str(p.email) ? { email: str(p.email)! } : {}), ...(str(p.organisation) ? { organisation: str(p.organisation)! } : {}),
        }))
        : []
      const made = await r.inspectors.create({
        project: requireId(input?.project, 'project'), name: requireId(input.name, 'name for the inspection'),
        inspectors, expiresAt: requireId(input.expiresAt, 'end date'),
      }, actor)
      return { link: toInspectorLink(made.link), token: made.token, ...(made.url ? { url: made.url } : {}) }
    },

    async revokeInspector(ctx: RequestContext, input: { linkId: string }): Promise<MwInspectorLink> {
      const { actor, r } = await begin(ctx)
      return toInspectorLink(await r.inspectors.revoke(requireId(input?.linkId, 'link'), actor))
    },

    async extendInspector(ctx: RequestContext, input: { linkId: string; expiresAt: string }): Promise<MwInspectorLink> {
      const { actor, r } = await begin(ctx)
      return toInspectorLink(await r.inspectors.extend(requireId(input?.linkId, 'link'), requireId(input.expiresAt, 'end date'), actor))
    },

    async inspectorQuestions(ctx: RequestContext, filter: { project?: string; linkId?: string; open?: boolean }): Promise<MwInspectorQuestion[]> {
      const { actor, r } = await begin(ctx)
      const list = await r.inspectors.questions({
        ...(str(filter?.project) ? { project: str(filter.project)! } : {}),
        ...(str(filter?.linkId) ? { linkId: str(filter.linkId)! } : {}),
        ...(typeof filter?.open === 'boolean' ? { open: filter.open } : {}),
      }, actor)
      return list.map(toInspectorQuestion)
    },

    async answerInspector(ctx: RequestContext, input: { questionId: string; answer: string }): Promise<MwInspectorQuestion> {
      const { actor, r } = await begin(ctx)
      return toInspectorQuestion(await r.inspectors.answer(requireId(input?.questionId, 'question'), requireId(input.answer, 'answer'), actor))
    },

    // ---------------------------------------------------------------- the TMF index

    async tmfIndex(ctx: RequestContext, input: { project: string; study?: string; zone?: string }): Promise<MwTmfIndex> {
      const { actor, r } = await begin(ctx)
      return toTmfIndex(await r.tmf.index({
        project: requireId(input?.project, 'project'),
        ...(str(input.study) ? { study: str(input.study)! } : {}),
        ...(str(input.zone) ? { zone: str(input.zone)! } : {}),
      }, actor))
    },
  }
}

export function registerMemwiseRegulatedHandlers(server: RpcServer, deps: HandlerDeps): void {
  const api = createRegulatedApi(deps)
  const ch = RPC_CHANNELS.memwise
  server.handle(ch.CHANGES_LIST, (ctx, _ws: string, filter) => api.listChanges(ctx, filter ?? {}))
  server.handle(ch.CHANGES_GET, (ctx, _ws: string, input) => api.getChange(ctx, input))
  server.handle(ch.CHANGES_OPEN, (ctx, ws: string, input) => api.openChange(ctx, ws, input))
  server.handle(ch.CHANGES_UPDATE, (ctx, _ws: string, input) => api.updateChange(ctx, input))
  server.handle(ch.CHANGES_VALIDATE, (ctx, _ws: string, input) => api.validateChange(ctx, input))
  server.handle(ch.CHANGES_SIGN, (ctx, _ws: string, input) => api.signChange(ctx, input))
  server.handle(ch.CHANGES_WITHDRAW, (ctx, _ws: string, input) => api.withdrawChange(ctx, input))
  server.handle(ch.CHANGES_CHAT, (ctx, ws: string, input) => api.changeChat(ctx, ws, input))
  server.handle(ch.AUDIT_LOG, (ctx, _ws: string, query) => api.auditLog(ctx, query))
  server.handle(ch.AUDIT_LOG_EXPORT, (ctx, _ws: string, query) => api.auditLogExport(ctx, query))
  server.handle(ch.AUDIT_VERIFY, (ctx, _ws: string, input) => api.auditVerify(ctx, input))
  server.handle(ch.INSPECTORS_LIST, (ctx, _ws: string, input) => api.listInspectors(ctx, input))
  server.handle(ch.INSPECTORS_CREATE, (ctx, _ws: string, input) => api.createInspector(ctx, input))
  server.handle(ch.INSPECTORS_REVOKE, (ctx, _ws: string, input) => api.revokeInspector(ctx, input))
  server.handle(ch.INSPECTORS_EXTEND, (ctx, _ws: string, input) => api.extendInspector(ctx, input))
  server.handle(ch.INSPECTORS_QUESTIONS, (ctx, _ws: string, filter) => api.inspectorQuestions(ctx, filter ?? {}))
  server.handle(ch.INSPECTORS_ANSWER, (ctx, _ws: string, input) => api.answerInspector(ctx, input))
  server.handle(ch.TMF_INDEX, (ctx, _ws: string, input) => api.tmfIndex(ctx, input))
}
