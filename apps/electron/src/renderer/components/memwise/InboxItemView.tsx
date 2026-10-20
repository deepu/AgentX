/**
 * One inbox item, opened in place: a generated form (input), an approval card (decision),
 * an effect approval with its preview (approval), a stopped case's events (attention), or a
 * reminder. Presentational: the container passes the API calls in `actions`.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Bell, CheckCircle2, ClipboardList, Mail, ShieldCheck, Undo2 } from 'lucide-react'
import type {
  MwDecideApprovalInput,
  MwInboxItem,
  MwRole,
  MwSendEventInput,
  MwSubmitResult,
  MwSubmitStepInput,
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
import { GeneratedForm, type UploadFile } from './GeneratedForm'
import { buildSubmission, initialFormValues, type FormError, type FormValues } from './form-model'
import {
  absoluteTime,
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
  toolLabel,
  type PeopleById,
} from './format'

export interface InboxActions {
  submitStep: (input: MwSubmitStepInput) => Promise<MwSubmitResult>
  decideApproval: (input: MwDecideApprovalInput) => Promise<MwSubmitResult>
  sendEvent: (input: MwSendEventInput) => Promise<MwSubmitResult>
  uploadFile?: UploadFile
  openCase: (caseId: string) => void
  /** Called after the kernel accepted an answer. */
  onDone?: (result: MwSubmitResult) => void
}

export interface InboxItemViewProps {
  item: MwInboxItem
  actions: InboxActions
  people?: PeopleById
  roles?: MwRole[]
  now?: number
}

const KIND_ICON: Record<MwInboxItem['kind'], React.ReactNode> = {
  input: <ClipboardList />,
  decision: <CheckCircle2 />,
  approval: <ShieldCheck />,
  attention: <AlertTriangle />,
  reminder: <Bell />,
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
      {result.message && <Info_Alert.Description>{result.message}</Info_Alert.Description>}
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

export function InboxItemView({ item, actions, people = {}, roles, now }: InboxItemViewProps) {
  const { t, i18n } = useTranslation()
  const since = relativeTime(item.since, now, i18n.language)
  const dueAt = 'dueAt' in item ? item.dueAt : undefined

  return (
    <Info_Page.Content>
      <Info_Page.Hero
        avatar={<div className="grid size-full place-items-center bg-fill-hover text-secondary [&_svg]:size-4">{KIND_ICON[item.kind]}</div>}
        title={inboxItemStepTitle(item)}
        meta={
          <>
            <Info_Badge color={item.kind === 'attention' ? 'warning' : 'default'}>{inboxKindLabel(item.kind, t)}</Info_Badge>
            <button type="button" className="font-medium text-foreground hover:underline" onClick={() => actions.openCase(item.caseId)}>
              {item.caseTitle}
            </button>
            <span title={absoluteTime(item.since, i18n.language)}>{t('memwise.inbox.waitingSince', { time: since })}</span>
            {dueAt && <span>{t('memwise.inbox.due', { time: relativeTime(dueAt, now, i18n.language) })}</span>}
          </>
        }
      />
      {item.kind === 'input' && <InputBody item={item} actions={actions} people={people} />}
      {item.kind === 'decision' && <DecisionBody item={item} actions={actions} people={people} roles={roles} />}
      {item.kind === 'approval' && <ApprovalBody item={item} actions={actions} />}
      {item.kind === 'attention' && <AttentionBody item={item} actions={actions} />}
      {item.kind === 'reminder' && <ReminderBody item={item} actions={actions} />}
    </Info_Page.Content>
  )
}

// ---------------------------------------------------------------- input

function InputBody({ item, actions, people }: { item: Extract<MwInboxItem, { kind: 'input' }>; actions: InboxActions; people: PeopleById }) {
  const { t } = useTranslation()
  const [values, setValues] = React.useState<FormValues>(() => initialFormValues(item.fields, item.prefill))
  const [errors, setErrors] = React.useState<Record<string, FormError[]>>({})
  const { busy, result, run } = useAnswer(actions.onDone)
  const outcomes = item.outcomes.length ? item.outcomes : ['submitted']
  const hasContext = Object.keys(item.context).length > 0

  const submit = (outcome: string) => {
    const s = buildSubmission(item.fields, values)
    setErrors(s.errors)
    if (!s.valid) return
    void run(outcome, () => actions.submitStep({ stepRunId: item.stepRunId, outcome, values: s.values }))
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

function DecisionBody({ item, actions, people, roles }: {
  item: Extract<MwInboxItem, { kind: 'decision' }>
  actions: InboxActions
  people: PeopleById
  roles?: MwRole[]
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
      <Info_Section title={t('memwise.inbox.whatToReview')}>
        <CaseFieldList values={item.context} people={people} />
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
        <Info_Alert.Description>{item.reason}</Info_Alert.Description>
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
  return (
    <>
      <Info_Alert variant="warning" icon={<Bell />}>
        <Info_Alert.Title>{t('memwise.inbox.reminderTitle')}</Info_Alert.Title>
        <Info_Alert.Description className={cn('whitespace-pre-wrap')}>{item.text}</Info_Alert.Description>
      </Info_Alert>
      <div className="flex justify-end">
        <Button variant="primary" onClick={() => actions.openCase(item.caseId)}>{t('memwise.inbox.openCase')}</Button>
      </div>
    </>
  )
}
