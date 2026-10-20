/**
 * Dialogs for building and improving playbooks (20 §8): "New playbook" asks what it should do,
 * then starts building it by chat; "Save as example" turns a case into an example case, with what
 * a step should have done when it is a correction.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtom } from 'jotai'
import { toast } from 'sonner'
import type { MwCase, MwExampleFromCaseInput, MwExampleFromCaseResult, MwPlaybook } from '@memwise/shared/protocol'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { navigate, routes } from '@/lib/navigate'
import { memwiseNewPlaybookDialogAtom } from '@/atoms/memwise'
import { useMemwiseBuildPlaybook } from '@/hooks/useMemwise'
import { humanize, outcomeLabel, resultMessage } from './format'

/** Shows the build chat beside what it builds: the build's case here, the chat in a new panel. */
export function openBuildChat(result: { sessionId: string; caseId: string }, opts: { stay?: boolean } = {}) {
  if (!opts.stay) navigate(routes.view.cases(result.caseId))
  navigate(routes.view.allSessions(result.sessionId), { newPanel: true })
}

export function NewPlaybookDialog() {
  const [open, setOpen] = useAtom(memwiseNewPlaybookDialogAtom)
  const build = useMemwiseBuildPlaybook()
  const [request, setRequest] = React.useState('')
  const [title, setTitle] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setRequest('')
    setTitle('')
    setError(null)
  }, [open])

  const start = async () => {
    if (!request.trim()) return
    setBusy(true)
    setError(null)
    try {
      const result = await build({ request: request.trim(), ...(title.trim() ? { title: title.trim() } : {}) })
      if (!result) return
      setOpen(false)
      openBuildChat(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <NewPlaybookForm
      open={open}
      onOpenChange={setOpen}
      request={request}
      onRequestChange={setRequest}
      title={title}
      onTitleChange={setTitle}
      busy={busy}
      error={error}
      onStart={() => void start()}
    />
  )
}

/** The dialog's form, presentational. */
export function NewPlaybookForm({ open, onOpenChange, request, onRequestChange, title, onTitleChange, busy, error, onStart }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  request: string
  onRequestChange: (v: string) => void
  title: string
  onTitleChange: (v: string) => void
  busy?: boolean
  error?: string | null
  onStart: () => void
}) {
  const { t } = useTranslation()
  const requestId = React.useId()
  const titleId = React.useId()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('memwise.build.newPlaybook')}</DialogTitle>
          <DialogDescription>{t('memwise.build.newDescription')}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={e => { e.preventDefault(); onStart() }}>
          <div className="space-y-1.5">
            <label htmlFor={requestId} className="block text-label font-medium">{t('memwise.build.whatShouldItDo')}</label>
            <Textarea
              id={requestId}
              value={request}
              onChange={e => onRequestChange(e.target.value)}
              placeholder={t('memwise.build.requestPlaceholder')}
              rows={4}
              disabled={busy}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={titleId} className="block text-label font-medium">
              {t('memwise.build.title')}
              <span className="ml-1.5 font-normal text-tertiary">{t('memwise.form.optional')}</span>
            </label>
            <Input id={titleId} value={title} onChange={e => onTitleChange(e.target.value)} placeholder={t('memwise.build.titlePlaceholder')} disabled={busy} />
          </div>
          {error && <p className="text-label-sm text-destructive" role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={!request.trim() || busy}>
              {busy ? t('memwise.build.starting') : t('memwise.build.start')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- save as example

export interface SaveAsExampleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  kase: MwCase
  playbook?: MwPlaybook | null
  save: (input: MwExampleFromCaseInput) => Promise<MwExampleFromCaseResult>
}

/** The steps a case went through, each once (the latest run), for "What should this step have done?". */
export function correctableSteps(kase: MwCase, playbook?: MwPlaybook | null): { stepId: string; title: string; outcomes: string[]; outcome?: string }[] {
  const out = new Map<string, { stepId: string; title: string; outcomes: string[]; outcome?: string }>()
  for (const run of kase.timeline) {
    const step = playbook?.steps[run.stepId]
    const outcomes = step?.outcomes.length ? step.outcomes : run.outcome ? [run.outcome] : []
    if (!outcomes.length) continue
    out.set(run.stepId, { stepId: run.stepId, title: step?.title ?? run.title, outcomes, outcome: run.outcome })
  }
  return [...out.values()]
}

export function SaveAsExampleDialog({ open, onOpenChange, kase, playbook, save }: SaveAsExampleDialogProps) {
  const { t } = useTranslation()
  const steps = React.useMemo(() => correctableSteps(kase, playbook), [kase, playbook])
  const [name, setName] = React.useState('')
  const [correct, setCorrect] = React.useState(false)
  const [stepId, setStepId] = React.useState<string | undefined>()
  const [outcome, setOutcome] = React.useState<string | undefined>()
  const [note, setNote] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const nameId = React.useId()
  const noteId = React.useId()

  React.useEffect(() => {
    if (!open) return
    setName('')
    setCorrect(false)
    setStepId(undefined)
    setOutcome(undefined)
    setNote('')
    setError(null)
  }, [open])

  const step = steps.find(s => s.stepId === stepId)
  const ready = !correct || (!!stepId && !!outcome)

  const submit = async () => {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      const result = await save({
        caseId: kase.caseId,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(correct && stepId && outcome ? { correction: { step: stepId, outcome, ...(note.trim() ? { note: note.trim() } : {}) } } : {}),
      })
      if (!result.applied) {
        setError(resultMessage(result, t) || t('memwise.inbox.notApplied'))
        return
      }
      onOpenChange(false)
      const draftId = result.draftId
      toast.success(t('memwise.example.saved'), {
        description: t('memwise.example.savedDescription'),
        ...(draftId ? { action: { label: t('memwise.example.openDraft'), onClick: () => navigate(routes.view.draft(draftId)) } } : {}),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('memwise.example.title')}</DialogTitle>
          <DialogDescription>{t('memwise.example.description')}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={e => { e.preventDefault(); void submit() }}>
          <div className="space-y-1.5">
            <label htmlFor={nameId} className="block text-label font-medium">
              {t('memwise.example.name')}
              <span className="ml-1.5 font-normal text-tertiary">{t('memwise.form.optional')}</span>
            </label>
            <Input id={nameId} value={name} onChange={e => setName(e.target.value)} placeholder={kase.title} disabled={busy} />
          </div>
          <label className="flex items-start gap-3">
            <Switch checked={correct} onCheckedChange={setCorrect} disabled={busy || steps.length === 0} className="mt-0.5" />
            <span className="space-y-0.5">
              <span className="block text-label font-medium">{t('memwise.example.correction')}</span>
              <span className="block text-label-sm text-tertiary">{t('memwise.example.correctionHint')}</span>
            </span>
          </label>
          {correct && (
            <div className="space-y-3 rounded-lg bg-sunken p-3">
              <div className="space-y-1.5">
                <span className="block text-label font-medium">{t('memwise.example.whichStep')}</span>
                <Select value={stepId} onValueChange={v => { setStepId(v); setOutcome(undefined) }} disabled={busy}>
                  <SelectTrigger aria-label={t('memwise.example.whichStep')}><SelectValue placeholder={t('memwise.example.chooseStep')} /></SelectTrigger>
                  <SelectContent>
                    {steps.map(s => <SelectItem key={s.stepId} value={s.stepId}>{s.title}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {step && (
                <div className="space-y-1.5">
                  <span className="block text-label font-medium">{t('memwise.example.shouldHave')}</span>
                  {step.outcome && <span className="block text-label-sm text-tertiary">{t('memwise.example.itDid', { outcome: humanize(step.outcome) })}</span>}
                  <Select value={outcome} onValueChange={setOutcome} disabled={busy}>
                    <SelectTrigger aria-label={t('memwise.example.shouldHave')}><SelectValue placeholder={t('memwise.example.chooseOutcome')} /></SelectTrigger>
                    <SelectContent>
                      {step.outcomes.map(o => <SelectItem key={o} value={o}>{outcomeLabel(o, t)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-1.5">
                <label htmlFor={noteId} className="block text-label font-medium">
                  {t('memwise.example.note')}
                  <span className="ml-1.5 font-normal text-tertiary">{t('memwise.form.optional')}</span>
                </label>
                <Textarea id={noteId} value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder={t('memwise.example.notePlaceholder')} disabled={busy} />
              </div>
            </div>
          )}
          {error && <p className="text-label-sm text-destructive" role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={!ready || busy}>
              {busy ? t('memwise.example.saving') : t('memwise.example.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
