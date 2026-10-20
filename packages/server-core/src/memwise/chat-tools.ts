/**
 * The `playbook_*` session tools' callbacks (docs/memwise/20-phase-3-interfaces.md §4), wired by
 * SessionManager for a chat anchored to a conversation step. Each call resolves the chat's
 * anchor (mw.chat_anchors → the step run → its run, case, draft and person) and acts as that
 * person through `kernel.authoring`; finishing answers the step with `submitStep({ via })`.
 *
 * Loaded by SessionManager at module level, so no kernel imports here except lazily.
 */
import type { MemwiseToolCallbacks, PlaybookToolDiagnostic } from '@memwise/session-tools-core'
import type { Diagnostic, DraftDiff, DraftMeta, DraftReport } from '@memwise/defs'
import { emitMemwiseChange, getMemwiseService } from './host'
import { authoringOf, conversationState, isConversationStep, type ConversationState } from './conversation'
import type { MemwiseService, PersonActor } from './service'

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
    if (s.status !== 'waiting') throw new Error('This step is no longer waiting on the chat (it was finished, or the case moved on).')
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
      const r = await svc.kernel.submitStep({
        stepRunId: s.stepRunId, outcome, values, by: actor,
        via: { chatId: sessionId, ...(input.rationale ? { rationale: input.rationale } : { rationale: input.summary }) },
      })
      if (!r.applied) {
        const why = r.errors ? Object.entries(r.errors).map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ') : undefined
        return { applied: false, message: r.message ?? why ?? `The step could not be finished (${r.status}).`, status: r.status }
      }
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
