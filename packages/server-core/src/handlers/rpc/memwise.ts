/**
 * The MemWise app API (19 §9): every `memwise:*` channel, mapping kernel types to the Mw* shapes
 * in @memwise/shared/protocol. The kernel is one per process (see memwise/host.ts); requests
 * act as the client's person: the signed-in person on a server, else who the owner acts as.
 */
import { RPC_CHANNELS } from '@memwise/shared/protocol'
import type {
  MwCase, MwCaseSummary, MwDecideApprovalInput, MwDocument, MwEntityRow, MwEntityType, MwExplainInput, MwExplanation,
  MwInboxItem, MwReturnedNote, MwLiveCounts, MwOpenChatInput, MwPerson, MwPlaybook, MwPlaybookSummary, MwRole, MwRunStatus,
  MwSendEventInput, MwStartCaseInput, MwStartCaseRefusal, MwStatus, MwStepRecord, MwSubmitResult, MwSubmitStepInput,
} from '@memwise/shared/protocol'
import type { ApprovalDecision } from '@memwise/defs'
import type { CompiledPolicy } from '@memwise/policy'
import type { Actor, CaseView, InboxItem } from '@memwise/runtime'
import { pushTyped, type RequestContext, type RpcServer } from '@memwise/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { emitMemwiseChange, getMemwiseHostStatus, getMemwiseService, onMemwiseChange } from '../../memwise/host'
import type { ClientIdentity, Kernel, MemwiseService, PersonActor } from '../../memwise/service'
import type { DtoContext } from '../../memwise/dto'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.memwise.STATUS,
  RPC_CHANNELS.memwise.PEOPLE_LIST,
  RPC_CHANNELS.memwise.PEOPLE_ACT_AS,
  RPC_CHANNELS.memwise.PEOPLE_CREATE,
  RPC_CHANNELS.memwise.ROLES_LIST,
  RPC_CHANNELS.memwise.PLAYBOOKS_LIST,
  RPC_CHANNELS.memwise.PLAYBOOKS_GET,
  RPC_CHANNELS.memwise.PLAYBOOKS_LIVE,
  RPC_CHANNELS.memwise.CASES_LIST,
  RPC_CHANNELS.memwise.CASES_GET,
  RPC_CHANNELS.memwise.CASES_START,
  RPC_CHANNELS.memwise.STEPS_GET,
  RPC_CHANNELS.memwise.STEPS_EXPLAIN,
  RPC_CHANNELS.memwise.INBOX_LIST,
  RPC_CHANNELS.memwise.INBOX_SUBMIT,
  RPC_CHANNELS.memwise.INBOX_DECIDE_APPROVAL,
  RPC_CHANNELS.memwise.INBOX_SEND_EVENT,
  RPC_CHANNELS.memwise.INBOX_DISMISS,
  RPC_CHANNELS.memwise.ENTITIES_LIST,
  RPC_CHANNELS.memwise.ENTITIES_TYPES,
  RPC_CHANNELS.memwise.FILES_UPLOAD,
  RPC_CHANNELS.memwise.CHAT_OPEN,
] as const

/** Largest upload accepted through the API (base64 travels inside one WS message). */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
/** Cap on the hidden case digest an anchored chat starts with. */
const DIGEST_MAX_CHARS = 16_000
/** Of that, the share a step's journal may take. */
const DIGEST_JOURNAL_CHARS = 9_000

const dto = () => import('../../memwise/dto')

// Refusals carry a code the screens translate (`memwise.result.<code>`); the English is the fallback.
const SUBMIT_MESSAGES: Record<string, string> = {
  forbidden: 'This step is for someone with a different role.',
  invalid: 'Some answers need fixing.',
  stale: 'This step was already answered or has moved on.',
  missing: 'That step was not found.',
  'unknown-outcome': 'That is not one of the choices for this step.',
}
const APPROVAL_MESSAGES: Record<string, string> = {
  forbidden: 'You are not one of the people who can decide this.',
  expired: 'This request is no longer waiting; the step has moved on.',
  missing: 'That request was not found.',
  approved: 'It was already approved.',
  rejected: 'It was already turned down.',
}
const EVENT_MESSAGES: Record<string, string> = {
  missing: 'That case was not found.',
  finished: 'This case has finished.',
  not_accepted: 'That is not something this step accepts now.',
  use_submit: 'This step is answered from its form in the inbox.',
  forbidden: 'This needs someone with a different role.',
  already: 'This was already answered.',
}
const refusal = (code: string, message: string): MwSubmitResult => ({ applied: false, code, message })

function clientOf(ctx: RequestContext): ClientIdentity {
  return { clientId: ctx.clientId, personId: ctx.personId ?? null }
}

function requireService(): MemwiseService {
  const svc = getMemwiseService()
  if (!svc) throw new Error(getMemwiseHostStatus().message ?? 'Playbooks are not running.')
  return svc
}

/** Calls decideApproval with the deciding actor (Phase 2 signature, second argument). */
type DecideWithActor = (decision: ApprovalDecision, by?: Actor) => ReturnType<Kernel['decideApproval']>

// ---------------------------------------------------------------- the API, as plain functions

/** The handler implementations, callable directly (tests) or through `registerMemwiseHandlers`. */
export function createMemwiseApi(deps: Pick<HandlerDeps, 'sessionManager' | 'platform'>) {
  const log = deps.platform.logger

  async function status(ctx: RequestContext): Promise<MwStatus> {
    const host = getMemwiseHostStatus()
    const svc = getMemwiseService()
    const base = {
      modelConfigured: host.modelConfigured,
      ...(host.projectDir ? { projectDir: host.projectDir } : {}),
      diagnostics: host.diagnostics,
    }
    if (!svc) return { ready: false, ...(host.message ? { message: host.message } : {}), canActAs: false, ...base }
    const { toPerson } = await dto()
    const me = await svc.personFor(clientOf(ctx)).catch(() => undefined)
    return {
      ready: host.phase === 'ready',
      ...(host.message ? { message: host.message } : {}),
      ...(me ? { me: toPerson(me) } : {}),
      canActAs: svc.canActAs(clientOf(ctx)),
      ...(ctx.personId ? { signedIn: true } : {}),
      ...base,
      modelConfigured: svc.modelConfigured,
      projectDir: svc.projectDir,
    }
  }

  async function begin(ctx: RequestContext): Promise<{ svc: MemwiseService; actor: PersonActor; c: DtoContext; d: Awaited<ReturnType<typeof dto>> }> {
    const svc = requireService()
    const [actor, c, d] = await Promise.all([svc.actorFor(clientOf(ctx)), svc.context(), dto()])
    return { svc, actor, c, d }
  }

  async function policyFor(svc: MemwiseService, workflowId: string, stepId: string): Promise<CompiledPolicy | undefined> {
    try { return await svc.kernel.effectivePolicy(workflowId, stepId) } catch { return undefined }
  }

  /** The case is back at a step it already did: the step run just before says why. */
  function returnedNote(v: CaseView | undefined, stepRunId: string, stepId: string, title: (stepId: string) => string): MwReturnedNote | undefined {
    const runs = v?.stepRuns ?? []
    const i = runs.findIndex((r) => r.stepRunId === stepRunId)
    if (i <= 0 || !runs.slice(0, i).some((r) => r.stepId === stepId)) return undefined
    const prev = runs[i - 1]!
    const text = prev.comment?.trim() || prev.rationale?.trim()
    if (!text || !prev.outcome) return undefined
    return {
      stepTitle: title(prev.stepId), outcome: prev.outcome, text,
      ...(prev.decidedBy ? { by: prev.decidedBy } : {}), ...(prev.finishedAt ? { at: prev.finishedAt } : {}),
    }
  }

  async function enrichInbox(svc: MemwiseService, actor: PersonActor, c: DtoContext, d: Awaited<ReturnType<typeof dto>>, items: InboxItem[]): Promise<MwInboxItem[]> {
    const views = new Map<string, Promise<CaseView | undefined>>()
    const view = (caseId: string) => {
      if (!views.has(caseId)) views.set(caseId, svc.kernel.getCaseView(caseId, actor).catch(() => undefined))
      return views.get(caseId)!
    }
    const titleOf = (v: CaseView | undefined, caseId: string) => {
      if (!v) return caseId
      const wf = c.project.workflows[v.summary.workflowId]
      return d.caseTitle(Object.fromEntries(Object.entries(v.values).map(([k, x]) => [k, x.hidden ? undefined : x.value])), caseId, wf?.caseType)
    }
    const out: MwInboxItem[] = []
    for (const item of items) {
      const v = await view(item.caseId)
      const caseTitle = titleOf(v, item.caseId)
      const wf = c.project.workflows[item.workflowId]
      const values = v?.values ?? {}
      switch (item.kind) {
        case 'input':
        case 'decision': {
          const step = wf?.steps[item.stepId]
          const context = step ? d.toCaseValues(values, d.readFields(step).filter((f) => f in values)) : {}
          const common = {
            id: item.id, stepRunId: item.stepRunId, caseId: item.caseId, runId: item.runId, caseTitle,
            workflowId: item.workflowId, stepTitle: d.stateTitle(wf, item.stepId),
            ...(item.assignee ? { assignee: item.assignee } : {}),
            outcomes: [...(step?.outcomes ?? [])], context, since: item.since, ...(item.dueAt ? { dueAt: item.dueAt } : {}),
          }
          if (item.kind === 'input' && wf && step) {
            const fields = d.stepWriteFields(c, wf, step)
            const returned = returnedNote(v, item.stepRunId, item.stepId, (id) => d.stateTitle(wf, id))
            out.push({
              kind: 'input', ...common, fields, prefill: d.toCaseValues(values, fields.map((f) => f.name).filter((f) => f in values)),
              ...(returned ? { returned } : {}),
            })
          } else {
            out.push({ kind: 'decision', ...common, instructions: step?.instructions ?? '' })
          }
          break
        }
        case 'approval': {
          const a = item.approval
          const policy = await policyFor(svc, item.workflowId, item.stepId)
          out.push({
            kind: 'approval', id: item.id, approvalId: a.id, stepRunId: a.stepRunId, caseId: item.caseId, runId: item.runId,
            caseTitle, workflowId: item.workflowId, stepTitle: d.stateTitle(wf, item.stepId), tool: a.tool, effect: a.effect,
            preview: { summary: a.preview.summary, ...(a.preview.detail !== undefined ? { detail: a.preview.detail } : {}) },
            reason: d.approvalReason(c.project, policy, a.tool, a.effect), since: item.since,
          })
          break
        }
        case 'attention': {
          const stopped = /^stopped(: )?/.exec(item.reason)
          const stopReason = stopped ? item.reason.slice(stopped[0].length).trim() : ''
          out.push({
            kind: 'attention', id: item.id, caseId: item.caseId, runId: item.runId, caseTitle, workflowId: item.workflowId,
            state: item.state, reason: item.reason, reasonCode: stopped ? 'stopped' : 'waiting',
            ...(stopReason ? { stopReason } : {}), events: [...item.events], since: item.since,
          })
          break
        }
        case 'reminder':
          out.push({
            kind: 'reminder', id: item.id, caseId: item.caseId, runId: item.runId, caseTitle, workflowId: item.workflowId,
            stepTitle: d.stateTitle(wf, item.stepId), text: item.text,
            ...(/^Reminder: .* is still waiting\.$/.test(item.text) ? { code: 'still_waiting' as const } : {}), since: item.since,
          })
          break
      }
    }
    return out
  }

  async function caseDigest(svc: MemwiseService, actor: PersonActor, c: DtoContext, d: Awaited<ReturnType<typeof dto>>, anchor: MwOpenChatInput['anchor']): Promise<{ title: string; digest: string; caseId?: string }> {
    const clip = (v: unknown, n = 600) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v)
      return s && s.length > n ? `${s.slice(0, n)}…` : s
    }
    if (anchor.kind === 'workflow') {
      const wf = c.project.workflows[anchor.id]
      if (!wf) throw new Error('That playbook was not found.')
      const steps = d.orderStates(wf).map((s, i) => `${i + 1}. ${d.stateTitle(wf, s)} (${s})${wf.steps[s] ? ` — ${wf.steps[s]!.performer}` : ''}; on: ${JSON.stringify(wf.states[s]!.on)}`)
      return { title: wf.title ?? wf.id, digest: [`Playbook "${wf.title ?? wf.id}" (${wf.id}, version ${wf.version}).`, 'Steps:', ...steps].join('\n') }
    }
    let caseId = anchor.id
    let stepRecord: Awaited<ReturnType<Kernel['getStepRecord']>> | undefined
    if (anchor.kind === 'step') {
      stepRecord = await svc.kernel.getStepRecord(anchor.id)
      if (!stepRecord) throw new Error('That step was not found.')
      caseId = stepRecord.caseId
    }
    const v = await svc.kernel.getCaseView(caseId, actor)
    if (!v) throw new Error('That case was not found.')
    const mw = d.toCase(c, v)
    const lines: string[] = [
      `Case "${mw.title}" (${mw.caseId}) on the playbook ${mw.workflowId}, now at "${mw.stateTitle}" (${mw.state}, ${mw.status}).`,
      'Values:',
      ...Object.entries(mw.values).filter(([, x]) => !x.hidden).map(([k, x]) => `- ${k}: ${clip(x.value)} (${x.provenance.kind}${x.tainted ? ', from an uploaded document' : ''})`),
      'Steps so far:',
      ...mw.timeline.map((t) => `- ${t.title} [${t.stepRunId}] attempt ${t.attempt}: ${t.status}${t.outcome ? ` → ${t.outcome}` : ''}${t.decidedBy ? ` by ${t.decidedBy}` : ''}${t.comment ? ` ("${clip(t.comment, 300)}")` : ''}${t.rationale ? `; why: ${clip(t.rationale, 400)}` : ''}`),
    ]
    if (stepRecord) {
      // The same view of the record the person gets on screen: fields they may not see are left
      // out, and so are the journal bodies of a step that handles them.
      const rec = d.toStepRecord(c.project, stepRecord, v.stepRuns.find((s) => s.stepRunId === stepRecord!.stepRunId), actor)
      lines.push(`Step record ${rec.stepRunId} (${rec.title}):`)
      const outputs = Object.fromEntries(Object.entries(rec.outputs).filter(([, x]) => !x.hidden).map(([k, x]) => [k, x.value]))
      lines.push(`- outputs: ${clip(outputs, 1500)}`)
      for (const cp of rec.checkpoint) lines.push(`- checkpoint "${cp.rule}": ${cp.passed ? 'passed' : 'failed'}${cp.reason ? ` (${cp.reason})` : ''}`)
      if (rec.restricted) lines.push('- (details of the calls below are not shown: the step handles fields this person may not see)')
      // Journal under its own budget, so a long one can't crowd out the rest; past it, names only
      let used = 0
      let skipped = 0
      for (const j of rec.journal) {
        const full = `- [${j.key}] ${j.kind} ${j.name}${j.redacted ? (j.failed ? ' (failed)' : '') : `: ${clip(j.request, 300)}${j.response !== undefined ? ` → ${clip(j.response, 400)}` : ''}${j.error ? ` (error: ${clip(j.error, 200)})` : ''}`}`
        const line = used + full.length <= DIGEST_JOURNAL_CHARS ? full : `- [${j.key}] ${j.kind} ${j.name}`
        if (used + line.length > DIGEST_JOURNAL_CHARS) { skipped++; continue }
        used += line.length + 1
        lines.push(line)
      }
      if (skipped) lines.push(`- … ${skipped} more journal entries not shown`)
    }
    let digest = lines.join('\n')
    if (digest.length > DIGEST_MAX_CHARS) digest = `${digest.slice(0, DIGEST_MAX_CHARS)}\n… (shortened)`
    return { title: mw.title, digest, caseId }
  }

  return {
    status,

    async listPeople(ctx: RequestContext): Promise<MwPerson[]> {
      const { svc, d } = await begin(ctx)
      return (await svc.kernel.people.list()).filter((p) => !p.disabled).map(d.toPerson)
    },

    async actAs(ctx: RequestContext, personId: string): Promise<MwStatus> {
      const svc = requireService()
      await svc.actAs(clientOf(ctx), personId)
      return status(ctx)
    },

    async createPerson(ctx: RequestContext, input: { name: string; email: string; roles?: string[] }): Promise<MwPerson> {
      const { svc, d, actor } = await begin(ctx)
      if (!svc.canActAs(clientOf(ctx)) && actor.personId !== svc.owner.id) {
        throw new Error('Only the owner of this install can add people.')
      }
      return d.toPerson(await svc.kernel.people.create({ name: input.name, email: input.email, roles: input.roles ?? [] }))
    },

    async listRoles(ctx: RequestContext): Promise<MwRole[]> {
      const { svc, d } = await begin(ctx)
      return (await svc.kernel.people.roles()).map(d.toRole)
    },

    async listPlaybooks(ctx: RequestContext): Promise<MwPlaybookSummary[]> {
      const { svc, actor, c, d } = await begin(ctx)
      const [cases, inbox] = await Promise.all([svc.kernel.listCases({ limit: 10_000 }, actor), svc.kernel.inbox(actor)])
      return Object.values(c.project.workflows).map((wf) => ({
        id: wf.id,
        version: wf.version,
        title: wf.title ?? d.humanize(wf.id),
        stepCount: Object.keys(wf.steps).length,
        open: cases.filter((s) => s.workflowId === wf.id && s.status === 'active').length,
        waitingOnMe: inbox.filter((i) => i.workflowId === wf.id && i.kind !== 'reminder').length,
        done: cases.filter((s) => s.workflowId === wf.id && s.status === 'done').length,
      }))
    },

    async getPlaybook(ctx: RequestContext, id: string): Promise<MwPlaybook> {
      const { svc, c, d } = await begin(ctx)
      const wf = c.project.workflows[id]
      if (!wf) throw new Error('That playbook was not found.')
      const policies: Record<string, CompiledPolicy | undefined> = {}
      for (const stepId of Object.keys(wf.steps)) policies[stepId] = await policyFor(svc, wf.id, stepId)
      const { startFields } = await import('@memwise/runtime')
      return { ...d.toPlaybook(c, wf, policies), startFields: startFields(wf) }
    },

    async getLiveCounts(ctx: RequestContext, id: string): Promise<MwLiveCounts> {
      const { svc } = await begin(ctx)
      const live = await svc.kernel.liveCounts(id)
      return { workflowId: live.workflowId, byState: { ...live.byState }, edges: { ...live.edges } }
    },

    async listCases(ctx: RequestContext, filter: { workflowId?: string; status?: MwRunStatus } = {}): Promise<MwCaseSummary[]> {
      const { svc, actor, c, d } = await begin(ctx)
      const rows = await svc.kernel.listCases({
        ...(filter?.workflowId ? { workflowId: filter.workflowId } : {}),
        ...(filter?.status ? { status: filter.status } : {}),
      }, actor)
      return rows.map((s) => d.toCaseSummary(c.project, s))
    },

    async getCase(ctx: RequestContext, caseId: string): Promise<MwCase> {
      const { svc, actor, c, d } = await begin(ctx)
      const v = await svc.kernel.getCaseView(caseId, actor)
      if (!v) throw new Error('That case was not found.')
      return d.toCase(c, v)
    },

    async startCase(ctx: RequestContext, input: MwStartCaseInput): Promise<MwCaseSummary | MwStartCaseRefusal> {
      const { svc, actor, c, d } = await begin(ctx)
      if (!c.project.workflows[input.workflowId]) throw new Error('That playbook was not found.')
      let caseId: string
      try {
        ({ caseId } = await svc.kernel.startRun({ workflowId: input.workflowId, case: input.values ?? {}, by: actor.personId }))
      } catch (e) {
        // StartRunError: values that need fixing, reported per field like submitStep's
        const errors = (e as { status?: string; errors?: Record<string, string[]> })
        if (errors?.status === 'invalid' && errors.errors) {
          return { applied: false, errors: errors.errors, code: 'start.invalid', message: 'Some values need fixing.' }
        }
        throw e
      }
      const v = await svc.kernel.getCaseView(caseId, actor)
      if (!v) throw new Error('The case was started but could not be read back.')
      return d.toCaseSummary(c.project, v.summary)
    },

    async getStepRecord(ctx: RequestContext, stepRunId: string): Promise<MwStepRecord> {
      const { svc, actor, c, d } = await begin(ctx)
      const r = await svc.kernel.getStepRecord(stepRunId)
      if (!r) throw new Error('That step was not found.')
      const v = await svc.kernel.getCaseView(r.caseId, actor)
      if (!v) throw new Error('That case was not found.')
      return d.toStepRecord(c.project, r, v.stepRuns.find((s) => s.stepRunId === stepRunId), actor)
    },

    async explainStep(ctx: RequestContext, input: MwExplainInput): Promise<MwExplanation> {
      const { svc, actor } = await begin(ctx)
      const e = await svc.kernel.explain({ stepRunId: input.stepRunId, question: input.question, by: actor })
      return {
        id: e.id, stepRunId: e.stepRunId, question: e.question, answer: e.answer,
        cites: e.cites.map((x) => ({ kind: x.kind, ref: x.ref, label: x.label })), grounded: e.grounded, at: e.at,
      }
    },

    async listInbox(ctx: RequestContext): Promise<MwInboxItem[]> {
      const { svc, actor, c, d } = await begin(ctx)
      return enrichInbox(svc, actor, c, d, await svc.kernel.inbox(actor))
    },

    async submitStep(ctx: RequestContext, input: MwSubmitStepInput): Promise<MwSubmitResult> {
      const { svc, actor } = await begin(ctx)
      const r = await svc.kernel.submitStep({
        stepRunId: input.stepRunId, outcome: input.outcome,
        ...(input.values ? { values: input.values } : {}), ...(input.comment ? { comment: input.comment } : {}),
        by: actor,
      })
      const message = r.message ?? (r.applied ? undefined : SUBMIT_MESSAGES[r.status])
      const code = r.applied || !SUBMIT_MESSAGES[r.status] ? undefined : `submit.${r.status}`
      return { applied: r.applied, ...(r.errors ? { errors: r.errors } : {}), ...(message ? { message } : {}), ...(code ? { code } : {}) }
    },

    async decideApproval(ctx: RequestContext, input: MwDecideApprovalInput): Promise<MwSubmitResult> {
      const { svc, actor } = await begin(ctx)
      const decide = svc.kernel.decideApproval.bind(svc.kernel) as DecideWithActor
      const r = await decide({
        id: input.approvalId, status: input.status, by: actor.personId,
        ...(input.comment ? { comment: input.comment } : {}), at: new Date().toISOString(),
      }, actor)
      const status = r.status as string
      return r.applied || !APPROVAL_MESSAGES[status] ? { applied: r.applied } : refusal(`approval.${status}`, APPROVAL_MESSAGES[status]!)
    },

    async sendEvent(ctx: RequestContext, input: MwSendEventInput): Promise<MwSubmitResult> {
      const { svc, actor, c } = await begin(ctx)
      const run = await svc.kernel.getRun(input.runId)
      if (!run) return refusal('event.missing', EVENT_MESSAGES.missing!)
      if (run.status !== 'active') return refusal('event.finished', EVENT_MESSAGES.finished!)
      const state = c.project.workflows[run.workflowId]?.states[run.state]
      if (!state?.on[input.event]) return refusal('event.not_accepted', EVENT_MESSAGES.not_accepted!)
      // The kernel decides who may send it (the state's role; a person step only through
      // submitStep). The owner's own connection (desktop, or the server's admin token) acts for
      // the install; a person's sign-in always goes through the role check.
      const by: Actor = !ctx.personId && actor.personId === svc.owner.id ? { kind: 'system' } : actor
      const r = await svc.kernel.sendEvent(run.id, {
        type: input.event, by: actor.personId, ...(input.comment ? { comment: input.comment } : {}),
      }, { idemKey: `app:${run.enteredSeq}:${input.event}`, forSeq: run.enteredSeq, by })
      if (r.sent) return { applied: true }
      const reason = r.reason ?? 'already'
      return refusal(`event.${reason}`, r.message ?? EVENT_MESSAGES[reason] ?? EVENT_MESSAGES.already!)
    },

    /** Mark a reminder read: it was for this person or one of their roles. */
    async dismissInboxItem(ctx: RequestContext, itemId: string): Promise<MwSubmitResult> {
      const { svc, actor } = await begin(ctx)
      const id = typeof itemId === 'string' && itemId.startsWith('reminder:') ? itemId.slice('reminder:'.length) : null
      if (!id) return refusal('dismiss.unsupported', 'Only reminders can be marked as read.')
      const { PgNotificationStore } = await import('@memwise/db')
      const store = new PgNotificationStore()
      const note = await store.get(svc.kernel.pool, id)
      const mine = !!note && (note.personId === actor.personId || (!!note.role && actor.roles.includes(note.role)) || (!note.personId && !note.role))
      if (!note || !mine) return refusal('dismiss.missing', 'That reminder was not found.')
      await store.markRead(svc.kernel.pool, id)
      emitMemwiseChange({ kind: 'inbox' })
      return { applied: true }
    },

    async listEntities(ctx: RequestContext, entity: string): Promise<MwEntityRow[]> {
      const { svc, actor, d } = await begin(ctx)
      return (await svc.kernel.listEntities(entity, actor)).map(d.toEntityRow)
    },

    async listEntityTypes(ctx: RequestContext): Promise<MwEntityType[]> {
      const { c, d } = await begin(ctx)
      return Object.values(c.project.entities).map((e) => d.toEntityType(c, e))
    },

    async uploadFile(ctx: RequestContext, input: { name: string; mime: string; data: string }): Promise<MwDocument> {
      const { svc, actor } = await begin(ctx)
      if (!input?.name || typeof input.data !== 'string') throw new Error('Choose a file to upload.')
      const data = Buffer.from(input.data, 'base64')
      if (data.byteLength > MAX_UPLOAD_BYTES) throw new Error('That file is too large (the limit is 25 MB).')
      const doc = await svc.kernel.saveFile({ name: input.name, mime: input.mime || 'application/octet-stream', data: new Uint8Array(data) }, actor)
      return { id: doc.id, name: doc.name, mime: doc.mime, size: doc.size, sha256: doc.sha256 }
    },

    async openChat(ctx: RequestContext, workspaceId: string, input: MwOpenChatInput): Promise<{ sessionId: string }> {
      const { svc, actor, c, d } = await begin(ctx)
      const { title, digest } = await caseDigest(svc, actor, c, d, input.anchor)
      const session = await deps.sessionManager.createSession(workspaceId, { name: `About ${title}` })
      const { PgChatAnchorStore } = await import('@memwise/db')
      // The anchors table names cases and steps; a playbook anchor is stored the same way.
      await new PgChatAnchorStore().set(svc.kernel.pool, {
        chatId: session.id, anchorKind: input.anchor.kind as 'case' | 'step', anchorId: input.anchor.id, personId: actor.personId,
      })
      // The first turn carries the record as hidden context; the reply is a short summary the
      // person sees when the chat opens.
      const kind = input.anchor.kind === 'workflow' ? 'playbook' : input.anchor.kind
      const prompt = [
        `<memwise_context kind="${kind}" id="${input.anchor.id}">`,
        digest,
        '</memwise_context>',
        `This chat is about the ${kind} above. Answer only from this record; say "not recorded" when it does not say.`,
        'Start with two or three plain sentences on where it stands, then offer to answer questions about it.',
      ].join('\n')
      deps.sessionManager.sendMessage(session.id, prompt, undefined, undefined, { hidden: true }).catch((e: unknown) => {
        log.warn(`[memwise] anchored chat ${session.id}: first turn failed: ${e instanceof Error ? e.message : String(e)}`)
      })
      return { sessionId: session.id }
    },
  }
}

export type MemwiseApi = ReturnType<typeof createMemwiseApi>

export function registerMemwiseHandlers(server: RpcServer, deps: HandlerDeps): void {
  const api = createMemwiseApi(deps)
  const ch = RPC_CHANNELS.memwise
  // Every channel takes the workspace id first (remote workspaces route to their own server);
  // the kernel is one per server, so it is only used to open anchored chats.
  server.handle(ch.STATUS, (ctx) => api.status(ctx))
  server.handle(ch.PEOPLE_LIST, (ctx) => api.listPeople(ctx))
  server.handle(ch.PEOPLE_ACT_AS, (ctx, _ws: string, personId: string) => api.actAs(ctx, personId))
  server.handle(ch.PEOPLE_CREATE, (ctx, _ws: string, input) => api.createPerson(ctx, input))
  server.handle(ch.ROLES_LIST, (ctx) => api.listRoles(ctx))
  server.handle(ch.PLAYBOOKS_LIST, (ctx) => api.listPlaybooks(ctx))
  server.handle(ch.PLAYBOOKS_GET, (ctx, _ws: string, id: string) => api.getPlaybook(ctx, id))
  server.handle(ch.PLAYBOOKS_LIVE, (ctx, _ws: string, id: string) => api.getLiveCounts(ctx, id))
  server.handle(ch.CASES_LIST, (ctx, _ws: string, filter) => api.listCases(ctx, filter ?? {}))
  server.handle(ch.CASES_GET, (ctx, _ws: string, caseId: string) => api.getCase(ctx, caseId))
  server.handle(ch.CASES_START, (ctx, _ws: string, input) => api.startCase(ctx, input))
  server.handle(ch.STEPS_GET, (ctx, _ws: string, stepRunId: string) => api.getStepRecord(ctx, stepRunId))
  server.handle(ch.STEPS_EXPLAIN, (ctx, _ws: string, input) => api.explainStep(ctx, input))
  server.handle(ch.INBOX_LIST, (ctx) => api.listInbox(ctx))
  server.handle(ch.INBOX_SUBMIT, (ctx, _ws: string, input) => api.submitStep(ctx, input))
  server.handle(ch.INBOX_DECIDE_APPROVAL, (ctx, _ws: string, input) => api.decideApproval(ctx, input))
  server.handle(ch.INBOX_SEND_EVENT, (ctx, _ws: string, input) => api.sendEvent(ctx, input))
  server.handle(ch.INBOX_DISMISS, (ctx, _ws: string, itemId: string) => api.dismissInboxItem(ctx, itemId))
  server.handle(ch.ENTITIES_LIST, (ctx, _ws: string, entity: string) => api.listEntities(ctx, entity))
  server.handle(ch.ENTITIES_TYPES, (ctx) => api.listEntityTypes(ctx))
  server.handle(ch.FILES_UPLOAD, (ctx, _ws: string, input) => api.uploadFile(ctx, input))
  server.handle(ch.CHAT_OPEN, (ctx, ws: string, input) => api.openChat(ctx, ws, input))

  onMemwiseChange((change) => {
    pushTyped(server, RPC_CHANNELS.memwise.CHANGED, { to: 'all' }, change)
  })
}
