/**
 * Conversation steps (docs/memwise/20-phase-3-interfaces.md §3–4): the chat that builds or
 * changes a playbook is the `interview` / `edit` step of a meta playbook run. Shared by the
 * RPC handlers (opening the chat, the inbox) and the chat's playbook tools: which step run a
 * chat answers, the draft it is building, and the `<memwise_context>` block it starts with.
 *
 * No kernel imports at module level (SessionManager imports the chat tools that use this).
 */
import type { DraftMeta, StepDef, WorkflowDef } from '@memwise/defs'
import type { Authoring, CaseView, StepRunSummary } from '@memwise/runtime'
import type { Kernel, MemwiseService, PersonActor } from './service'

/** The kernel with its Phase 3 additions (authoring, versions, caseToExample). */
export type KernelWithAuthoring = Kernel & { authoring?: Authoring; versions?: import('@memwise/runtime').KernelPhase3['versions']; caseToExample?: import('@memwise/runtime').KernelPhase3['caseToExample'] }

export function authoringOf(svc: MemwiseService): Authoring {
  const a = (svc.kernel as KernelWithAuthoring).authoring
  if (!a) throw new Error('Drafts are not available: the playbook engine has no project folder.')
  return a
}

/** A conversation step: an agent step run on the open engine (`engine: open`), answered by its chat. */
export function isConversationStep(step: StepDef | undefined): boolean {
  return !!step && step.performer === 'agent' && (step as StepDef & { engine?: string }).engine === 'open'
}

/** Plain case values (the kernel's CaseValue → value). */
export function plainValues(values: Record<string, { value: unknown } | undefined> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(values ?? {})) if (v) out[k] = v.value
  return out
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** The draft a meta-playbook run is building: the case's `draft`, else an open draft made by the run. */
export async function draftForRun(authoring: Authoring, runId: string, values: Record<string, unknown>): Promise<DraftMeta | undefined> {
  const id = str(values.draft)
  const drafts = await authoring.listDrafts().catch(() => [] as DraftMeta[])
  if (id) {
    const byId = drafts.find((d) => d.id === id)
    if (byId) return byId
  }
  return drafts.filter((d) => d.runId === runId && d.status === 'open').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
}

/** The step run a conversation step's chat answers now: the anchored one, or its later attempt after a send-back. */
export function currentAttempt(view: CaseView | undefined, stepId: string, stepRunId: string): StepRunSummary | undefined {
  const runs = view?.stepRuns ?? []
  const anchored = runs.find((r) => r.stepRunId === stepRunId)
  if (anchored?.status === 'waiting') return anchored
  return runs.filter((r) => r.stepId === stepId && r.status === 'waiting').at(-1) ?? anchored
}

/** Why a step is being done again: the step run before this attempt sent it back (a review's comment). */
export function sendBackNote(view: CaseView | undefined, stepRunId: string, stepId: string): { stepId: string; outcome: string; text: string; by?: string } | undefined {
  const runs = view?.stepRuns ?? []
  const i = runs.findIndex((r) => r.stepRunId === stepRunId)
  if (i <= 0 || !runs.slice(0, i).some((r) => r.stepId === stepId)) return undefined
  const prev = runs[i - 1]!
  const text = prev.comment?.trim() || prev.rationale?.trim()
  if (!text || !prev.outcome) return undefined
  return { stepId: prev.stepId, outcome: prev.outcome, text, ...(prev.decidedBy ? { by: prev.decidedBy } : {}) }
}

export interface ConversationState {
  stepRunId: string
  runId: string
  caseId: string
  /** The meta playbook (create-playbook / change-playbook). */
  workflowId: string
  stepId: string
  status: string
  values: Record<string, unknown>
  draft?: DraftMeta
  view?: CaseView
}

/** Reads a conversation step run as `actor` sees it, following a send-back to the waiting attempt. */
export async function conversationState(svc: MemwiseService, stepRunId: string, actor: PersonActor): Promise<ConversationState> {
  const rec = await svc.kernel.getStepRecord(stepRunId)
  if (!rec) throw new Error('That step was not found.')
  const view = await svc.kernel.getCaseView(rec.caseId, actor).catch(() => undefined)
  const now = currentAttempt(view, rec.stepId, rec.stepRunId)
  const values = view ? plainValues(Object.fromEntries(Object.entries(view.values).filter(([, v]) => !v.hidden))) : plainValues((await svc.kernel.getCase(rec.caseId))?.values)
  const authoring = (svc.kernel as KernelWithAuthoring).authoring
  const draft = authoring ? await draftForRun(authoring, rec.runId, values) : undefined
  return {
    stepRunId: now?.stepRunId ?? rec.stepRunId,
    runId: rec.runId,
    caseId: rec.caseId,
    workflowId: rec.workflowId,
    stepId: rec.stepId,
    status: now?.status ?? rec.status,
    values,
    ...(draft ? { draft } : {}),
    ...(view ? { view } : {}),
  }
}

/** The playbook a conversation changes (case `playbook`, or the draft's), when it is live. */
export function changedPlaybook(project: { workflows: Record<string, WorkflowDef> }, s: Pick<ConversationState, 'values' | 'draft'>): WorkflowDef | undefined {
  const id = str(s.values.playbook) ?? s.draft?.workflowId
  return id ? project.workflows[id] : undefined
}

/** Names of people, for the block's rules and the DTOs. */
export async function personName(svc: MemwiseService, personId: string | undefined): Promise<string | undefined> {
  if (!personId) return undefined
  try { return (await svc.kernel.people.get(personId))?.name } catch { return undefined }
}

/**
 * The `<memwise_context>` block of a conversation-step chat: the step's title and instructions
 * (the authoring guide), the case's values, the playbook being changed and its files, the
 * draft, a review's send-back comment, and the rules the chat follows.
 */
export async function conversationBlock(svc: MemwiseService, s: ConversationState, actor: PersonActor, who: string): Promise<string> {
  if (isProjectConversation(s)) return projectConversationBlock(svc, s, actor, who)
  const { project } = await svc.kernel.project()
  const wf = project.workflows[s.workflowId]
  const step = wf?.steps[s.stepId]
  const lines: string[] = []
  const v = s.values
  const building = s.workflowId === 'create-playbook' || (!changedPlaybook(project, s) && !s.draft?.baseVersion)
  lines.push(`Step "${step?.title ?? s.stepId}" (${s.stepId}) of the playbook "${wf?.title ?? s.workflowId}"; case ${s.caseId}, step run ${s.stepRunId}.`)
  lines.push('')
  lines.push('## What was asked')
  if (str(v.request)) lines.push(`Request: ${str(v.request)}`)
  if (str(v.title)) lines.push(`Title: ${str(v.title)}`)
  if (str(v.playbook)) lines.push(`Playbook: ${str(v.playbook)}`)
  if (str(v.draft) || s.draft) lines.push(`Draft: ${s.draft?.id ?? str(v.draft)}${s.draft ? ` ("${s.draft.title}", ${s.draft.kind}, playbook ${s.draft.workflowId})` : ''}`)
  if (!str(v.request) && !str(v.title)) lines.push('(Nothing written down yet: ask the person what the playbook is for.)')

  const changed = changedPlaybook(project, s)
  if (changed) {
    lines.push('')
    lines.push(`## The playbook being changed: "${changed.title ?? changed.id}" (${changed.id}), live version ${changed.version}`)
    try {
      const authoring = authoringOf(svc)
      const listed = await authoring.read({ workflowId: changed.id })
      if ('files' in listed) lines.push(`Files: ${listed.files.join(', ')}`)
    } catch { /* the files list is a convenience */ }
    const states = Object.keys(changed.states)
    lines.push(`States: ${states.join(', ')}. Start: ${changed.start}.`)
  }

  const note = sendBackNote(s.view, s.stepRunId, s.stepId)
  if (note) {
    const by = await personName(svc, note.by)
    lines.push('')
    lines.push('## Sent back by the review')
    lines.push(`${by ?? 'The reviewer'} asked for changes (${note.outcome}): "${note.text}"`)
    lines.push('Start by addressing this comment in the draft.')
  }

  if (step?.instructions?.trim()) {
    lines.push('')
    lines.push('## How to do this step (the authoring guide)')
    lines.push(step.instructions.trim())
  }

  lines.push('')
  lines.push('## Rules')
  lines.push(`- You act for ${who}, with their roles (${actor.roles.join(', ') || 'none'}). You can never do more than they could by hand.`)
  lines.push(`- Every change goes into the draft${s.draft ? ` ${s.draft.id}` : ' (the first playbook_write creates it)'}; nothing live changes until an approver publishes it as a new version.`)
  lines.push('- Use the playbook_* tools for every read and change; use only tools, roles and entity types playbook_vocabulary lists.')
  lines.push(building
    ? '- A new playbook needs its workflow.yaml, case.yaml, one file per step, and at least two example cases that pass.'
    : '- Keep the change as small as asked; update the example cases it affects so they still pass.')
  lines.push('- Ask the person when something is unclear; speak in plain words (playbook, step, case, draft), not in file formats.')
  lines.push('- Finish with playbook_finish only when the checks are clean and the person agrees the draft is ready.')
  return lines.join('\n')
}

/** The hidden turn that tells a reopened chat its draft came back from review, and why. */
export function sentBackMessage(note: { outcome: string; text: string }, by: string | undefined): string {
  return [
    `The review sent the draft back (${note.outcome}). ${by ?? 'The reviewer'} wrote:`,
    '',
    `> ${note.text.replace(/\n/g, '\n> ')}`,
    '',
    'Briefly tell me what they asked for, then address it in the draft and check it again.',
  ].join('\n')
}

/** The short hidden turn that makes the agent speak first. */
export function kickoffMessage(kind: 'conversation' | 'explain'): string {
  return kind === 'conversation'
    ? 'Start the conversation: greet me briefly, say in a sentence or two what we are doing (from the MemWise context), and ask your first question.'
    : 'Start with two or three plain sentences on where this stands, then offer to answer questions about it.'
}

// ---------------------------------------------------------------- Stage 3: "Describe it in chat" (26 §3)

/** The app playbook whose conversation makes a new project (runtime CREATE_PROJECT_PLAYBOOK). */
export const CREATE_PROJECT = 'create-project'

/** A conversation that makes a project (the `project_*` tools), not a playbook. */
export function isProjectConversation(s: Pick<ConversationState, 'workflowId'>): boolean {
  return s.workflowId === CREATE_PROJECT
}

/**
 * The `<memwise_context>` block of a create-project chat: what was asked, the app, the draft
 * made so far (once `project_draft` made it), the step's instructions and the rules.
 */
export async function projectConversationBlock(svc: MemwiseService, s: ConversationState, actor: PersonActor, who: string): Promise<string> {
  const { project } = await svc.kernel.project()
  const wf = project.workflows[s.workflowId]
  const step = wf?.steps[s.stepId]
  const app = str(s.values.app)
  const appDef = app ? project.domains?.[app] : undefined
  const lines: string[] = []
  lines.push(`Step "${step?.title ?? s.stepId}" (${s.stepId}) of the playbook "${wf?.title ?? s.workflowId}"; case ${s.caseId}, step run ${s.stepRunId}.`)
  lines.push('')
  lines.push('## What was asked')
  lines.push(`App: ${project.apps?.[app ?? '']?.title ?? appDef?.name ?? app ?? '(none)'}${app ? ` (${app})` : ''}`)
  if (str(s.values.request)) lines.push(`Request: ${str(s.values.request)}`)
  else lines.push('(Nothing written down yet: ask the person what the new project is.)')
  const made = str(s.values.project)
  if (made) {
    const p = await svc.kernel.projects.get(made, actor).catch(() => undefined)
    lines.push('')
    lines.push(`## The draft made in this chat: "${p?.name ?? made}" (${made}), ${p?.status ?? 'draft'}`)
    lines.push('Further project_draft calls change it.')
  }
  if (step?.instructions?.trim()) {
    lines.push('')
    lines.push('## How to do this step')
    lines.push(step.instructions.trim())
  }
  lines.push('')
  lines.push('## Rules')
  lines.push(`- You act for ${who}, with their roles (${actor.roles.join(', ') || 'none'}). You can never do more than they could by hand.`)
  lines.push('- Read project_options first; use only the template cards, projects, roles and paths it lists.')
  lines.push('- Records are never copied: a new project starts empty, and says so.')
  lines.push('- The project is a draft: nothing runs in it until the person presses Start on its page beside this chat.')
  lines.push('- Keep the chat short (a few lines); the page shows the details.')
  return lines.join('\n')
}
