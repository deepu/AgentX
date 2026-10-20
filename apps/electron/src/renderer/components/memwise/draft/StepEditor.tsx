/**
 * The step editor (05 §9, 20 §8): one card per step of a draft. Title, who does it, how closely it
 * follows the instructions, the instructions and the checkpoint rules are edited here; what the
 * step reads, writes, may use and where each outcome goes are shown (shape changes go through
 * chat, D25). Parts that differ from the live playbook are marked, and so are the steps a chat
 * edit changed that still waits for keep or discard. Saving writes the whole step file into the
 * draft, changing only the keys edited (step-file.ts).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ChevronRight, Lock, Minus, PencilLine, Plus, Sparkles, Trash2, X } from 'lucide-react'
import type { MwDraft, MwPlaybook, MwRole, MwState, MwStep, MwWriteDraftResult } from '@memwise/shared/protocol'
import { Markdown } from '@memwise/ui'
import { Info_Badge } from '@/components/info/Info_Badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { humanize, resultMessage } from '../format'
import { EffectivePolicyView } from '../playbook/EffectivePolicyView'
import { Section, StepCheckpoint, StepFields, StepNext, StepTools } from '../playbook/StepDetail'
import { PerformerTag } from '../playbook/Tags'
import { performerLabel, roleTitle, stepOf } from '../playbook/labels'
import { changedParts, draftFileText, partLabel, pendingEditsForPath } from './draft-model'
import { applyStepEdit, readStepFile, type StepFileEdit } from './step-file'
import { DiagnosticList } from './ChecksView'

export interface SaveStepInput {
  path: string
  content: string
  summary: string
}

export interface StepEditorProps {
  draft: MwDraft
  /** The live playbook, for removed steps. */
  live?: MwPlaybook | null
  roles?: MwRole[]
  /** Absent: view only (a draft in review, published or discarded). */
  onSave?: (input: SaveStepInput) => Promise<MwWriteDraftResult>
  /** The step to bring into view (from the map or the changes list). */
  focusStepId?: string
  /** Start with this step's card open for editing (tests, playground). */
  editingStepId?: string
}

/** A section of the card, marked when the change touches it. */
function Part({ parts, changed, pending, children, className }: {
  parts: string[]
  changed: Set<string>
  pending: boolean
  children: React.ReactNode
  className?: string
}) {
  const hit = parts.filter(p => changed.has(p))
  if (hit.length === 0) return <div className={className}>{children}</div>
  return (
    <div
      className={cn(
        '-mx-2 rounded-md px-2 py-1.5',
        pending ? 'bg-accent-tint/60 inset-ring inset-ring-accent/30' : 'bg-info-tint/60 inset-ring inset-ring-[var(--info-border)]',
        className,
      )}
      data-part-changed={hit.join(' ')}
      data-part-pending={pending || undefined}
    >
      {children}
    </div>
  )
}

const PERFORMERS = ['agent', 'person', 'external', 'system'] as const
const STRICTNESS = ['strict', 'guided', 'open'] as const

interface FormState {
  title: string
  performer: MwStep['performer']
  assignee: string
  strictness: MwStep['strictness']
  instructions: string
  checkpoint: string[]
}

function initialForm(step: MwStep, text?: string): FormState {
  return {
    title: step.title,
    performer: step.performer,
    assignee: step.assignee ?? '',
    strictness: step.strictness,
    instructions: (text ? readStepFile(text)?.instructions : undefined) ?? step.instructions,
    checkpoint: step.checkpoint.length ? [...step.checkpoint] : [],
  }
}

/** What changed between the step and the form, as an edit and the parts it touches. */
function formEdit(step: MwStep, form: FormState): { edit: StepFileEdit; parts: string[] } {
  const edit: StepFileEdit = {}
  const parts: string[] = []
  if (form.title.trim() !== step.title) { edit.title = form.title.trim(); parts.push('title') }
  if (form.performer !== step.performer) { edit.performer = form.performer; parts.push('performer') }
  const assignee = form.performer === 'person' || form.performer === 'external' ? form.assignee : ''
  if ((assignee || undefined) !== step.assignee) { edit.assignee = assignee || null; parts.push('assignee') }
  if (form.strictness !== step.strictness) { edit.strictness = form.strictness; parts.push('strictness') }
  if (form.instructions.trim() !== step.instructions.trim()) { edit.instructions = form.instructions; parts.push('instructions') }
  const rules = form.checkpoint.map(r => r.trim()).filter(Boolean)
  if (rules.join('\n') !== step.checkpoint.join('\n')) { edit.checkpoint = rules; parts.push('checkpoint') }
  return { edit, parts }
}

function StepCard({ draft, playbook, state, step, number, roles, onSave, focus, startEditing }: {
  draft: MwDraft
  playbook: MwPlaybook
  state: MwState
  step: MwStep
  number: number
  roles?: MwRole[]
  onSave?: StepEditorProps['onSave']
  focus?: boolean
  startEditing?: boolean
}) {
  const { t, i18n } = useTranslation()
  const ref = React.useRef<HTMLElement>(null)
  const structure = draft.structure?.steps[step.id]
  const changed = changedParts(draft.structure, step.id)
  const isNew = structure?.change === 'added'
  const pendingEdits = pendingEditsForPath(draft, step.file)
  const pending = pendingEdits.length > 0
  const text = draftFileText(draft, step.file)
  const editable = !!onSave && text !== undefined
  const [editing, setEditing] = React.useState(!!startEditing && editable)
  const [form, setForm] = React.useState<FormState>(() => initialForm(step, text))
  const [saving, setSaving] = React.useState(false)
  const [result, setResult] = React.useState<MwWriteDraftResult | null>(null)
  const performer = performerLabel(step, state, t, roles)

  React.useEffect(() => {
    if (focus) ref.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }, [focus])

  const startEdit = () => {
    setForm(initialForm(step, text))
    setResult(null)
    setEditing(true)
  }

  const save = async () => {
    if (!onSave || text === undefined) return
    const { edit, parts } = formEdit(step, form)
    if (parts.length === 0) { setEditing(false); return }
    let content: string
    try {
      content = applyStepEdit(text, edit)
    } catch (err) {
      setResult({ applied: false, diagnostics: [], message: err instanceof Error ? err.message : String(err) })
      return
    }
    setSaving(true)
    setResult(null)
    try {
      const list = new Intl.ListFormat(i18n.resolvedLanguage, { type: 'conjunction' }).format(parts.map(p => partLabel(p, t)))
      const r = await onSave({ path: step.file, content, summary: t('memwise.editor.summary', { step: form.title.trim() || step.title, parts: list }) })
      setResult(r)
      if (r.applied && !r.diagnostics.some(d => d.severity === 'error')) setEditing(false)
    } catch (err) {
      setResult({ applied: false, diagnostics: [], message: err instanceof Error ? err.message : String(err) })
    } finally {
      setSaving(false)
    }
  }

  const needsRole = form.performer === 'person' || form.performer === 'external'

  return (
    <article
      ref={ref}
      aria-label={t('memwise.playbook.stepNumber', { number, title: step.title })}
      className={cn(
        'scroll-mt-4 rounded-lg bg-raised p-4 shadow-elev-1',
        isNew && 'inset-ring inset-ring-[var(--success-border)]',
        pending && 'ring-2 ring-accent/40',
        focus && !pending && 'ring-2 ring-foreground/15',
      )}
      data-step-card={step.id}
      data-step-change={structure?.change}
      data-step-pending={pending || undefined}
    >
      <header className="flex flex-wrap items-start gap-3">
        <span className="w-6 shrink-0 text-right font-serif text-[22px] leading-7 text-tertiary tabular-nums" aria-hidden>{number}</span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <PerformerTag performer={performer} />
            {isNew && <Info_Badge color="success" icon={<Plus />}>{t('memwise.editor.new')}</Info_Badge>}
            {structure?.change === 'changed' && (
              <Info_Badge color="warning" icon={<PencilLine />}>
                {t('memwise.editor.changed', { parts: structure.parts.map(p => partLabel(p, t)).join(', ') })}
              </Info_Badge>
            )}
            {pending && <Info_Badge className="bg-accent-tint text-accent" icon={<Sparkles />}>{t('memwise.editor.fromChat')}</Info_Badge>}
          </div>
          {!editing && (
            <Part parts={['title']} changed={changed} pending={pending}>
              <h3 className="text-copy-lg font-semibold text-foreground">{step.title}</h3>
            </Part>
          )}
        </div>
        {!editing && editable && (
          <Button variant="secondary" size="sm" onClick={startEdit} data-action="edit-step">
            <PencilLine />
            {t('memwise.editor.edit')}
          </Button>
        )}
        {!editing && onSave && !editable && (
          <span className="inline-flex items-center gap-1 text-label-sm text-tertiary" title={t('memwise.editor.readOnlyHint')}>
            <Lock className="size-3" aria-hidden />
            {t('memwise.editor.readOnly')}
          </span>
        )}
      </header>

      <div className="mt-3 flex flex-col gap-4 pl-9">
        {editing ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={e => { e.preventDefault(); void save() }}
            data-step-form={step.id}
          >
            <label className="flex flex-col gap-1.5">
              <span className="text-label font-medium text-foreground">{t('memwise.editor.title')}</span>
              <Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} disabled={saving} />
            </label>
            <div className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
              <div className="flex flex-col gap-1.5">
                <span className="text-label font-medium text-foreground">{t('memwise.editor.performer')}</span>
                <Select value={form.performer} onValueChange={v => setForm(f => ({ ...f, performer: v as MwStep['performer'] }))} disabled={saving}>
                  <SelectTrigger aria-label={t('memwise.editor.performer')}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PERFORMERS.map(p => <SelectItem key={p} value={p}>{t(`memwise.playbook.performer.${p}`)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {needsRole && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-label font-medium text-foreground">{t(form.performer === 'external' ? 'memwise.editor.helpedBy' : 'memwise.editor.assignee')}</span>
                  <Select value={form.assignee || undefined} onValueChange={v => setForm(f => ({ ...f, assignee: v }))} disabled={saving}>
                    <SelectTrigger aria-label={t('memwise.editor.assignee')}><SelectValue placeholder={t('memwise.editor.chooseRole')} /></SelectTrigger>
                    <SelectContent>
                      {(roles ?? []).map(r => <SelectItem key={r.id} value={r.id}>{r.title}</SelectItem>)}
                      {form.assignee && !(roles ?? []).some(r => r.id === form.assignee) && (
                        <SelectItem value={form.assignee}>{roleTitle(form.assignee, roles)}</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {form.performer === 'agent' && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-label font-medium text-foreground">{t('memwise.playbook.strictness.label')}</span>
                  <Select value={form.strictness} onValueChange={v => setForm(f => ({ ...f, strictness: v as MwStep['strictness'] }))} disabled={saving}>
                    <SelectTrigger aria-label={t('memwise.playbook.strictness.label')}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {STRICTNESS.map(s => <SelectItem key={s} value={s}>{t(`memwise.playbook.strictness.${s}`)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="text-label font-medium text-foreground">{t('memwise.editor.instructions')}</span>
              <span className="text-label-sm text-tertiary">{t('memwise.editor.instructionsHint')}</span>
              <Textarea
                value={form.instructions}
                onChange={e => setForm(f => ({ ...f, instructions: e.target.value }))}
                rows={Math.min(18, Math.max(6, form.instructions.split('\n').length + 1))}
                className="font-mono text-[13px] leading-5"
                disabled={saving}
              />
            </label>
            <div className="flex flex-col gap-1.5">
              <span className="text-label font-medium text-foreground">{t('memwise.playbook.checkpoint')}</span>
              <span className="text-label-sm text-tertiary">{t('memwise.editor.checkpointHint')}</span>
              {form.checkpoint.map((rule, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={rule}
                    aria-label={t('memwise.editor.rule', { number: i + 1 })}
                    onChange={e => setForm(f => ({ ...f, checkpoint: f.checkpoint.map((r, j) => (j === i ? e.target.value : r)) }))}
                    disabled={saving}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t('memwise.editor.removeRule')}
                    onClick={() => setForm(f => ({ ...f, checkpoint: f.checkpoint.filter((_, j) => j !== i) }))}
                    disabled={saving}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setForm(f => ({ ...f, checkpoint: [...f.checkpoint, ''] }))} disabled={saving}>
                <Plus />
                {t('memwise.editor.addRule')}
              </Button>
            </div>
            {result && !result.applied && (
              <p className="text-label-sm text-destructive" role="alert">{resultMessage(result, t) || t('memwise.inbox.notApplied')}</p>
            )}
            {result && result.diagnostics.length > 0 && (
              <div className="overflow-hidden rounded-md bg-sunken">
                <p className="px-4 pt-2 text-label-sm font-medium text-secondary">{t('memwise.editor.checksAfterSave')}</p>
                <DiagnosticList diagnostics={result.diagnostics} />
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => { setEditing(false); setResult(null) }} disabled={saving}>
                <X />
                {t('common.cancel')}
              </Button>
              <Button type="submit" variant="primary" disabled={saving || !form.title.trim()} data-action="save-step">
                {saving ? t('memwise.editor.saving') : t('memwise.editor.save')}
              </Button>
            </div>
          </form>
        ) : (
          <>
            <Part parts={['performer', 'assignee', 'engine', 'strictness']} changed={changed} pending={pending}>
              <Section title={t('memwise.editor.who')}>
                <p className="text-label text-secondary">
                  {performer.label}
                  {performer.note && <span className="text-tertiary"> · {performer.note}</span>}
                  {step.performer === 'agent' && <span className="text-tertiary"> · {t(`memwise.playbook.strictness.${step.strictness}`)}</span>}
                </p>
              </Section>
            </Part>
            <Part parts={['instructions']} changed={changed} pending={pending}>
              <Section title={t('memwise.editor.instructions')}>
                {step.instructions.trim() ? (
                  <div className="text-label-lg text-secondary"><Markdown mode="minimal">{step.instructions}</Markdown></div>
                ) : (
                  <p className="text-label text-tertiary">{t('memwise.editor.noInstructions')}</p>
                )}
              </Section>
            </Part>
            <Part parts={['checkpoint']} changed={changed} pending={pending}>
              {step.checkpoint.length ? <StepCheckpoint step={step} /> : (
                <Section title={t('memwise.playbook.checkpoint')}><p className="text-label text-tertiary">{t('memwise.editor.noRules')}</p></Section>
              )}
            </Part>
            {result?.applied && result.diagnostics.length > 0 && (
              <div className="overflow-hidden rounded-md bg-sunken">
                <p className="px-4 pt-2 text-label-sm font-medium text-secondary">{t('memwise.editor.checksAfterSave')}</p>
                <DiagnosticList diagnostics={result.diagnostics} />
              </div>
            )}
          </>
        )}

        <Part parts={['reads', 'writes']} changed={changed} pending={pending}>
          <StepFields step={step} playbook={playbook} />
        </Part>
        <Part parts={['tools']} changed={changed} pending={pending}>
          <StepTools step={step} />
        </Part>
        <Part parts={['outcomes', 'map', 'outcomeFrom']} changed={changed} pending={pending}>
          {step.outcomes.length > 0 && (
            <Section title={t('memwise.playbook.outcomes')} className="mb-3">
              <p className="text-label text-secondary">{step.outcomes.map(humanize).join(', ')}</p>
            </Section>
          )}
          <StepNext playbook={playbook} state={state} />
          <p className="mt-1 text-label-sm text-tertiary">{t('memwise.editor.shapeByChat')}</p>
        </Part>
        <Part parts={['policy', 'budget', 'model']} changed={changed} pending={pending}>
          <PolicyFold step={step} />
        </Part>
      </div>
    </article>
  )
}

function PolicyFold({ step }: { step: MwStep }) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const id = React.useId()
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(o => !o)}
        className="inline-flex h-control-sm items-center gap-1 rounded-sm px-1.5 -ml-1.5 text-label text-secondary hover:bg-fill-hover hover:text-foreground"
      >
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} aria-hidden />
        {t('memwise.playbook.policy.title')}
      </button>
      {open && <div id={id} className="mt-2"><EffectivePolicyView rules={step.policy} /></div>}
    </div>
  )
}

function RemovedStepCard({ step }: { step: MwStep }) {
  const { t } = useTranslation()
  return (
    <article className="rounded-lg border border-dashed border-destructive/60 px-4 py-3 opacity-80" data-step-card={step.id} data-step-change="removed">
      <div className="flex flex-wrap items-center gap-2">
        <Info_Badge color="destructive" icon={<Minus />}>{t('memwise.editor.removed')}</Info_Badge>
        <span className="text-label font-medium text-foreground line-through decoration-destructive/60">{step.title}</span>
      </div>
    </article>
  )
}

/** Every step of the draft as a card, in reading order; steps the change removes at the end. */
export function StepEditor({ draft, live, roles, onSave, focusStepId, editingStepId }: StepEditorProps) {
  const { t } = useTranslation()
  const playbook = draft.playbook
  if (!playbook) {
    return (
      <div className="flex items-start gap-2.5 rounded-lg bg-info-tint px-3.5 py-3 text-label" role="status">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
        <span className="text-secondary">{t('memwise.editor.doesNotLoad')}</span>
      </div>
    )
  }
  const removed = Object.entries(draft.structure?.steps ?? {})
    .filter(([, s]) => s.change === 'removed')
    .map(([id]) => live?.steps[id] ?? live?.steps[live.states.find(s => s.id === id)?.stepId ?? ''])
    .filter((s): s is MwStep => !!s)
  let number = 0
  return (
    <div className="flex flex-col gap-4" data-step-editor>
      {playbook.states.map(state => {
        const step = stepOf(playbook, state)
        if (!step) return null
        number += 1
        return (
          <StepCard
            key={state.id}
            draft={draft}
            playbook={playbook}
            state={state}
            step={step}
            number={number}
            roles={roles}
            onSave={onSave}
            focus={focusStepId === state.id || focusStepId === step.id}
            startEditing={editingStepId === step.id}
          />
        )
      })}
      {removed.map(step => <RemovedStepCard key={step.id} step={step} />)}
    </div>
  )
}
