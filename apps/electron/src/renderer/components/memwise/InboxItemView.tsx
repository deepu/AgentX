/**
 * One inbox item, opened in place: a generated form (input), an approval card (decision),
 * an effect approval with its preview (approval), a stopped case's events (attention), or a
 * reminder. Presentational: the container passes the API calls in `actions`.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { AlertTriangle, Bell, CheckCircle2, ClipboardList, FilePen, Link2, Mail, MessagesSquare, Puzzle, ShieldCheck, Undo2 } from 'lucide-react'
import type {
  MwBindingView,
  MwCaseValue,
  MwDecideApprovalInput,
  MwDecideIdentityInput,
  MwInboxItem,
  MwRole,
  MwSendEventInput,
  MwSubmitResult,
  MwSubmitStepInput,
  MwWriteDraftResult,
} from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Badge } from '@/components/info/Info_Badge'
import { Info_Page } from '@/components/info/Info_Page'
import { Info_Section } from '@/components/info/Info_Section'
import { Info_Table } from '@/components/info/Info_Table'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Markdown } from '@memwise/ui'
import { cn } from '@/lib/utils'
import { CaseFieldList } from './CaseValues'
import { isMetaPlaybook } from './draft/draft-model'
import { GeneratedForm, type UploadFile } from './GeneratedForm'
import { BindingReview } from './plugins/BindingReview'
import { identityRows, matchMethodLabel, scorePercent } from './plugins/plugin-model'
import { useNow } from './use-now'
import { buildSubmission, initialFormValues, type FormError, type FormValues } from './form-model'
import {
  absoluteTime,
  attentionReason,
  formatValueInline,
  humanize,
  inboxItemStepTitle,
  inboxKindLabel,
  isNegativeOutcome,
  outcomeLabel,
  outcomeNeedsComment,
  personName,
  relativeTime,
  roleTitle,
  stateLabel,
  toolLabel,
  resultMessage,
  type PeopleById,
} from './format'

export interface InboxActions {
  submitStep: (input: MwSubmitStepInput) => Promise<MwSubmitResult>
  decideApproval: (input: MwDecideApprovalInput) => Promise<MwSubmitResult>
  sendEvent: (input: MwSendEventInput) => Promise<MwSubmitResult>
  /** Mark a reminder read (absent: no "Mark as read" button). */
  dismiss?: (itemId: string) => Promise<MwSubmitResult>
  uploadFile?: UploadFile
  openCase: (caseId: string) => void
  /** Called after the kernel accepted an answer. */
  onDone?: (result: MwSubmitResult) => void
  /** Reopen a conversation step's chat (building or changing a playbook), beside the inbox. */
  continueChat?: (item: Extract<MwInboxItem, { kind: 'conversation' }>) => void
  /** Open a draft's review screen. */
  openDraft?: (draftId: string) => void
  /** Answer an identity match: the same record, or a different one. */
  decideIdentity?: (input: MwDecideIdentityInput) => Promise<MwSubmitResult>
  /** Open a plugin's page. */
  openPlugin?: (pluginId: string) => void
  /** Save edits into a draft (the binding review's edits; `memwise:drafts:write`). */
  writeDraft?: (draftId: string, input: { path: string; content: string; summary: string }) => Promise<MwWriteDraftResult>
}

export interface InboxItemViewProps {
  item: MwInboxItem
  actions: InboxActions
  people?: PeopleById
  roles?: MwRole[]
  /** For a playbook change's review step: the draft it reviews, when the item's context does not name it. */
  reviewDraftId?: string
  /** For a bind-plugin step (`item.binding`): the binding under review, loaded by the container. */
  bindingView?: MwBindingView | null
  /** The binding could not be loaded. */
  bindingError?: string | null
  /** Playbook titles by id: a change's review names its playbook by title, not id. */
  playbookTitles?: Record<string, string>
  now?: number
}

const KIND_ICON: Record<MwInboxItem['kind'], React.ReactNode> = {
  input: <ClipboardList />,
  decision: <CheckCircle2 />,
  approval: <ShieldCheck />,
  attention: <AlertTriangle />,
  reminder: <Bell />,
  conversation: <MessagesSquare />,
  identity: <Link2 />,
}

/** The draft a playbook change's decision is about: the case value `draft`. */
export function reviewDraftOf(item: MwInboxItem): string | undefined {
  if (item.kind !== 'decision' || !isMetaPlaybook(item.workflowId)) return undefined
  const value = item.context.draft?.value
  return typeof value === 'string' && value ? value : undefined
}

/** Keeps a submit in flight from being sent twice, and turns thrown errors into a message. */
function useAnswer(onDone?: (r: MwSubmitResult) => void) {
  const [busy, setBusy] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<MwSubmitResult | null>(null)
  const run = React.useCallback(async (key: string, call: () => Promise<MwSubmitResult>) => {
    setBusy(key)
    setResult(null)
    try {
      const r = await call()
      setResult(r)
      if (r.applied) onDone?.(r)
      return r
    } catch (err) {
      const r: MwSubmitResult = { applied: false, message: err instanceof Error ? err.message : String(err) }
      setResult(r)
      return r
    } finally {
      setBusy(null)
    }
  }, [onDone])
  return { busy, result, run }
}

function ResultMessage({ result }: { result: MwSubmitResult | null }) {
  const { t } = useTranslation()
  if (!result) return null
  if (result.applied) {
    return (
      <Info_Alert variant="success" inline icon={<CheckCircle2 />}>
        <Info_Alert.Title>{result.message ?? t('memwise.inbox.done')}</Info_Alert.Title>
      </Info_Alert>
    )
  }
  const fieldErrors = result.errors && Object.keys(result.errors).length > 0
  return (
    <Info_Alert variant="error" inline icon={<AlertTriangle />}>
      <Info_Alert.Title>{fieldErrors ? t('memwise.inbox.fixErrors') : t('memwise.inbox.notApplied')}</Info_Alert.Title>
      {(result.code || result.message) && <Info_Alert.Description>{resultMessage(result, t)}</Info_Alert.Description>}
    </Info_Alert>
  )
}

function CommentBox({ value, onChange, error, placeholder, disabled }: {
  value: string
  onChange: (v: string) => void
  error?: string
  placeholder?: string
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const id = React.useId()
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-label font-medium text-foreground">
        {t('memwise.inbox.comment')}
        <span className="ml-1.5 font-normal text-tertiary">{t('memwise.form.optional')}</span>
      </label>
      <Textarea id={id} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={3} disabled={disabled} aria-invalid={!!error || undefined} />
      {error && <p className="text-label-sm text-destructive" role="alert">{error}</p>}
    </div>
  )
}

export function InboxItemView({ item, actions, people = {}, roles, reviewDraftId, bindingView, bindingError, playbookTitles, now: fixedNow }: InboxItemViewProps) {
  const { t, i18n } = useTranslation()
  const now = useNow(fixedNow)
  const since = relativeTime(item.since, now, i18n.language)
  const dueAt = 'dueAt' in item ? item.dueAt : undefined

  return (
    <Info_Page.Content>
      <Info_Page.Hero
        avatar={<div className="grid size-full place-items-center bg-fill-hover text-secondary [&_svg]:size-4">{KIND_ICON[item.kind]}</div>}
        title={inboxItemStepTitle(item, t)}
        meta={
          <>
            <Info_Badge color={item.kind === 'attention' ? 'warning' : 'default'}>{inboxKindLabel(item.kind, t)}</Info_Badge>
            {item.kind === 'identity' ? (
              actions.openPlugin
                ? <button type="button" className="font-medium text-foreground hover:underline" onClick={() => actions.openPlugin!(item.plugin)}>{item.caseTitle}</button>
                : <span className="font-medium text-foreground">{item.caseTitle}</span>
            ) : (
              <button type="button" className="font-medium text-foreground hover:underline" onClick={() => actions.openCase(item.caseId)}>
                {item.caseTitle}
              </button>
            )}
            <span title={absoluteTime(item.since, i18n.language)}>{t('memwise.inbox.waitingSince', { time: since })}</span>
            {dueAt && <span>{t('memwise.inbox.due', { time: relativeTime(dueAt, now, i18n.language) })}</span>}
          </>
        }
      />
      {(item.kind === 'input' || item.kind === 'decision') && item.binding && (
        <BindingBody item={item} binding={item.binding} actions={actions} roles={roles} view={bindingView} error={bindingError} now={now} />
      )}
      {item.kind === 'input' && !item.binding && <InputBody item={item} actions={actions} people={people} />}
      {item.kind === 'decision' && !item.binding && <DecisionBody item={item} actions={actions} people={people} roles={roles} draftId={reviewDraftOf(item) ?? reviewDraftId} playbookTitles={playbookTitles} />}
      {item.kind === 'conversation' && <ConversationBody item={item} actions={actions} roles={roles} />}
      {item.kind === 'approval' && <ApprovalBody item={item} actions={actions} />}
      {item.kind === 'attention' && <AttentionBody item={item} actions={actions} />}
      {item.kind === 'reminder' && <ReminderBody item={item} actions={actions} />}
      {item.kind === 'identity' && <IdentityBody item={item} actions={actions} />}
    </Info_Page.Content>
  )
}

// ---------------------------------------------------------------- input

function InputBody({ item, actions, people }: { item: Extract<MwInboxItem, { kind: 'input' }>; actions: InboxActions; people: PeopleById }) {
  const { t } = useTranslation()
  const [values, setValues] = React.useState<FormValues>(() => initialFormValues(item.fields, item.prefill))
  const [errors, setErrors] = React.useState<Record<string, FormError[]>>({})
  const [comment, setComment] = React.useState('')
  const [commentError, setCommentError] = React.useState<string | undefined>()
  const { busy, result, run } = useAnswer(actions.onDone)
  const outcomes = item.outcomes.length ? item.outcomes : ['submitted']
  const hasContext = Object.keys(item.context).length > 0
  // A form with an outcome that sends the case back (or declines it) carries a comment
  const offersComment = outcomes.some(outcomeNeedsComment)

  const submit = (outcome: string) => {
    if (outcomeNeedsComment(outcome) && !comment.trim()) {
      setCommentError(t('memwise.inbox.commentRequired'))
      return
    }
    setCommentError(undefined)
    const s = buildSubmission(item.fields, values)
    setErrors(s.errors)
    if (!s.valid) return
    void run(outcome, () => actions.submitStep({ stepRunId: item.stepRunId, outcome, values: s.values, comment: comment.trim() || undefined }))
  }

  const returnedBy = personName(item.returned?.by, people)

  return (
    <>
      {item.returned && (
        <Info_Alert variant="warning" icon={<Undo2 />}>
          <Info_Alert.Title>
            {returnedBy
              ? t('memwise.inbox.returnedBy', { name: returnedBy, step: item.returned.stepTitle })
              : t('memwise.inbox.returnedFrom', { step: item.returned.stepTitle })}
          </Info_Alert.Title>
          <Info_Alert.Description>{item.returned.text}</Info_Alert.Description>
        </Info_Alert>
      )}
      {hasContext && (
        <Info_Section title={t('memwise.inbox.context')}>
          <CaseFieldList values={item.context} people={people} />
        </Info_Section>
      )}
      <Info_Section title={t('memwise.inbox.fillIn')}>
        <form
          className="space-y-5 p-4"
          onSubmit={e => {
            e.preventDefault()
            submit(outcomes[0]!)
          }}
        >
          <GeneratedForm
            fields={item.fields}
            values={values}
            onChange={(name, v) => {
              setValues(prev => ({ ...prev, [name]: v }))
              if (errors[name]) setErrors(prev => { const next = { ...prev }; delete next[name]; return next })
            }}
            errors={errors}
            serverErrors={result?.errors}
            onUpload={actions.uploadFile}
            disabled={!!busy || result?.applied}
          />
          {offersComment && (
            <CommentBox
              value={comment}
              onChange={v => { setComment(v); if (commentError) setCommentError(undefined) }}
              error={commentError}
              placeholder={t('memwise.inbox.commentPlaceholder')}
              disabled={!!busy || result?.applied}
            />
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {outcomes.map((o, i) => (
              <Button
                key={o}
                type={i === 0 ? 'submit' : 'button'}
                variant={i === 0 ? 'primary' : 'secondary'}
                onClick={i === 0 ? undefined : () => submit(o)}
                disabled={!!busy || result?.applied}
              >
                {busy === o ? t('memwise.inbox.sending') : outcomeLabel(o, t)}
              </Button>
            ))}
          </div>
        </form>
      </Info_Section>
      <ResultMessage result={result} />
    </>
  )
}

// ---------------------------------------------------------------- decision

function DecisionBody({ item, actions, people, roles, draftId, playbookTitles }: {
  item: Extract<MwInboxItem, { kind: 'decision' }>
  actions: InboxActions
  people: PeopleById
  roles?: MwRole[]
  /** A playbook change under review: the card links to its draft. */
  draftId?: string
  playbookTitles?: Record<string, string>
}) {
  const { t } = useTranslation()
  const [comment, setComment] = React.useState('')
  const [commentError, setCommentError] = React.useState<string | undefined>()
  const { busy, result, run } = useAnswer(actions.onDone)

  const decide = (outcome: string) => {
    if (outcomeNeedsComment(outcome) && !comment.trim()) {
      setCommentError(t('memwise.inbox.commentRequired'))
      return
    }
    setCommentError(undefined)
    void run(outcome, () => actions.submitStep({ stepRunId: item.stepRunId, outcome, comment: comment.trim() || undefined }))
  }

  return (
    <>
      {item.instructions.trim() && (
        <Info_Section title={t('memwise.inbox.instructions')} description={item.assignee ? t('memwise.inbox.forRole', { role: roleTitle(item.assignee, roles) }) : undefined}>
          <div className="px-4 py-3 text-label">
            <Markdown mode="minimal">{item.instructions}</Markdown>
          </div>
        </Info_Section>
      )}
      {isMetaPlaybook(item.workflowId) && (
        <Info_Alert variant="info" icon={<FilePen />} data-review-draft={draftId}>
          <Info_Alert.Title>{t('memwise.inbox.review.title')}</Info_Alert.Title>
          <Info_Alert.Description>{t('memwise.inbox.review.description')}</Info_Alert.Description>
          {draftId && actions.openDraft && (
            <Button variant="primary" size="sm" className="mt-2" onClick={() => actions.openDraft!(draftId)} data-action="review-draft">
              <FilePen />
              {t('memwise.inbox.review.open')}
            </Button>
          )}
        </Info_Alert>
      )}
      <Info_Section title={t('memwise.inbox.whatToReview')}>
        <CaseFieldList values={reviewContext(item, playbookTitles)} people={people} />
      </Info_Section>
      <div className="space-y-3">
        <CommentBox
          value={comment}
          onChange={v => { setComment(v); if (commentError) setCommentError(undefined) }}
          error={commentError}
          placeholder={t('memwise.inbox.commentPlaceholder')}
          disabled={!!busy || result?.applied}
        />
        <div className="flex flex-wrap justify-end gap-2">
          {[...item.outcomes].sort((a, b) => Number(isNegativeOutcome(b)) - Number(isNegativeOutcome(a))).map(o => (
            <Button
              key={o}
              variant={isNegativeOutcome(o) ? 'secondary' : 'primary'}
              onClick={() => decide(o)}
              disabled={!!busy || result?.applied}
              data-outcome={o}
            >
              {busy === o ? t('memwise.inbox.sending') : outcomeLabel(o, t)}
            </Button>
          ))}
        </div>
      </div>
      <ResultMessage result={result} />
    </>
  )
}

/**
 * A change's review shows its words, not ids: no draft id (the button above opens the draft), and
 * the playbook by its title.
 */
export function reviewContext(item: Extract<MwInboxItem, { kind: 'decision' }>, playbookTitles?: Record<string, string>): Record<string, MwCaseValue> {
  if (!isMetaPlaybook(item.workflowId)) return item.context
  const { draft: _draft, ...rest } = item.context
  const playbook = rest.playbook
  if (playbook && !playbook.hidden && typeof playbook.value === 'string' && playbook.value) {
    rest.playbook = { ...playbook, value: playbookTitles?.[playbook.value] ?? humanize(playbook.value) }
  }
  return rest
}

// ---------------------------------------------------------------- conversation

function ConversationBody({ item, actions, roles }: {
  item: Extract<MwInboxItem, { kind: 'conversation' }>
  actions: InboxActions
  roles?: MwRole[]
}) {
  const { t } = useTranslation()
  const building = item.workflowId === 'create-playbook'
  return (
    <>
      <Info_Alert variant="info" icon={<MessagesSquare />}>
        <Info_Alert.Title>{t(building ? 'memwise.inbox.conversation.buildTitle' : 'memwise.inbox.conversation.changeTitle', { title: item.caseTitle })}</Info_Alert.Title>
        <Info_Alert.Description>
          {t('memwise.inbox.conversation.description')}
          {item.assignee && <> {t('memwise.inbox.forRole', { role: roleTitle(item.assignee, roles) })}</>}
        </Info_Alert.Description>
      </Info_Alert>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={() => actions.openCase(item.caseId)}>{t('memwise.inbox.openCase')}</Button>
        {item.draftId && actions.openDraft && (
          <Button variant="secondary" onClick={() => actions.openDraft!(item.draftId!)} data-action="open-draft">
            <FilePen />
            {t('memwise.inbox.conversation.openDraft')}
          </Button>
        )}
        {actions.continueChat && (
          <Button variant="primary" onClick={() => actions.continueChat!(item)} data-action="continue-chat">
            <MessagesSquare />
            {t('memwise.inbox.conversation.continue')}
          </Button>
        )}
      </div>
    </>
  )
}

// ---------------------------------------------------------------- approval

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The preview of an effect: an email reads as an email, anything else as labelled values. */
export function EffectPreview({ summary, detail }: { summary: string; detail?: unknown }) {
  const { t, i18n } = useTranslation()
  if (isRecord(detail) && ('subject' in detail || 'body' in detail) && ('to' in detail)) {
    const { to, cc, subject, body, ...rest } = detail as Record<string, unknown>
    return (
      <div data-preview="email">
        <Info_Table labelWidth={80}>
          <Info_Table.Row label={t('memwise.inbox.email.to')} value={formatValueInline(to, t, i18n.language)} />
          {cc !== undefined && <Info_Table.Row label={t('memwise.inbox.email.cc')} value={formatValueInline(cc, t, i18n.language)} />}
          <Info_Table.Row label={t('memwise.inbox.email.subject')} value={<span className="font-medium">{String(subject ?? '')}</span>} />
          {Object.entries(rest).map(([k, v]) => <Info_Table.Row key={k} label={humanize(k)} value={formatValueInline(v, t, i18n.language)} />)}
        </Info_Table>
        <div className="border-t border-separator px-4 py-3 text-label whitespace-pre-wrap">{String(body ?? '')}</div>
      </div>
    )
  }
  if (isRecord(detail)) {
    return (
      <div>
        <p className="px-3.5 pt-3 text-label font-medium">{summary}</p>
        <Info_Table>
          {Object.entries(detail).map(([k, v]) => <Info_Table.Row key={k} label={humanize(k)} value={formatValueInline(v, t, i18n.language)} />)}
        </Info_Table>
      </div>
    )
  }
  return (
    <div className="px-4 py-3 text-label">
      <p className="font-medium">{summary}</p>
      {detail !== undefined && detail !== null && <p className="mt-1 whitespace-pre-wrap text-secondary">{String(detail)}</p>}
    </div>
  )
}

function ApprovalBody({ item, actions }: { item: Extract<MwInboxItem, { kind: 'approval' }>; actions: InboxActions }) {
  const { t } = useTranslation()
  const [comment, setComment] = React.useState('')
  const [commentError, setCommentError] = React.useState<string | undefined>()
  const { busy, result, run } = useAnswer(actions.onDone)
  const decide = (status: 'approved' | 'rejected') => {
    if (status === 'rejected' && !comment.trim()) {
      setCommentError(t('memwise.inbox.rejectNeedsComment'))
      return
    }
    setCommentError(undefined)
    void run(status, () => actions.decideApproval({ approvalId: item.approvalId, status, comment: comment.trim() || undefined }))
  }
  const isEmail = item.tool === 'email.send' || item.tool.endsWith('.send_email')
  return (
    <>
      <Info_Alert variant="info" icon={<ShieldCheck />}>
        <Info_Alert.Title>{t('memwise.inbox.approvalTitle', { action: toolLabel(item.tool) })}</Info_Alert.Title>
        <Info_Alert.Description>{item.reason}</Info_Alert.Description>
      </Info_Alert>
      <Info_Section
        title={isEmail ? t('memwise.inbox.emailPreview') : t('memwise.inbox.preview')}
        actions={isEmail ? <Mail className="size-4 text-tertiary" /> : undefined}
      >
        <EffectPreview summary={item.preview.summary} detail={item.preview.detail} />
      </Info_Section>
      <div className="space-y-3">
        <CommentBox
          value={comment}
          onChange={v => { setComment(v); if (commentError) setCommentError(undefined) }}
          error={commentError}
          placeholder={t('memwise.inbox.commentPlaceholder')}
          disabled={!!busy || result?.applied}
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={() => decide('rejected')} disabled={!!busy || result?.applied}>
            {busy === 'rejected' ? t('memwise.inbox.sending') : t('memwise.form.outcome.reject')}
          </Button>
          <Button variant="primary" onClick={() => decide('approved')} disabled={!!busy || result?.applied}>
            {busy === 'approved' ? t('memwise.inbox.sending') : t('memwise.form.outcome.approve')}
          </Button>
        </div>
      </div>
      <ResultMessage result={result} />
    </>
  )
}

// ---------------------------------------------------------------- attention

function AttentionBody({ item, actions }: { item: Extract<MwInboxItem, { kind: 'attention' }>; actions: InboxActions }) {
  const { t } = useTranslation()
  const [comment, setComment] = React.useState('')
  const { busy, result, run } = useAnswer(actions.onDone)
  return (
    <>
      <Info_Alert variant="info" icon={<AlertTriangle />}>
        <Info_Alert.Title>{t('memwise.inbox.attentionTitle')}</Info_Alert.Title>
        <Info_Alert.Description>{attentionReason(item, t)}</Info_Alert.Description>
      </Info_Alert>
      {item.events.length > 0 ? (
        <div className="space-y-3">
          <CommentBox value={comment} onChange={setComment} placeholder={t('memwise.inbox.attentionCommentPlaceholder')} disabled={!!busy || result?.applied} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => actions.openCase(item.caseId)}>{t('memwise.inbox.openCase')}</Button>
            {item.events.map((e, i) => (
              <Button
                key={e}
                variant={i === 0 ? 'primary' : 'secondary'}
                onClick={() => void run(e, () => actions.sendEvent({ runId: item.runId, event: e, comment: comment.trim() || undefined }))}
                disabled={!!busy || result?.applied}
              >
                {busy === e ? t('memwise.inbox.sending') : outcomeLabel(e, t)}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex justify-end">
          <Button variant="secondary" onClick={() => actions.openCase(item.caseId)}>{t('memwise.inbox.openCase')}</Button>
        </div>
      )}
      <ResultMessage result={result} />
    </>
  )
}

// ---------------------------------------------------------------- reminder

function ReminderBody({ item, actions }: { item: Extract<MwInboxItem, { kind: 'reminder' }>; actions: InboxActions }) {
  const { t } = useTranslation()
  const { busy, result, run } = useAnswer(actions.onDone)
  const dismiss = actions.dismiss
  const text = item.code === 'still_waiting' ? t('memwise.inbox.reminder.stillWaiting', { step: item.stepTitle }) : item.text
  return (
    <>
      <Info_Alert variant="warning" icon={<Bell />}>
        <Info_Alert.Title>{t('memwise.inbox.reminderTitle')}</Info_Alert.Title>
        <Info_Alert.Description className={cn('whitespace-pre-wrap')}>{text}</Info_Alert.Description>
      </Info_Alert>
      <div className="flex justify-end gap-2">
        {dismiss && (
          <Button variant="secondary" onClick={() => void run('dismiss', () => dismiss(item.id))} disabled={!!busy || result?.applied}>
            {busy === 'dismiss' ? t('memwise.inbox.sending') : t('memwise.inbox.markRead')}
          </Button>
        )}
        <Button variant="primary" onClick={() => actions.openCase(item.caseId)}>{t('memwise.inbox.openCase')}</Button>
      </div>
      {result && !result.applied && <ResultMessage result={result} />}
    </>
  )
}

// ---------------------------------------------------------------- binding (the bind-plugin steps)

type BindingItem = Extract<MwInboxItem, { kind: 'input' | 'decision' }>

/**
 * The bind-plugin `fix` step (edit: the choices are editable and saved into the binding draft,
 * then Done) and its `review` step (Approve / Ask for changes), on the binding review screen.
 */
function BindingBody({ item, binding, actions, roles, view, error, now }: {
  item: BindingItem
  binding: NonNullable<BindingItem['binding']>
  actions: InboxActions
  roles?: MwRole[]
  view?: MwBindingView | null
  error?: string | null
  now?: number
}) {
  const { t } = useTranslation()
  const [comment, setComment] = React.useState('')
  const [commentError, setCommentError] = React.useState<string | undefined>()
  const { busy, result, run } = useAnswer(actions.onDone)
  const editing = binding.mode === 'edit'
  const instructions = item.kind === 'decision' ? item.instructions : ''
  const outcomes = item.outcomes.length ? item.outcomes : [editing ? 'done' : 'approved']
  const draftId = binding.draftId ?? view?.draftId
  const writeDraft = actions.writeDraft
  const onSave = draftId && writeDraft ? (input: { path: string; content: string; summary: string }) => writeDraft(draftId, input) : undefined

  const answer = async (outcome: string, ctx: { dirty: boolean; save: () => Promise<boolean> }) => {
    if (outcomeNeedsComment(outcome) && !comment.trim()) {
      setCommentError(t('memwise.inbox.commentRequired'))
      return
    }
    setCommentError(undefined)
    // Unsaved edits go into the draft before the step is answered
    if (ctx.dirty && !(await ctx.save())) return
    void run(outcome, () => actions.submitStep({ stepRunId: item.stepRunId, outcome, values: {}, comment: comment.trim() || undefined }))
  }

  const sorted = editing ? outcomes : [...outcomes].sort((a, b) => Number(isNegativeOutcome(b)) - Number(isNegativeOutcome(a)))

  return (
    <>
      <Info_Alert variant="info" icon={<Puzzle />} data-binding-mode={binding.mode}>
        <Info_Alert.Title>{t(editing ? 'memwise.inbox.binding.editTitle' : 'memwise.inbox.binding.reviewTitle', { title: view?.pluginTitle ?? binding.pluginId })}</Info_Alert.Title>
        <Info_Alert.Description>{t(editing ? 'memwise.inbox.binding.editDescription' : 'memwise.inbox.binding.reviewDescription')}</Info_Alert.Description>
        {actions.openPlugin && (
          <Button variant="secondary" size="sm" className="mt-2" onClick={() => actions.openPlugin!(binding.pluginId)} data-action="open-plugin">
            <Puzzle />
            {t('memwise.inbox.binding.openPlugin')}
          </Button>
        )}
      </Info_Alert>
      {instructions.trim() && (
        <Info_Section title={t('memwise.inbox.instructions')}>
          <div className="px-4 py-3 text-label">
            <Markdown mode="minimal">{instructions}</Markdown>
          </div>
        </Info_Section>
      )}
      {error && (
        <Info_Alert variant="error" icon={<AlertTriangle />}>
          <Info_Alert.Title>{t('memwise.inbox.binding.loadFailed')}</Info_Alert.Title>
          <Info_Alert.Description>{error}</Info_Alert.Description>
        </Info_Alert>
      )}
      {!view && !error && <p className="px-1 text-label text-tertiary">{t('memwise.inbox.binding.loading')}</p>}
      {view && (
        <BindingReview
          view={view}
          roles={roles}
          mode={editing ? 'edit' : 'review'}
          onSave={onSave}
          now={now}
          actions={ctx => (
            <div className="space-y-3" data-binding-actions>
              {(!editing || outcomes.some(outcomeNeedsComment)) && (
                <CommentBox
                  value={comment}
                  onChange={v => { setComment(v); if (commentError) setCommentError(undefined) }}
                  error={commentError}
                  placeholder={t('memwise.inbox.commentPlaceholder')}
                  disabled={!!busy || ctx.busy || result?.applied}
                />
              )}
              <div className="flex flex-wrap justify-end gap-2">
                {sorted.map((o, i) => (
                  <Button
                    key={o}
                    variant={editing ? (i === 0 ? 'primary' : 'secondary') : isNegativeOutcome(o) ? 'secondary' : 'primary'}
                    onClick={() => void answer(o, ctx)}
                    disabled={!!busy || ctx.busy || result?.applied}
                    data-outcome={o}
                  >
                    {busy === o ? t('memwise.inbox.sending') : outcomeLabel(o, t)}
                  </Button>
                ))}
              </div>
            </div>
          )}
        />
      )}
      <ResultMessage result={result} />
    </>
  )
}

// ---------------------------------------------------------------- identity

/** "Is this the same client?": the domain's record beside the outside one, field by field. */
function IdentityBody({ item, actions }: { item: Extract<MwInboxItem, { kind: 'identity' }>; actions: InboxActions }) {
  const { t, i18n } = useTranslation()
  const { busy, result, run } = useAnswer(actions.onDone)
  const decide = actions.decideIdentity
  const rows = identityRows(item)
  return (
    <>
      <Info_Alert variant="info" icon={<Link2 />}>
        <Info_Alert.Title>{t('memwise.inbox.identity.title', { entity: humanize(item.entity).toLowerCase(), plugin: item.pluginTitle })}</Info_Alert.Title>
        <Info_Alert.Description>
          {t('memwise.inbox.identity.description', { score: scorePercent(item.score), source: `${item.pluginTitle} ${item.source}` })}
        </Info_Alert.Description>
      </Info_Alert>
      <Info_Section title={t('memwise.inbox.identity.compare')}>
        <table className="w-full text-label" data-identity-table>
          <thead>
            <tr className="border-b border-separator text-left text-label-sm text-tertiary">
              <th className="px-4 py-2 font-medium">{t('memwise.inbox.identity.field')}</th>
              <th className="px-4 py-2 font-medium">{t('memwise.inbox.identity.ours')}</th>
              <th className="px-4 py-2 font-medium">{t('memwise.inbox.identity.theirs', { plugin: item.pluginTitle })}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.field} className="border-b border-separator last:border-0" data-same={r.same === null ? 'unknown' : String(r.same)}>
                <td className="px-4 py-2 text-secondary">{humanize(r.field)}</td>
                <td className={cn('px-4 py-2', r.same === false && 'font-medium text-info')}>{formatValueInline(r.ours, t, i18n.language)}</td>
                <td className={cn('px-4 py-2', r.same === false && 'font-medium text-info')}>{formatValueInline(r.theirs, t, i18n.language)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Info_Section>
      {item.reasons.length > 0 && (
        <Info_Section title={t('memwise.inbox.identity.why')}>
          <ul className="list-disc space-y-1 px-8 py-3 text-label text-secondary">
            {item.reasons.map(r => <li key={r}>{r}</li>)}
          </ul>
        </Info_Section>
      )}
      <p className="px-1 text-label-sm text-tertiary">{t('memwise.inbox.identity.ifSame', { method: matchMethodLabel('person', t) })}</p>
      <div className="flex flex-wrap justify-end gap-2">
        {decide && (
          <>
            <Button variant="secondary" onClick={() => void run('reject', () => decide({ candidateId: item.candidateId, decision: 'reject' }))} disabled={!!busy || result?.applied} data-decision="reject">
              {busy === 'reject' ? t('memwise.inbox.sending') : t('memwise.inbox.identity.different')}
            </Button>
            <Button variant="primary" onClick={() => void run('confirm', () => decide({ candidateId: item.candidateId, decision: 'confirm' }))} disabled={!!busy || result?.applied} data-decision="confirm">
              {busy === 'confirm' ? t('memwise.inbox.sending') : t('memwise.inbox.identity.same')}
            </Button>
          </>
        )}
      </div>
      <ResultMessage result={result} />
    </>
  )
}
