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
  MwBuildPlaybookInput, MwBuildPlaybookResult, MwCheckDraftInput, MwCreateDraftInput, MwDraft, MwDraftEditInput,
  MwDraftReport, MwDraftSummary, MwExampleFromCaseInput, MwExampleFromCaseResult, MwSubmitDraftResult, MwVersion,
  MwWriteDraftInput, MwWriteDraftResult,
} from '@memwise/shared/protocol'
import type { ApprovalDecision, DraftDiff, DraftMeta } from '@memwise/defs'
import type { CompiledPolicy } from '@memwise/policy'
import type { Actor, CaseView, InboxItem } from '@memwise/runtime'
import { pushTyped, type RequestContext, type RpcServer } from '@memwise/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { emitMemwiseChange, getMemwiseHostStatus, getMemwiseService, onMemwiseChange } from '../../memwise/host'
import type { ClientIdentity, Kernel, MemwiseService, PersonActor } from '../../memwise/service'
import type { DraftFacts, DtoContext } from '../../memwise/dto'
import {
  authoringOf, conversationBlock, conversationState, draftForRun, isConversationStep, kickoffMessage, personName, plainValues,
  sendBackNote, sentBackMessage,
  type KernelWithAuthoring,
} from '../../memwise/conversation'

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
  // Phase 3
  RPC_CHANNELS.memwise.PLAYBOOKS_VERSIONS,
  RPC_CHANNELS.memwise.PLAYBOOKS_BUILD,
  RPC_CHANNELS.memwise.DRAFTS_LIST,
  RPC_CHANNELS.memwise.DRAFTS_GET,
  RPC_CHANNELS.memwise.DRAFTS_CREATE,
  RPC_CHANNELS.memwise.DRAFTS_WRITE,
  RPC_CHANNELS.memwise.DRAFTS_KEEP,
  RPC_CHANNELS.memwise.DRAFTS_DISCARD_EDIT,
  RPC_CHANNELS.memwise.DRAFTS_DISCARD,
  RPC_CHANNELS.memwise.DRAFTS_CHECK,
  RPC_CHANNELS.memwise.DRAFTS_SUBMIT,
  RPC_CHANNELS.memwise.EXAMPLES_FROM_CASE,
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
const DRAFT_MESSAGES: Record<string, string> = {
  missing: 'That draft was not found.',
  not_open: 'This draft was already published or discarded.',
  edit_missing: 'That change was not found in the draft.',
  edit_not_pending: 'That change was already kept or discarded.',
  edit_conflict: 'The files changed again since that edit, so it cannot be undone on its own.',
  pending_edits: 'Keep or discard the changes from chat before sending the draft for review.',
  conflict: 'The live playbook changed since this draft was made; look at the conflicting files first.',
  write_failed: 'The draft could not be changed.',
  in_review: 'This draft is already waiting for approval.',
  in_chat: 'This draft is being built in a chat; finish it there.',
  errors: 'Fix the errors in the draft before sending it for review.',
  submit_failed: 'The draft could not be sent for review.',
  create_failed: 'The draft could not be made.',
  check_failed: 'The draft could not be checked.',
}
const refusal = (code: string, message: string): MwSubmitResult => ({ applied: false, code, message })
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** The meta playbooks that build and change playbooks (20 §3). */
const META_PLAYBOOKS = ['create-playbook', 'change-playbook']
/** Larger files are left out of `MwDraft.fileTexts` (the diff still shows them). */
const FILE_TEXT_MAX = 256_000

/** A meta playbook state that is its chat (conversation step): drafts there are finished from the chat. */
function inChatState(c: DtoContext, state: string): boolean {
  return META_PLAYBOOKS.some((id) => isConversationStep(c.project.workflows[id]?.steps[state]))
}

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
        case 'conversation': {
          const plain = plainValues(Object.fromEntries(Object.entries(values).filter(([, x]) => !x.hidden)))
          const { PgChatAnchorStore } = await import('@memwise/db')
          const chat = (await new PgChatAnchorStore().forAnchor(svc.kernel.pool, 'step', item.stepRunId, actor.personId).catch(() => []))[0]
          const authoring = (svc.kernel as KernelWithAuthoring).authoring
          const draft = authoring ? await draftForRun(authoring, item.runId, plain) : undefined
          out.push({
            kind: 'conversation', id: item.id, stepRunId: item.stepRunId, caseId: item.caseId, runId: item.runId,
            caseTitle: typeof plain.title === 'string' && plain.title.trim() ? plain.title.trim()
              : typeof plain.request === 'string' && plain.request.trim() ? plain.request.trim().slice(0, 80) : caseTitle,
            workflowId: item.workflowId, stepTitle: d.stateTitle(wf, item.stepId),
            ...(item.assignee ? { assignee: item.assignee } : {}),
            ...(chat ? { sessionId: chat.chatId } : {}),
            ...(draft ? { draftId: draft.id } : {}),
            since: item.since,
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

  async function peopleNames(svc: MemwiseService): Promise<Map<string, string>> {
    try { return new Map((await svc.kernel.people.list()).map((p) => [p.id, p.name])) } catch { return new Map() }
  }

  /** An ordinary chat about a case, step or playbook: its record goes into the chat's system prompt. */
  async function openExplainChat(svc: MemwiseService, actor: PersonActor, c: DtoContext, d: Awaited<ReturnType<typeof dto>>, workspaceId: string, anchor: MwOpenChatInput['anchor']): Promise<string> {
    const { title, digest } = await caseDigest(svc, actor, c, d, anchor)
    const session = await deps.sessionManager.createSession(workspaceId, { name: `About ${title}` })
    const { PgChatAnchorStore } = await import('@memwise/db')
    // The anchors table names cases and steps; a playbook anchor is stored the same way.
    await new PgChatAnchorStore().set(svc.kernel.pool, {
      chatId: session.id, anchorKind: anchor.kind as 'case' | 'step', anchorId: anchor.id, personId: actor.personId,
    })
    const kind = anchor.kind === 'workflow' ? 'playbook' : anchor.kind
    deps.sessionManager.setMemwiseContext(session.id, {
      anchor: { kind: anchor.kind, id: anchor.id },
      block: [
        digest,
        '',
        `This chat is about the ${kind} above. Answer only from this record; say "not recorded" when it does not say.`,
      ].join('\n'),
      personName: (await personName(svc, actor.personId)) ?? undefined,
    })
    kickoff(session.id, 'explain')
    return session.id
  }

  /**
   * The chat of a conversation step (building or changing a playbook): one per step and person.
   * Reuses the person's chat on this step, or on an earlier attempt of it in the same run (after a
   * review sent it back), re-anchoring it to the waiting attempt; otherwise makes one.
   */
  async function openConversationChat(svc: MemwiseService, actor: PersonActor, c: DtoContext, workspaceId: string, stepRunId: string): Promise<string> {
    const s = await conversationState(svc, stepRunId, actor)
    const wf = c.project.workflows[s.workflowId]
    const step = wf?.steps[s.stepId]
    if (step?.assignee && !actor.roles.includes(step.assignee)) {
      throw new Error(`This step is for someone with the ${step.assignee} role.`)
    }
    const { PgChatAnchorStore } = await import('@memwise/db')
    const store = new PgChatAnchorStore()
    const attempts = [s.stepRunId, ...(s.view?.stepRuns ?? []).filter((r) => r.stepId === s.stepId && r.stepRunId !== s.stepRunId).map((r) => r.stepRunId).reverse()]
    for (const id of attempts) {
      for (const a of await store.forAnchor(svc.kernel.pool, 'step', id, actor.personId)) {
        if (!(await deps.sessionManager.getSession(a.chatId).catch(() => null))) continue
        if (id !== s.stepRunId) {
          // A new attempt after the review sent it back: re-anchor the chat, refresh its context,
          // and pass the reviewer's comment on so the person needn't repeat it.
          await store.set(svc.kernel.pool, { chatId: a.chatId, anchorKind: 'step', anchorId: s.stepRunId, personId: actor.personId })
          const who = (await personName(svc, actor.personId)) ?? 'the person in this chat'
          deps.sessionManager.setMemwiseContext(a.chatId, {
            anchor: { kind: 'step', id: s.stepRunId }, conversation: true, block: await conversationBlock(svc, s, actor, who), personName: who,
          })
          const note = sendBackNote(s.view, s.stepRunId, s.stepId)
          if (note) {
            const by = (await personName(svc, note.by)) ?? undefined
            deps.sessionManager.sendMessage(a.chatId, sentBackMessage(note, by), undefined, undefined, { hidden: true }).catch((e: unknown) => {
              log.warn(`[memwise] chat ${a.chatId}: passing the review's comment on failed: ${errText(e)}`)
            })
          }
        }
        return a.chatId
      }
    }
    const v = s.values
    const changing = s.workflowId === 'change-playbook' || (!!s.draft && s.draft.kind === 'change')
    const playbookId = typeof v.playbook === 'string' && v.playbook ? v.playbook : s.draft?.workflowId
    const name = changing
      ? `Changing: ${(playbookId && c.project.workflows[playbookId]?.title) || (typeof v.title === 'string' && v.title) || playbookId || 'a playbook'}`
      : `Building: ${(typeof v.title === 'string' && v.title.trim()) || (typeof v.request === 'string' && v.request.trim().slice(0, 60)) || 'a new playbook'}`
    // Ask mode whatever the workspace default: drafting runs without prompts (draft writes are
    // allowed, D29), and the person is asked once before playbook_finish sends the draft for review.
    // Explore would refuse to finish; Execute would send it without asking.
    const session = await deps.sessionManager.createSession(workspaceId, { name, permissionMode: 'ask' })
    await store.set(svc.kernel.pool, { chatId: session.id, anchorKind: 'step', anchorId: s.stepRunId, personId: actor.personId })
    const who = (await personName(svc, actor.personId)) ?? 'the person in this chat'
    deps.sessionManager.setMemwiseContext(session.id, {
      anchor: { kind: 'step', id: s.stepRunId },
      conversation: true,
      block: await conversationBlock(svc, s, actor, who),
      personName: who,
    })
    kickoff(session.id, 'conversation')
    return session.id
  }

  /** The short hidden first turn, so the agent speaks first; its context is in the system prompt. */
  function kickoff(sessionId: string, kind: 'conversation' | 'explain'): void {
    deps.sessionManager.sendMessage(sessionId, kickoffMessage(kind), undefined, undefined, { hidden: true }).catch((e: unknown) => {
      log.warn(`[memwise] anchored chat ${sessionId}: first turn failed: ${errText(e)}`)
    })
  }

  /** Per request: draft facts (edits, report, the change run, names) for the DTOs. */
  function draftLookup(svc: MemwiseService, actor: PersonActor, c: DtoContext) {
    const authoring = authoringOf(svc)
    let names: Promise<Map<string, string>> | undefined
    let metaRuns: Promise<{ runId: string; caseId: string; state: string; status: string; draft?: string }[]> | undefined
    const activeMetaRuns = () => (metaRuns ??= (async () => {
      const out: { runId: string; caseId: string; state: string; status: string; draft?: string }[] = []
      for (const workflowId of META_PLAYBOOKS) {
        if (!c.project.workflows[workflowId]) continue
        const cases = await svc.kernel.listCases({ workflowId, status: 'active' }, actor).catch(() => [])
        for (const cs of cases) {
          const snap = await svc.kernel.getCase(cs.caseId).catch(() => undefined)
          const draft = snap?.values.draft?.value
          out.push({ runId: cs.runId, caseId: cs.caseId, state: cs.state, status: cs.status, ...(typeof draft === 'string' ? { draft } : {}) })
        }
      }
      return out
    })())
    async function runOf(meta: DraftMeta): Promise<DraftFacts['run']> {
      if (meta.runId) {
        const run = await svc.kernel.getRun(meta.runId).catch(() => undefined)
        if (run && run.status === 'active') return withChat({ runId: run.id, caseId: run.caseId, state: run.state, status: run.status })
      }
      const found = (await activeMetaRuns()).find((r) => r.draft === meta.id)
      if (found) return withChat({ runId: found.runId, caseId: found.caseId, state: found.state, status: found.status })
      if (meta.runId) {
        const run = await svc.kernel.getRun(meta.runId).catch(() => undefined)
        if (run) return withChat({ runId: run.id, caseId: run.caseId, state: run.state, status: run.status })
      }
      return undefined
    }
    /** An active change run still at its chat (the meta playbook's conversation step). */
    function withChat(run: NonNullable<DraftFacts['run']>): NonNullable<DraftFacts['run']> {
      return run.status === 'active' && inChatState(c, run.state) ? { ...run, inChat: true } : run
    }
    return {
      async facts(meta: DraftMeta, pre: { got?: Awaited<ReturnType<typeof authoring.getDraft>>; diff?: DraftDiff } = {}): Promise<DraftFacts> {
        const got = pre.got ?? (await authoring.getDraft(meta.id))
        if (!got) throw new Error(DRAFT_MESSAGES.missing)
        const diff = pre.diff ?? (meta.status === 'open' ? await authoring.diff(meta.id).catch(() => undefined) : undefined)
        const changedFiles = diff ? diff.files.length : new Set(got.edits.filter((e) => e.status !== 'discarded').flatMap((e) => e.files.map((f) => f.path))).size
        return {
          meta: got.meta, edits: got.edits, ...(got.report ? { report: got.report } : {}), contentHash: got.contentHash,
          run: await runOf(got.meta), changedFiles,
          playbookTitle: c.project.workflows[got.meta.workflowId]?.title ?? got.meta.title,
          names: await (names ??= peopleNames(svc)),
        }
      },
    }
  }

  /**
   * The draft's files as text for the step editor: every file of its playbook folder, and the
   * domain files it changes. Each read is bounded so one odd file can't stall the screen.
   */
  async function draftFileTexts(authoring: ReturnType<typeof authoringOf>, meta: DraftMeta, diff: DraftDiff | undefined): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    const listed = await authoring.read({ draftId: meta.id }).catch(() => undefined)
    const folder = `workflows/${meta.workflowId}/`
    const paths = new Set<string>(((listed as { files?: string[] } | undefined)?.files ?? []).filter((p) => p.startsWith(folder)))
    for (const f of diff?.files ?? []) {
      if (f.status !== 'deleted' && f.path.startsWith('domain/')) paths.add(f.path)
    }
    for (const path of [...paths].sort()) {
      const changed = diff?.files.find((f) => f.path === path)
      if (changed && typeof changed.after === 'string') { out[path] = changed.after; continue }
      const r = await authoring.read({ draftId: meta.id, path }).catch(() => undefined) as { content?: string | null } | undefined
      if (typeof r?.content === 'string' && r.content.length <= FILE_TEXT_MAX) out[path] = r.content
    }
    return out
  }

  /** The draft read as a playbook, with policies compiled from the draft's own files. */
  async function draftPlaybook(svc: MemwiseService, c: DtoContext, d: Awaited<ReturnType<typeof dto>>, draftId: string): Promise<MwPlaybook | undefined> {
    try {
      const { loadDraft } = await import('@memwise/defs')
      const loaded = await loadDraft(svc.projectDir, draftId)
      const wf = loaded.workflow
      if (!wf) return undefined
      const { compilePolicy, layersFor } = await import('@memwise/policy')
      const policies: Record<string, CompiledPolicy | undefined> = {}
      for (const step of Object.values(wf.steps)) {
        try { policies[step.id] = compilePolicy(layersFor({ ...(loaded.project.domainPolicy ? { domainPolicy: loaded.project.domainPolicy } : {}), workflow: wf, step })) } catch { /* shown without */ }
      }
      const ctxD: DtoContext = { ...c, project: loaded.project, diagnostics: loaded.diagnostics }
      const { startFields } = await import('@memwise/runtime')
      return { ...d.toPlaybook(ctxD, wf, policies), startFields: startFields(wf) }
    } catch {
      return undefined
    }
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
      if (input?.anchor?.kind === 'step') {
        const rec = await svc.kernel.getStepRecord(input.anchor.id)
        const step = rec ? c.project.workflows[rec.workflowId]?.steps[rec.stepId] : undefined
        if (rec && isConversationStep(step)) {
          const s = await conversationState(svc, rec.stepRunId, actor)
          // A finished conversation opens as an ordinary chat about it.
          if (s.status === 'waiting') return { sessionId: await openConversationChat(svc, actor, c, workspaceId, s.stepRunId) }
        }
      }
      return { sessionId: await openExplainChat(svc, actor, c, d, workspaceId, input.anchor) }
    },

    // ---------------------------------------------------------------- Phase 3 (20 §6)

    async listVersions(ctx: RequestContext, workflowId: string): Promise<MwVersion[]> {
      const { svc, d } = await begin(ctx)
      const versions = (svc.kernel as KernelWithAuthoring).versions
      if (!versions) return []
      const [rows, names] = await Promise.all([versions.call(svc.kernel, workflowId), peopleNames(svc)])
      return rows.map((v) => d.toVersion(v, names))
    },

    async buildPlaybook(ctx: RequestContext, workspaceId: string, input: MwBuildPlaybookInput = {}): Promise<MwBuildPlaybookResult> {
      const { svc, actor, c } = await begin(ctx)
      if (input.workflowId && !c.project.workflows[input.workflowId]) throw new Error('That playbook was not found.')
      // Checked before anything starts, so a refusal leaves no run behind (`build.forbidden`;
      // RPC errors carry only the message, which the dialog shows).
      const meta = c.project.workflows[input.workflowId ? 'change-playbook' : 'create-playbook']
      if (!meta) throw new Error('Building playbooks by chat is not set up in this project (the create-playbook and change-playbook playbooks are missing).')
      const assignee = meta.steps[meta.start]?.assignee
      if (assignee && !actor.roles.includes(assignee)) {
        throw Object.assign(new Error(`Building and changing playbooks is for someone with the ${assignee} role.`), { code: 'build.forbidden' })
      }
      const authoring = authoringOf(svc)
      const started = await authoring.startBuild({
        ...(input.workflowId ? { workflowId: input.workflowId } : {}),
        ...(input.request?.trim() ? { request: input.request.trim() } : {}),
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      }, actor)
      const sessionId = await openConversationChat(svc, actor, c, workspaceId, started.stepRunId)
      return { sessionId, runId: started.runId, caseId: started.caseId, stepRunId: started.stepRunId }
    },

    async listDrafts(ctx: RequestContext, filter: { workflowId?: string } = {}): Promise<MwDraftSummary[]> {
      const { svc, actor, c, d } = await begin(ctx)
      const authoring = authoringOf(svc)
      const metas = await authoring.listDrafts(filter?.workflowId ? { workflowId: filter.workflowId } : undefined)
      const lookup = draftLookup(svc, actor, c)
      const out: MwDraftSummary[] = []
      for (const meta of metas) {
        const facts = await lookup.facts(meta).catch(() => undefined)
        if (facts) out.push(d.toDraftSummary(facts))
      }
      return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    },

    async getDraft(ctx: RequestContext, draftId: string): Promise<MwDraft> {
      const { svc, actor, c, d } = await begin(ctx)
      const authoring = authoringOf(svc)
      const lookup = draftLookup(svc, actor, c)
      const got = await authoring.getDraft(draftId)
      if (!got) throw new Error(DRAFT_MESSAGES.missing)
      const diff = await authoring.diff(draftId).catch(() => undefined)
      const facts = await lookup.facts(got.meta, { got, diff })
      const pending = d.pendingEditByPath(got.edits)
      const diagnostics = await authoring.quickCheck(draftId).catch((e: unknown) => [{ severity: 'error' as const, code: 'draft-unreadable', message: errText(e) }])
      const playbook = await draftPlaybook(svc, c, d, draftId)
      return {
        ...d.toDraftSummary(facts),
        edits: got.edits.map((e) => d.toDraftEdit(e, facts.names)),
        files: (diff?.files ?? []).map((f) => d.toFileChange(f, pending)),
        ...(diff?.structure ? { structure: d.toStructuralDiff(diff.structure) } : {}),
        conflicts: [...(diff?.conflicts ?? [])],
        ...(got.report ? { report: d.toDraftReport(got.report, c) } : {}),
        reportStale: !!got.report && got.report.hash !== got.contentHash,
        ...(playbook ? { playbook } : {}),
        diagnostics: diagnostics.map(d.toDiagnostic),
        ...(got.meta.status === 'open' ? { fileTexts: await draftFileTexts(authoring, got.meta, diff) } : {}),
      }
    },

    async createDraft(ctx: RequestContext, input: MwCreateDraftInput): Promise<MwDraftSummary> {
      const { svc, actor, c, d } = await begin(ctx)
      if (!input?.workflowId?.trim()) throw new Error('Name the playbook the draft is for.')
      const kind = input.kind ?? (c.project.workflows[input.workflowId] ? 'change' : 'create')
      if (kind === 'change' && !c.project.workflows[input.workflowId]) throw new Error('That playbook was not found.')
      if (kind === 'create' && c.project.workflows[input.workflowId]) throw new Error('A playbook with that id already exists.')
      const meta = await authoringOf(svc).createDraft({
        workflowId: input.workflowId.trim(), title: input.title?.trim() || c.project.workflows[input.workflowId]?.title || d.humanize(input.workflowId), kind,
      }, actor)
      emitMemwiseChange({ kind: 'drafts', id: meta.id })
      return d.toDraftSummary(await draftLookup(svc, actor, c).facts(meta))
    },

    async writeDraft(ctx: RequestContext, input: MwWriteDraftInput): Promise<MwWriteDraftResult> {
      const { svc, actor, d } = await begin(ctx)
      const authoring = authoringOf(svc)
      const got = await authoring.getDraft(input?.draftId)
      if (!got) return { applied: false, diagnostics: [], code: 'draft.missing', message: DRAFT_MESSAGES.missing }
      if (got.meta.status !== 'open') return { applied: false, diagnostics: [], code: 'draft.not_open', message: DRAFT_MESSAGES.not_open }
      if (!Array.isArray(input.files) || !input.files.length) return { applied: false, diagnostics: [], code: 'draft.write_failed', message: 'Nothing to write.' }
      try {
        const { edit, diagnostics } = await authoring.write({
          draftId: input.draftId, files: input.files, summary: input.summary?.trim() || 'Edited in the app', via: 'editor',
        }, actor)
        emitMemwiseChange({ kind: 'drafts', id: input.draftId })
        return { applied: true, editId: edit.id, diagnostics: diagnostics.map(d.toDiagnostic) }
      } catch (e) {
        return { applied: false, diagnostics: [], code: 'draft.write_failed', message: errText(e) }
      }
    },

    async keepEdit(ctx: RequestContext, input: MwDraftEditInput): Promise<MwSubmitResult> {
      const { svc, actor } = await begin(ctx)
      const authoring = authoringOf(svc)
      const got = await authoring.getDraft(input?.draftId)
      if (!got) return refusal('draft.missing', DRAFT_MESSAGES.missing!)
      if (got.meta.status !== 'open') return refusal('draft.not_open', DRAFT_MESSAGES.not_open!)
      const edit = got.edits.find((e) => e.id === input.editId)
      if (!edit) return refusal('edit.missing', DRAFT_MESSAGES.edit_missing!)
      if (edit.status !== 'pending') return refusal('edit.not_pending', DRAFT_MESSAGES.edit_not_pending!)
      const r = await authoring.keepEdit(input.draftId, input.editId, actor)
      if (!r.applied) return refusal('edit.missing', r.message ?? DRAFT_MESSAGES.edit_missing!)
      emitMemwiseChange({ kind: 'drafts', id: input.draftId })
      return { applied: true }
    },

    async discardEdit(ctx: RequestContext, input: MwDraftEditInput): Promise<MwSubmitResult> {
      const { svc, actor } = await begin(ctx)
      const authoring = authoringOf(svc)
      const got = await authoring.getDraft(input?.draftId)
      if (!got) return refusal('draft.missing', DRAFT_MESSAGES.missing!)
      if (got.meta.status !== 'open') return refusal('draft.not_open', DRAFT_MESSAGES.not_open!)
      const edit = got.edits.find((e) => e.id === input.editId)
      if (!edit) return refusal('edit.missing', DRAFT_MESSAGES.edit_missing!)
      if (edit.status !== 'pending') return refusal('edit.not_pending', DRAFT_MESSAGES.edit_not_pending!)
      const r = await authoring.discardEdit(input.draftId, input.editId, actor)
      if (!r.applied) {
        const names = r.conflicts?.length ? ` (${r.conflicts.join(', ')})` : ''
        return r.conflicts?.length
          ? refusal('edit.conflict', `${DRAFT_MESSAGES.edit_conflict}${names}`)
          : refusal('edit.missing', r.message ?? DRAFT_MESSAGES.edit_missing!)
      }
      emitMemwiseChange({ kind: 'drafts', id: input.draftId })
      return { applied: true }
    },

    async discardDraft(ctx: RequestContext, draftId: string): Promise<MwSubmitResult> {
      const { svc, actor } = await begin(ctx)
      const authoring = authoringOf(svc)
      const got = await authoring.getDraft(draftId)
      if (!got) return refusal('draft.missing', DRAFT_MESSAGES.missing!)
      if (got.meta.status !== 'open') return refusal('draft.not_open', DRAFT_MESSAGES.not_open!)
      await authoring.discardDraft(draftId, actor)
      emitMemwiseChange({ kind: 'drafts', id: draftId })
      return { applied: true }
    },

    async checkDraft(ctx: RequestContext, input: MwCheckDraftInput): Promise<MwDraftReport> {
      const { svc, c, d } = await begin(ctx)
      const authoring = authoringOf(svc)
      const got = await authoring.getDraft(input?.draftId)
      if (!got) throw new Error(DRAFT_MESSAGES.missing)
      const report = await authoring.check(input.draftId, { ...(typeof input.pastCases === 'number' ? { pastCases: input.pastCases } : {}) })
      emitMemwiseChange({ kind: 'drafts', id: input.draftId })
      return d.toDraftReport(report, c)
    },

    async submitDraft(ctx: RequestContext, draftId: string): Promise<MwSubmitDraftResult> {
      const { svc, actor, c } = await begin(ctx)
      const authoring = authoringOf(svc)
      const got = await authoring.getDraft(draftId)
      if (!got) return { applied: false, code: 'draft.missing', message: DRAFT_MESSAGES.missing }
      if (got.meta.status !== 'open') return { applied: false, code: 'draft.not_open', message: DRAFT_MESSAGES.not_open }
      const facts = await draftLookup(svc, actor, c).facts(got.meta, { got })
      if (facts.run?.status === 'active') {
        // Still in its chat (the meta playbook's conversation step), or past it on the way to review.
        return facts.run.inChat
          ? { applied: false, code: 'draft.in_chat', message: DRAFT_MESSAGES.in_chat, runId: facts.run.runId, caseId: facts.run.caseId }
          : { applied: false, code: 'draft.in_review', message: DRAFT_MESSAGES.in_review, runId: facts.run.runId, caseId: facts.run.caseId }
      }
      const pending = got.edits.filter((e) => e.status === 'pending').length
      if (pending) return { applied: false, code: 'draft.pending_edits', message: `${DRAFT_MESSAGES.pending_edits} (${pending})` }
      const errors = (await authoring.quickCheck(draftId)).filter((x) => x.severity === 'error')
      if (errors.length) return { applied: false, code: 'draft.errors', message: `${DRAFT_MESSAGES.errors} (${errors.length})` }
      const conflicts = (await authoring.diff(draftId).catch(() => undefined))?.conflicts ?? []
      if (conflicts.length) return { applied: false, code: 'draft.conflict', message: `${DRAFT_MESSAGES.conflict} (${conflicts.join(', ')})` }
      try {
        const r = await authoring.submitDraft(draftId, actor)
        emitMemwiseChange({ kind: 'drafts', id: draftId })
        return { applied: true, runId: r.runId, caseId: r.caseId }
      } catch (e) {
        return { applied: false, code: 'draft.submit_failed', message: errText(e) }
      }
    },

    async exampleFromCase(ctx: RequestContext, input: MwExampleFromCaseInput): Promise<MwExampleFromCaseResult> {
      const { svc, actor } = await begin(ctx)
      if (!input?.caseId) return { applied: false, code: 'example.missing', message: 'That case was not found.' }
      const v = await svc.kernel.getCaseView(input.caseId, actor)
      if (!v) return { applied: false, code: 'example.missing', message: 'That case was not found.' }
      if (input.draftId) {
        const got = await authoringOf(svc).getDraft(input.draftId)
        if (!got || got.meta.status !== 'open') return { applied: false, code: 'example.no_draft', message: 'That draft is not open for changes any more; save the example into a new draft.' }
      }
      try {
        const r = await authoringOf(svc).exampleFromCase({
          caseId: input.caseId,
          ...(input.name?.trim() ? { name: input.name.trim() } : {}),
          ...(input.correction ? { correction: input.correction } : {}),
          ...(input.draftId ? { draftId: input.draftId } : {}),
        }, actor)
        emitMemwiseChange({ kind: 'drafts', id: r.draftId })
        return { applied: true, draftId: r.draftId, path: r.path }
      } catch (e) {
        return { applied: false, code: 'example.failed', message: errText(e) }
      }
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
  // Phase 3
  server.handle(ch.PLAYBOOKS_VERSIONS, (ctx, _ws: string, workflowId: string) => api.listVersions(ctx, workflowId))
  server.handle(ch.PLAYBOOKS_BUILD, (ctx, ws: string, input) => api.buildPlaybook(ctx, ws, input ?? {}))
  server.handle(ch.DRAFTS_LIST, (ctx, _ws: string, filter) => api.listDrafts(ctx, filter ?? {}))
  server.handle(ch.DRAFTS_GET, (ctx, _ws: string, draftId: string) => api.getDraft(ctx, draftId))
  server.handle(ch.DRAFTS_CREATE, (ctx, _ws: string, input) => api.createDraft(ctx, input))
  server.handle(ch.DRAFTS_WRITE, (ctx, _ws: string, input) => api.writeDraft(ctx, input))
  server.handle(ch.DRAFTS_KEEP, (ctx, _ws: string, input) => api.keepEdit(ctx, input))
  server.handle(ch.DRAFTS_DISCARD_EDIT, (ctx, _ws: string, input) => api.discardEdit(ctx, input))
  server.handle(ch.DRAFTS_DISCARD, (ctx, _ws: string, draftId: string) => api.discardDraft(ctx, draftId))
  server.handle(ch.DRAFTS_CHECK, (ctx, _ws: string, input) => api.checkDraft(ctx, input))
  server.handle(ch.DRAFTS_SUBMIT, (ctx, _ws: string, draftId: string) => api.submitDraft(ctx, draftId))
  server.handle(ch.EXAMPLES_FROM_CASE, (ctx, _ws: string, input) => api.exampleFromCase(ctx, input))

  onMemwiseChange((change) => {
    pushTyped(server, RPC_CHANNELS.memwise.CHANGED, { to: 'all' }, change)
  })
}
