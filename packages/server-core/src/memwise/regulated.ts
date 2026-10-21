/**
 * Stage 5 of "Projects and pages" (docs/memwise/26-projects-and-pages.md §7, §8; D115–D119):
 * regulated projects, as the app sees them. The kernel's change requests, audit log, inspectors
 * and TMF index mapped to the Mw* shapes; the `<memwise_context>` block of a chat that edits a
 * change request; and that chat's `playbook_*` tools (`buildChangeToolCallbacks`), which write
 * into the request's draft, validate it on past cases, and never publish it.
 *
 * No kernel imports at module level (SessionManager imports the chat tools that use this).
 */
import type {
  MwChangeRequest, MwChangeRequestSummary, MwChangeSignResult, MwChangeValidation, MwInboxItem, MwInspectorLink,
  MwInspectorQuestion, MwTmfIndex, MwAuditEntry, MwAuditVerifyResult,
} from '@memwise/shared/protocol'
import type { MemwiseToolCallbacks, PlaybookToolDiagnostic } from '@memwise/session-tools-core'
import type { Diagnostic } from '@memwise/defs'
import type {
  AuditEntryView, AuditVerifyResult, ChangeRequestSummary, ChangeRequestView, ChangeSignResult, ChangeValidation, InboxItem,
  InspectorLinkView, InspectorQuestionView, KernelRegulated, TmfIndex,
} from '@memwise/runtime'
import { emitMemwiseChange, getMemwiseService } from './host'
import { authoringOf, personName } from './conversation'
import type { MemwiseService, PersonActor } from './service'

// ---------------------------------------------------------------- the kernel's services

/** The kernel's Stage 5 services; refused clearly by a kernel that has none yet. */
export function regulatedOf(svc: MemwiseService): KernelRegulated {
  const k = svc.kernel as Partial<KernelRegulated>
  if (!k.changes || !k.auditLog || !k.inspectors || !k.tmf) throw new Error('Change requests and inspections are not available in this version.')
  return k as KernelRegulated
}

// ---------------------------------------------------------------- DTOs

export function toChangeSummary(s: ChangeRequestSummary): MwChangeRequestSummary {
  return {
    id: s.id, number: s.number, label: s.label, project: s.project, workflowId: s.workflowId, playbookTitle: s.playbookTitle,
    title: s.title, status: s.status, raisedBy: s.raisedBy, raisedAt: s.raisedAt, updatedAt: s.updatedAt,
    ...(s.validation ? { validation: { ...s.validation } } : {}),
  }
}

export function toChangeValidation(v: ChangeValidation): MwChangeValidation {
  return { ...v, results: v.results.map((r) => ({ ...r, decided: { ...r.decided }, ...(r.failedRules ? { failedRules: r.failedRules.map((f) => ({ ...f })) } : {}) })) }
}

/** The request as its page shows it; the chat that edits it is a session (`sessionId`). */
export function toChangeRequest(v: ChangeRequestView): MwChangeRequest {
  const { chatId, validations, ...rest } = v
  return {
    ...rest,
    ...toChangeSummary(v),
    validations: validations.map(toChangeValidation),
    ...(chatId ? { sessionId: chatId } : {}),
  }
}

export function toChangeSignResult(r: ChangeSignResult): MwChangeSignResult {
  return {
    applied: r.applied, status: r.status,
    ...(r.message ? { message: r.message } : {}),
    ...(r.view ? { changeRequest: toChangeRequest(r.view) } : {}),
    ...(r.published ? { published: { ...r.published } } : {}),
  }
}

export function toAuditEntry(e: AuditEntryView): MwAuditEntry {
  return {
    seq: e.seq, id: e.id, project: e.project, at: e.at, actorKind: e.actorKind, actor: e.actor, actorLabel: e.actorLabel,
    action: e.action, entity: e.entity, recordId: e.recordId, caseId: e.caseId, data: e.data, prevHash: e.prevHash, hash: e.hash,
    ...(e.recordTitle ? { recordTitle: e.recordTitle } : {}),
    ...(e.stepTitle ? { stepTitle: e.stepTitle } : {}),
    ...(e.playbookTitle ? { playbookTitle: e.playbookTitle } : {}),
  }
}

export function toAuditVerify(r: AuditVerifyResult): MwAuditVerifyResult {
  return {
    ok: r.ok, entries: r.entries, chain: { ...r.chain, ...(r.chain.brokenAt ? { brokenAt: { ...r.chain.brokenAt } } : {}) },
    ...(r.signature ? { signature: { ...r.signature } } : {}), message: r.message,
  }
}

export function toInspectorLink(l: InspectorLinkView): MwInspectorLink {
  return { ...l, inspectors: l.inspectors.map((p) => ({ ...p })), createdBy: { ...l.createdBy }, questions: { ...l.questions } }
}

export function toInspectorQuestion(q: InspectorQuestionView): MwInspectorQuestion {
  return { ...q, ...(q.record ? { record: { ...q.record } } : {}), ...(q.answeredBy ? { answeredBy: { ...q.answeredBy } } : {}) }
}

export function toTmfIndex(t: TmfIndex): MwTmfIndex {
  return structuredClone(t) as MwTmfIndex
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The Stage 5 inbox items (no case): a sign-off waiting, an inspector's question. */
export function toRegulatedInboxItem(item: Extract<InboxItem, { kind: 'change-request' | 'inspector-question' }>): MwInboxItem {
  if (item.kind === 'change-request') {
    const cr = item.changeRequest
    return {
      kind: 'change-request', id: item.id, domain: cr.project, workflowId: cr.workflowId, caseTitle: `${cr.label} · ${cr.title}`, stepTitle: cr.playbookTitle,
      signoff: item.signoff, changeRequest: toChangeSummary(cr), since: item.since,
    }
  }
  const q = item.question
  return {
    kind: 'inspector-question', id: item.id, domain: q.project, caseTitle: clip(q.question.replace(/\s+/g, ' ').trim(), 140), stepTitle: q.linkName,
    question: toInspectorQuestion(q), since: item.since,
  }
}

// ---------------------------------------------------------------- the change request's chat

/** The `<memwise_context>` block of a chat that edits a change request. */
export function changeChatBlock(v: ChangeRequestView, who: string, actor: PersonActor, files: string[]): string {
  const lines: string[] = []
  lines.push(`Change request ${v.label} "${v.title}" of the playbook "${v.playbookTitle}" (${v.workflowId}), in the regulated project ${v.project}.`)
  lines.push(`Status: ${v.status.replace('_', ' ')}. Raised by ${v.raisedBy.name}. Live version ${v.liveVersion ?? '?'}; this becomes version ${v.nextVersion ?? '?'} when QA signs.`)
  lines.push(`Draft: ${v.draftId}.${files.length ? ` Files: ${files.join(', ')}.` : ''}`)
  lines.push('')
  lines.push('## The reason')
  lines.push(v.reason.trim() || '(Not written yet: ask the person why the change is needed, and suggest a sentence for the request\'s page.)')
  const changed = v.steps.filter((s) => s.change !== 'same')
  if (changed.length) {
    lines.push('')
    lines.push('## What changes so far')
    for (const s of changed) {
      const rules = s.rules.filter((r) => r.kind !== 'same').map((r) => `${r.kind === 'added' ? '+' : '-'} ${r.text}`)
      lines.push(`- Step ${s.n} ${s.stepId} (${s.change})${rules.length ? `: ${rules.join('; ')}` : ''}`)
    }
  }
  const last = v.validations.at(-1)
  if (last) {
    lines.push('')
    lines.push(`## Last validation${last.current ? '' : ' (of an earlier draft)'}: ${last.passed} of ${last.total} past cases match${last.checkErrors ? `, ${last.checkErrors} check error(s)` : ''}`)
    for (const r of last.results.filter((x) => !x.matches).slice(0, 10)) {
      const failed = r.failedRules?.map((f) => f.rule).join('; ')
      lines.push(`- ${r.title} (${r.caseId}): ${r.decided.stepId} said ${r.decided.outcome}${r.decided.comment ? ` ("${clip(r.decided.comment, 200)}")` : ''}; the AI checks ${r.ai === 'pass' ? 'passed it' : r.ai === 'fail' ? `failed it${failed ? ` (${failed})` : ''}` : `could not run (${r.error ?? 'error'})`}.`)
    }
  }
  lines.push('')
  lines.push('## Rules')
  lines.push(`- You act for ${who}, with their roles (${actor.roles.join(', ') || 'none'}). You can never do more than they could by hand.`)
  lines.push(`- Every change goes into the draft ${v.draftId}. Nothing live changes until QA signs ${v.label}; cases already running finish on the version they started on.`)
  lines.push('- Keep the change as small as asked. After each change run playbook_check and say the result in one line ("42 of 42 past cases match QC").')
  lines.push(`- When the validation passes, tell ${who} to send ${v.label} to QA from its page: that needs their signature (their password). You cannot sign or publish.`)
  lines.push('- Speak in plain words (playbook, step, check, past cases), not in file formats.')
  return lines.join('\n')
}

function diag(d: Diagnostic): PlaybookToolDiagnostic {
  return {
    severity: d.severity, code: d.code, message: d.path && !d.line ? `${d.message} (${d.path})` : d.message,
    ...(d.file ? { file: d.file } : {}), ...(d.line ? { line: d.line } : {}),
  }
}

/** A validation as the chat reads it: the count, and the cases that don't match. */
export function validationForChat(v: ChangeValidation, label: string): Record<string, unknown> {
  const mismatches = v.results.filter((r) => !r.matches)
  return {
    changeRequest: label,
    status: v.status,
    summary: v.checkErrors
      ? `The draft has ${v.checkErrors} check error(s); fix them first (the AI checks were not run).`
      : v.total === 0
        ? 'No past cases to validate on: widen the validation set on the request\'s page.'
        : `${v.passed} of ${v.total} past cases match what people decided.`,
    passed: v.passed,
    total: v.total,
    checkErrors: v.checkErrors,
    mismatches: mismatches.slice(0, 20).map((r) => ({
      caseId: r.caseId, title: r.title, decided: r.decided, ai: r.ai,
      ...(r.failedRules?.length ? { failedRules: r.failedRules } : {}), ...(r.error ? { error: r.error } : {}),
    })),
    next: v.status === 'passed'
      ? `It passes. ${label} goes to QA when the person who raised it signs it on its page.`
      : 'Change the draft so the AI checks agree with these decisions, then run playbook_check again.',
  }
}

/**
 * The `playbook_*` tools of a chat anchored to a change request (`mw.chat_anchors` kind `change`):
 * they act as the chat's person on the request's draft while it is open. `playbook_check`
 * validates it on past cases; `playbook_finish` is refused (QA's signature publishes it).
 */
export function buildChangeToolCallbacks(opts: { sessionId: string; log?: (message: string) => void }): MemwiseToolCallbacks {
  const { sessionId } = opts

  async function ctx(): Promise<{ svc: MemwiseService; actor: PersonActor; v: ChangeRequestView }> {
    const svc = getMemwiseService()
    if (!svc) throw new Error('Playbooks are not running in this app right now.')
    const { PgChatAnchorStore } = await import('@memwise/db')
    const anchor = await new PgChatAnchorStore().get(svc.kernel.pool, sessionId)
    if (!anchor || anchor.anchorKind !== 'change') throw new Error('This chat is not about a change request.')
    if (!anchor.personId) throw new Error('This chat has no person to act for.')
    const actor = await svc.kernel.people.actorFor(anchor.personId)
    const v = await regulatedOf(svc).changes.get(anchor.anchorId, actor)
    if (!v) throw new Error('That change request was not found.')
    return { svc, actor, v }
  }

  function requireOpen(v: ChangeRequestView): void {
    if (v.status !== 'open') {
      throw new Error(`${v.label} is ${v.status.replace('_', ' ')}: its draft can't be changed now.${v.status === 'in_review' ? ' Withdraw it to change it, or QA sends it back.' : ''}`)
    }
  }

  return {
    async vocabulary() {
      const { svc } = await ctx()
      return authoringOf(svc).vocabulary()
    },

    async read(input) {
      const { svc, v } = await ctx()
      const authoring = authoringOf(svc)
      const path = input.path ? { path: input.path } : {}
      if (input.playbook && input.playbook !== v.workflowId) return authoring.read({ workflowId: input.playbook, ...path })
      if (input.live) return authoring.read({ workflowId: v.workflowId, ...path })
      return authoring.read({ draftId: v.draftId, ...path })
    },

    async write(input) {
      const { svc, actor, v } = await ctx()
      requireOpen(v)
      if (input.playbook && input.playbook !== v.workflowId) {
        throw new Error(`This chat changes ${v.playbookTitle} (${v.workflowId}) only; raise another change request for ${input.playbook}.`)
      }
      const { edit, diagnostics } = await authoringOf(svc).write({
        draftId: v.draftId, files: input.files, summary: input.summary, via: 'chat', chatId: sessionId,
      }, actor)
      emitMemwiseChange({ kind: 'drafts', id: v.draftId })
      emitMemwiseChange({ kind: 'regulated', project: v.project })
      const errors = diagnostics.filter((d) => d.severity === 'error').length
      return {
        draftId: v.draftId,
        changeRequest: v.label,
        editId: edit.id,
        status: edit.status,
        paths: edit.files.map((f) => f.path),
        errors,
        warnings: diagnostics.length - errors,
        diagnostics: diagnostics.map(diag),
        next: errors ? 'Fix the errors, then run playbook_check.' : 'Run playbook_check to validate the change on past cases.',
      }
    },

    async diff() {
      const { svc, v } = await ctx()
      const { diffForChat } = await import('./chat-tools')
      return { changeRequest: v.label, ...diffForChat(await authoringOf(svc).diff(v.draftId)) }
    },

    async check() {
      const { svc, actor, v } = await ctx()
      requireOpen(v)
      const validation = await regulatedOf(svc).changes.validate(v.id, actor)
      opts.log?.(`[memwise] chat ${sessionId} validated ${v.label}: ${validation.passed}/${validation.total} (${validation.status})`)
      return validationForChat(validation, v.label)
    },

    async finish() {
      const { svc, v } = await ctx()
      const raiser = (await personName(svc, v.raisedBy.id)) ?? v.raisedBy.name
      return {
        applied: false,
        message: `${v.label} is not finished from chat: ${raiser} sends it to QA with their signature on its page, and QA's signature publishes it.`,
      }
    },
  }
}
