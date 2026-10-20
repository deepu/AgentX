/**
 * "Start a case": pick a playbook, optionally fill in what's known already (the playbook's
 * case fields that people enter), then start it and open the new case.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtom, useAtomValue } from 'jotai'
import { toast } from 'sonner'
import type { MwField, MwPlaybook } from '@memwise/shared/protocol'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { navigate, routes } from '@/lib/navigate'
import { memwisePlaybooksAtom, memwiseStartCaseDialogAtom, memwiseWorkspaceIdAtom } from '@/atoms/memwise'
import { getMemwiseApi, useMemwiseRefresh, useMemwiseUpload } from '@/hooks/useMemwise'
import { GeneratedForm } from './GeneratedForm'
import { buildSubmission, initialFormValues, type FormError, type FormValues } from './form-model'

/**
 * Case fields a person would enter at the start: those a person or client step writes (so
 * bookkeeping fields no step fills, like a status, stay out); without such steps, every field
 * agent or system steps don't write.
 */
export function startFields(playbook: MwPlaybook): MwField[] {
  const machineWritten = new Set<string>()
  const personWritten = new Set<string>()
  for (const step of Object.values(playbook.steps)) {
    const target = step.performer === 'agent' || step.performer === 'system' ? machineWritten : personWritten
    for (const w of step.writes) target.add(w.name)
  }
  return playbook.caseFields
    .filter(f => (personWritten.size ? personWritten.has(f.name) : !machineWritten.has(f.name)) && !f.type.startsWith('Ref<'))
    .map(f => ({ ...f, required: false }))
}

export function StartCaseDialog() {
  const { t } = useTranslation()
  const [state, setState] = useAtom(memwiseStartCaseDialogAtom)
  const playbooks = useAtomValue(memwisePlaybooksAtom)
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  const refresh = useMemwiseRefresh()
  const upload = useMemwiseUpload()
  const [workflowId, setWorkflowId] = React.useState<string | undefined>()
  const [playbook, setPlaybook] = React.useState<MwPlaybook | null>(null)
  const [values, setValues] = React.useState<FormValues>({})
  const [errors, setErrors] = React.useState<Record<string, FormError[]>>({})
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)

  // Reset on open, preselecting the playbook it was opened from (or the only one).
  React.useEffect(() => {
    if (!state.open) return
    setWorkflowId(state.workflowId ?? (playbooks?.length === 1 ? playbooks[0]!.id : undefined))
    setValues({})
    setErrors({})
    setMessage(null)
  }, [state.open, state.workflowId, playbooks])

  React.useEffect(() => {
    setPlaybook(null)
    const api = getMemwiseApi()
    if (!state.open || !workflowId || !api || !workspaceId) return
    let stale = false
    api.memwiseGetPlaybook(workspaceId, workflowId)
      .then(pb => {
        if (stale) return
        setPlaybook(pb)
        setValues(initialFormValues(startFields(pb)))
      })
      .catch(err => { if (!stale) setMessage(err instanceof Error ? err.message : String(err)) })
    return () => { stale = true }
  }, [state.open, workflowId, workspaceId])

  const fields = React.useMemo(() => (playbook ? startFields(playbook) : []), [playbook])
  const close = () => setState({ open: false })

  const start = async () => {
    const api = getMemwiseApi()
    if (!api || !workspaceId || !workflowId) return
    const s = buildSubmission(fields, values)
    setErrors(s.errors)
    if (!s.valid) return
    setBusy(true)
    setMessage(null)
    try {
      const created = await api.memwiseStartCase(workspaceId, { workflowId, values: Object.keys(s.values).length ? s.values : undefined })
      toast.success(t('memwise.cases.started', { title: created.title }))
      close()
      void refresh()
      navigate(routes.view.cases(created.caseId))
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={state.open} onOpenChange={open => { if (!open) close() }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('memwise.cases.startCase')}</DialogTitle>
          <DialogDescription>{t('memwise.cases.startDescription')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-label font-medium">{t('memwise.cases.playbook')}</label>
            <Select value={workflowId} onValueChange={setWorkflowId}>
              <SelectTrigger aria-label={t('memwise.cases.playbook')}>
                <SelectValue placeholder={t('memwise.cases.choosePlaybook')} />
              </SelectTrigger>
              <SelectContent>
                {(playbooks ?? []).map(p => <SelectItem key={p.id} value={p.id}>{p.title}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {fields.length > 0 && (
            <div className="space-y-2">
              <p className="text-label-sm text-secondary">{t('memwise.cases.initialValues')}</p>
              <div className="max-h-[50vh] overflow-y-auto pr-3">
                <div>
                  <GeneratedForm
                    fields={fields}
                    values={values}
                    onChange={(name, v) => setValues(prev => ({ ...prev, [name]: v }))}
                    errors={errors}
                    onUpload={upload}
                    disabled={busy}
                  />
                </div>
              </div>
            </div>
          )}
          {message && <p className="text-label-sm text-destructive" role="alert">{message}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => void start()} disabled={!workflowId || busy}>
            {busy ? t('memwise.cases.starting') : t('memwise.cases.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
