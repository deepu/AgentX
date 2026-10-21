/**
 * "New <entity>" on an entity's Records page: a person creates a record by typing its own fields
 * (the required ones when the entity has any, like a Topic's name and question; else every field
 * it keeps itself). The rest comes from the playbooks that start on it ("Set up a watch" starts
 * when a Topic is created). The kernel decides who may create; a refusal is shown in the dialog.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { MwEntityType, MwField, MwRecordCreateInput, MwRecordWriteResult } from '@memwise/shared/protocol'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { GeneratedForm } from '../GeneratedForm'
import { buildSubmission, initialFormValues, type FormError, type FormValues } from '../form-model'

/** Fields a person types when creating a record: its own (not calculated, followed or references). */
export function newRecordFields(type: MwEntityType): MwField[] {
  const sources = type.definition?.sources
  const calculated = new Set((type.definition?.calculated ?? []).map(c => c.name))
  const own = type.fields.filter(f =>
    !calculated.has(f.name)
    && (!sources?.[f.name] || sources[f.name]!.kind === 'domain')
    && !f.type.startsWith('Ref<') && !f.type.startsWith('List<'))
  const required = own.filter(f => f.required)
  return required.length ? required : own
}

/**
 * A Text field typed in a multi-line box: free text like a Topic's question or inclusion rules.
 * Names, titles and ids stay one line.
 */
export function isLongTextField(field: Pick<MwField, 'name' | 'type'>): boolean {
  return field.type.trim() === 'Text' && !/(^|_)(name|title|id|code|number|key|email|phone)$/i.test(field.name)
}

export interface NewRecordDialogProps {
  open: boolean
  type: MwEntityType
  title: string
  onClose: () => void
  create: (input: MwRecordCreateInput) => Promise<MwRecordWriteResult>
  onCreated: (entity: string, id: string) => void
}

export function NewRecordDialog({ open, type, title, onClose, create, onCreated }: NewRecordDialogProps) {
  const { t } = useTranslation()
  const fields = React.useMemo(() => newRecordFields(type), [type])
  const [values, setValues] = React.useState<FormValues>({})
  const [errors, setErrors] = React.useState<Record<string, FormError[]>>({})
  const [serverErrors, setServerErrors] = React.useState<Record<string, string[]> | undefined>()
  const [message, setMessage] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setValues(initialFormValues(fields))
    setErrors({})
    setServerErrors(undefined)
    setMessage(null)
  }, [open, fields])

  const submit = async () => {
    const s = buildSubmission(fields, values)
    setErrors(s.errors)
    if (!s.valid) return
    setBusy(true)
    setMessage(null)
    setServerErrors(undefined)
    try {
      const entity = type.key ?? type.name
      const r = await create({ entity, values: s.values })
      if (r.applied && r.id) {
        onClose()
        onCreated(entity, r.id)
        return
      }
      if (r.errors) setServerErrors(r.errors)
      setMessage(r.message ? r.message[0]!.toUpperCase() + r.message.slice(1) : t('memwise.inbox.fixErrors'))
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('memwise.entities.newRecord', { entity: title })}</DialogTitle>
          <DialogDescription>{t('memwise.entities.newRecordDescription')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="max-h-[50vh] overflow-y-auto pr-3">
            <GeneratedForm
              fields={fields}
              values={values}
              onChange={(name, v) => {
                setValues(prev => ({ ...prev, [name]: v }))
                if (serverErrors?.[name]) setServerErrors(prev => { const next = { ...prev }; delete next[name]; return next })
              }}
              errors={errors}
              serverErrors={serverErrors}
              disabled={busy}
              multiline={isLongTextField}
            />
          </div>
          {message && <p className="text-label-sm text-destructive whitespace-pre-line" role="alert">{message}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? t('memwise.entities.creating') : t('memwise.entities.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
