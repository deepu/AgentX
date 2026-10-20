/**
 * A form generated from a step's fields (their type expressions and JSON Schema; see
 * form-model.ts). Controlled: the caller holds the values and the errors, so the inbox
 * and the start-a-case dialog share it.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Paperclip, Plus, Trash2, X } from 'lucide-react'
import type { MwDocument, MwField } from '@memwise/shared/protocol'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { formatBytes, humanize } from './format'
import {
  emptyItem,
  IDENTIFIER_EXAMPLES,
  groupAmount,
  toFormField,
  type DocumentDraft,
  type FormError,
  type FormField,
  type FormValue,
  type FormValues,
  DEFAULT_CURRENCY,
  type MoneyDraft,
} from './form-model'

export type UploadFile = (file: File) => Promise<MwDocument>

export interface GeneratedFormProps {
  fields: MwField[]
  values: FormValues
  onChange: (name: string, value: FormValue) => void
  /** Client-side problems (i18n keys) per field. */
  errors?: Record<string, FormError[]>
  /** Problems the server reported per field, as it worded them. */
  serverErrors?: Record<string, string[]>
  onUpload?: UploadFile
  disabled?: boolean
  className?: string
}

export function GeneratedForm({ fields, values, onChange, errors, serverErrors, onUpload, disabled, className }: GeneratedFormProps) {
  return (
    <div className={cn('space-y-4', className)} data-memwise-form>
      {fields.map(f => {
        const ff = toFormField(f)
        return (
          <FieldRow
            key={f.name}
            field={ff}
            value={values[f.name] ?? null}
            onChange={v => onChange(f.name, v)}
            errors={errors?.[f.name]}
            serverErrors={serverErrors?.[f.name]}
            onUpload={onUpload}
            disabled={disabled}
          />
        )
      })}
    </div>
  )
}

interface FieldRowProps {
  field: FormField
  value: FormValue
  onChange: (v: FormValue) => void
  errors?: FormError[]
  serverErrors?: string[]
  onUpload?: UploadFile
  disabled?: boolean
  /** Inside a record row: smaller label, no description. */
  nested?: boolean
}

function FieldRow({ field, value, onChange, errors, serverErrors, onUpload, disabled, nested }: FieldRowProps) {
  const { t } = useTranslation()
  const id = React.useId()
  const messages = [
    ...(errors ?? []).map(e => (e.at ? `${humanizeAt(e.at)}: ` : '') + t(e.key, e.params)),
    ...(serverErrors ?? []),
  ]
  const hint = fieldHint(field, t)
  return (
    <div className="space-y-1.5" data-field={field.name} data-kind={field.kind}>
      {field.kind !== 'boolean' && (
        <label htmlFor={id} className={cn('block font-medium text-foreground', nested ? 'text-label-sm' : 'text-label')}>
          {field.label}
          {field.required && <span className="ml-0.5 text-destructive" aria-hidden>*</span>}
          {!field.required && !nested && <span className="ml-1.5 font-normal text-tertiary">{t('memwise.form.optional')}</span>}
        </label>
      )}
      <FieldControl id={id} field={field} value={value} onChange={onChange} onUpload={onUpload} disabled={disabled} invalid={messages.length > 0} />
      {!nested && (field.description || hint) && (
        <p className="text-label-sm text-tertiary">{[field.description, hint].filter(Boolean).join(' · ')}</p>
      )}
      {messages.map((m, i) => (
        <p key={i} className="text-label-sm text-destructive" role="alert">{m}</p>
      ))}
    </div>
  )
}

function humanizeAt(at: string): string {
  // `[1].document` → "Row 2 · Document"
  return at
    .split(/(?=\[)|\./)
    .filter(Boolean)
    .map(part => {
      const row = /^\[(\d+)\]$/.exec(part)
      return row ? `#${Number(row[1]) + 1}` : humanize(part)
    })
    .join(' · ')
}

function fieldHint(field: FormField, t: ReturnType<typeof useTranslation>['t']): string | undefined {
  if (field.kind === 'identifier' && field.scheme) {
    const example = IDENTIFIER_EXAMPLES[field.scheme.toUpperCase()]
    return example
      ? t('memwise.form.identifierHintExample', { scheme: field.scheme, example })
      : t('memwise.form.identifierHint', { scheme: field.scheme })
  }
  if (field.kind === 'money') return t('memwise.form.moneyHint')
  return undefined
}

interface FieldControlProps {
  id: string
  field: FormField
  value: FormValue
  onChange: (v: FormValue) => void
  onUpload?: UploadFile
  disabled?: boolean
  invalid?: boolean
}

function FieldControl({ id, field, value, onChange, onUpload, disabled, invalid }: FieldControlProps) {
  const { t } = useTranslation()
  const str = typeof value === 'string' ? value : ''
  const aria = { 'aria-invalid': invalid || undefined }

  switch (field.kind) {
    case 'boolean':
      return (
        <label className="flex items-center gap-2.5 text-label text-foreground">
          <Switch id={id} checked={value === true} onCheckedChange={c => onChange(c)} disabled={disabled} />
          <span>{field.label}</span>
        </label>
      )
    case 'enum':
      return (
        <Select value={str || undefined} onValueChange={v => onChange(v)} disabled={disabled}>
          <SelectTrigger id={id} {...aria}>
            <SelectValue placeholder={t('memwise.form.choose')} />
          </SelectTrigger>
          {/* The form also sits in the start-case dialog (z-modal): open above it, not behind. */}
          <SelectContent style={{ zIndex: 'var(--z-floating-menu)' }}>
            {(field.options ?? []).map(o => <SelectItem key={o} value={o}>{humanize(o)}</SelectItem>)}
          </SelectContent>
        </Select>
      )
    case 'longtext':
      return <Textarea id={id} value={str} onChange={e => onChange(e.target.value)} disabled={disabled} rows={3} {...aria} />
    case 'money': {
      const m = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : { amount: '', currency: DEFAULT_CURRENCY }) as MoneyDraft
      return (
        <div className="flex gap-2">
          <Input
            id={id}
            inputMode="decimal"
            value={m.amount ?? ''}
            placeholder={t('memwise.form.amount')}
            onChange={e => onChange({ ...m, amount: e.target.value })}
            onBlur={() => { const g = groupAmount(m.amount ?? '', m.currency); if (g !== m.amount) onChange({ ...m, amount: g }) }}
            disabled={disabled}
            className="flex-1"
            {...aria}
          />
          <Input
            aria-label={t('memwise.form.currency')}
            value={m.currency ?? ''}
            placeholder={DEFAULT_CURRENCY}
            maxLength={3}
            onChange={e => onChange({ ...m, currency: e.target.value.toUpperCase() })}
            disabled={disabled}
            className="w-20 uppercase"
          />
        </div>
      )
    }
    case 'document':
    case 'documents':
      return <DocumentPicker id={id} multiple={field.kind === 'documents'} value={value} onChange={onChange} onUpload={onUpload} disabled={disabled} />
    case 'records':
    case 'list':
      return <RepeatableRows field={field} value={value} onChange={onChange} onUpload={onUpload} disabled={disabled} />
    case 'record': {
      const rec = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as Record<string, FormValue>
      return (
        <div className="grid gap-3 rounded-md bg-fill-hover/50 p-3 sm:grid-cols-2">
          {(field.itemFields ?? []).map(f => (
            <FieldRow key={f.name} nested field={f} value={rec[f.name] ?? null} onChange={v => onChange({ ...rec, [f.name]: v })} onUpload={onUpload} disabled={disabled} />
          ))}
        </div>
      )
    }
    default: {
      const type = field.kind === 'email' ? 'email' : field.kind === 'number' ? 'text' : field.kind === 'date' ? 'date' : field.kind === 'datetime' ? 'datetime-local' : field.kind === 'phone' ? 'tel' : 'text'
      const example = field.kind === 'identifier' && field.scheme ? IDENTIFIER_EXAMPLES[field.scheme.toUpperCase()] : undefined
      return (
        <Input
          id={id}
          type={type}
          inputMode={field.kind === 'number' ? 'decimal' : undefined}
          value={str}
          placeholder={example}
          onChange={e => onChange(e.target.value)}
          onBlur={field.kind === 'number' ? () => { const g = groupAmount(str); if (g !== str) onChange(g) } : undefined}
          disabled={disabled}
          className={field.kind === 'identifier' ? 'font-mono' : undefined}
          {...aria}
        />
      )
    }
  }
}

function DocumentPicker({ id, multiple, value, onChange, onUpload, disabled }: {
  id: string
  multiple: boolean
  value: FormValue
  onChange: (v: FormValue) => void
  onUpload?: UploadFile
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)
  const docs: DocumentDraft[] = multiple
    ? (Array.isArray(value) ? (value as DocumentDraft[]) : [])
    : (value && typeof value === 'object' && !Array.isArray(value) && 'name' in value ? [value as DocumentDraft] : [])

  const pick = async (files: FileList | null) => {
    if (!files || files.length === 0 || !onUpload) return
    setError(null)
    const list = Array.from(multiple ? files : [files[0]!])
    setUploading(n => n + list.length)
    const added: DocumentDraft[] = []
    for (const file of list) {
      try {
        added.push(await onUpload(file))
      } catch (err) {
        setError(t('memwise.form.uploadFailed', { name: file.name, error: err instanceof Error ? err.message : String(err) }))
      } finally {
        setUploading(n => n - 1)
      }
    }
    if (added.length) onChange(multiple ? [...docs, ...added] : added[0]!)
    if (inputRef.current) inputRef.current.value = ''
  }

  const remove = (i: number) => {
    if (multiple) onChange(docs.filter((_, j) => j !== i))
    else onChange(null)
  }

  return (
    <div className="space-y-2">
      {docs.length > 0 && (
        <ul className="space-y-1">
          {docs.map((d, i) => (
            <li key={`${d.name}-${i}`} className="flex items-center gap-2 rounded-sm bg-fill-hover px-2 py-1 text-label">
              <Paperclip className="size-3.5 shrink-0 text-secondary" />
              <span className="min-w-0 flex-1 truncate">{d.name}</span>
              {typeof d.size === 'number' && <span className="shrink-0 text-label-sm text-tertiary tabular-nums">{formatBytes(d.size)}</span>}
              <button
                type="button"
                className="inline-grid size-5 place-items-center rounded-sm text-secondary hover:bg-fill-pressed hover:text-foreground"
                onClick={() => remove(i)}
                disabled={disabled}
                aria-label={t('memwise.form.removeFile', { name: d.name })}
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={inputRef}
        id={id}
        type="file"
        multiple={multiple}
        className="sr-only"
        onChange={e => void pick(e.target.files)}
        disabled={disabled || !onUpload}
      />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || !onUpload || uploading > 0}
      >
        <Paperclip />
        {uploading > 0 ? t('memwise.form.uploading') : multiple ? t('memwise.form.chooseFiles') : t('memwise.form.chooseFile')}
      </Button>
      {error && <p className="text-label-sm text-destructive" role="alert">{error}</p>}
    </div>
  )
}

function RepeatableRows({ field, value, onChange, onUpload, disabled }: {
  field: FormField
  value: FormValue
  onChange: (v: FormValue) => void
  onUpload?: UploadFile
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const rows = Array.isArray(value) ? value : []
  const set = (i: number, v: FormValue) => onChange(rows.map((r, j) => (j === i ? v : r)))
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i))
  const itemField: FormField = field.kind === 'records'
    ? { ...field, kind: 'record', required: false }
    : { ...field, kind: field.itemKind ?? 'text', required: false, label: field.label }

  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <div key={i} className="flex items-start gap-2" data-row={i}>
          <div className="min-w-0 flex-1">
            <FieldControl id={`${field.name}-${i}`} field={itemField} value={row} onChange={v => set(i, v)} onUpload={onUpload} disabled={disabled} />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => remove(i)}
            disabled={disabled}
            aria-label={t('memwise.form.removeRow')}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button type="button" variant="secondary" size="sm" onClick={() => onChange([...rows, emptyItem(field)])} disabled={disabled}>
        <Plus />
        {t('memwise.form.addRow')}
      </Button>
    </div>
  )
}
