/** One field of the form, by its kind, with its badge, offers and problems. */

import * as React from 'react'
import type { ExternalDocument, ExternalFormField, ExtractSuggestion } from '@memwise/defs/external'
import { currencySymbol, DEFAULT_CURRENCY, formatBytes, formatValue, groupAmount, normalizeIdentifier, type Draft, type MoneyDraft } from './model'
import { Icon } from './ui'
import { S } from './strings'

export interface Upload { key: string; field: string; name: string; progress: number }

export interface FieldRowProps {
  field: ExternalFormField
  draft: Draft | undefined
  onChange: (draft: Draft) => void
  error?: string
  /** The suggestion the value came from, while it still is that value. */
  source?: ExtractSuggestion
  offers: ExtractSuggestion[]
  onUse: (s: ExtractSuggestion) => void
  disabled?: boolean
  // files
  uploads?: Upload[]
  onFiles?: (field: ExternalFormField, files: File[]) => void
  accept?: string
  fileNote?: string
  /** Camera on phones ("Take a photo"). */
  camera?: boolean
}

export function FieldRow(props: FieldRowProps) {
  const { field, error, source, offers, onUse, disabled } = props
  const id = `f-${field.name}`
  const helpId = `${id}-help`
  const errorId = `${id}-error`
  const group = field.kind === 'boolean' || (field.kind === 'enum' && (field.options?.length ?? 0) <= 5)
  const files = field.kind === 'document' || field.kind === 'documents'
  const hint = field.kind === 'identifier' && field.placeholder ? S.identifierLike(field.placeholder) : undefined
  const help = [field.help, hint].filter(Boolean).join(' · ')
  const describedBy = [help ? helpId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined

  const label = (
    <>
      <span className="label-text">{field.label}</span>
      {!field.required && <span className="label-optional">{S.optional}</span>}
    </>
  )

  const body = (
    <>
      {source && <SourceBadge suggestion={source} />}
      <Control {...props} id={id} describedBy={describedBy} invalid={!!error} />
      {help && <p className="help" id={helpId}>{help}</p>}
      {error && <p className="error" id={errorId}><Icon name="alert" className="icon small" />{error}</p>}
      {offers.map(s => (
        <div className="offer" key={s.id} data-offer={s.field}>
          <p className="offer-text">
            <span className="offer-from">{S.foundIn(s.document)}</span>{' '}
            <span className="offer-value">{formatValue(s.value, field)}</span>
          </p>
          <button type="button" className="button secondary compact" onClick={() => onUse(s)} disabled={disabled}
            aria-label={`${S.useThis}: ${formatValue(s.value, field)}`}>
            {S.useThis}
          </button>
        </div>
      ))}
    </>
  )

  if (group) {
    return (
      <fieldset className="field" data-field={field.name} data-kind={field.kind} data-invalid={error ? '' : undefined} aria-describedby={describedBy}>
        <legend className="label">{label}</legend>
        {body}
      </fieldset>
    )
  }
  return (
    <div className="field" data-field={field.name} data-kind={field.kind} data-invalid={error ? '' : undefined}>
      {files
        ? <p className="label" id={`${id}-label`}>{label}</p>
        : <label className="label" htmlFor={id}>{label}</label>}
      {body}
    </div>
  )
}

function SourceBadge({ suggestion }: { suggestion: ExtractSuggestion }) {
  const [open, setOpen] = React.useState(false)
  const quoteId = `q-${suggestion.id}`
  const hasQuote = !!suggestion.quote?.trim()
  return (
    <div className="source">
      <button
        type="button"
        className="badge-button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={hasQuote ? open : undefined}
        aria-controls={hasQuote ? quoteId : undefined}
        disabled={!hasQuote}
        data-badge="extracted"
      >
        <span className="badge"><Icon name="doc" className="icon small" />{S.fromDocument(suggestion.document)}</span>
        {hasQuote && <span className="badge-more">{open ? S.hideWhere : S.showWhere}</span>}
      </button>
      {hasQuote && open && (
        <blockquote className="quote" id={quoteId}>
          <span className="quote-from">{S.readFrom(suggestion.document)}</span> “{suggestion.quote!.trim()}”
        </blockquote>
      )}
    </div>
  )
}

interface ControlProps extends FieldRowProps { id: string; describedBy?: string; invalid: boolean }

function Control(props: ControlProps) {
  const { field, draft, onChange, disabled, id, describedBy, invalid } = props
  const common = {
    id,
    name: field.name,
    disabled,
    'aria-invalid': invalid || undefined,
    'aria-describedby': describedBy,
    'aria-required': field.required || undefined,
  }
  const str = typeof draft === 'string' ? draft : ''

  switch (field.kind) {
    case 'longtext':
      return <textarea {...common} className="input" rows={4} value={str} placeholder={field.placeholder} onChange={e => onChange(e.target.value)} />
    case 'email':
      return <input {...common} className="input" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} value={str} placeholder={field.placeholder} onChange={e => onChange(e.target.value)} />
    case 'phone':
      return <input {...common} className="input" type="tel" inputMode="tel" autoComplete="tel" value={str} placeholder={field.placeholder} onChange={e => onChange(e.target.value)} />
    case 'identifier':
      return (
        <input
          {...common}
          className="input mono"
          type="text"
          autoComplete="off"
          autoCapitalize={field.upperCase ? 'characters' : 'none'}
          autoCorrect="off"
          spellCheck={false}
          value={str}
          placeholder={field.placeholder}
          onChange={e => onChange(field.upperCase ? e.target.value.toUpperCase() : e.target.value)}
          onBlur={() => { const n = normalizeIdentifier(str, field.upperCase ?? false); if (n !== str) onChange(n) }}
        />
      )
    case 'number':
      return (
        <input {...common} className="input" type="text" inputMode="decimal" autoComplete="off" value={str} placeholder={field.placeholder}
          onChange={e => onChange(e.target.value)}
          onBlur={() => { const g = groupAmount(str); if (g !== str) onChange(g) }} />
      )
    case 'money': {
      const m: MoneyDraft = typeof draft === 'object' && draft !== null && !Array.isArray(draft) ? draft : { amount: '', currency: field.currency ?? DEFAULT_CURRENCY }
      const symbol = currencySymbol(m.currency)
      return (
        <div className="money" data-invalid={invalid ? '' : undefined}>
          <span className="money-symbol" aria-hidden="true">{symbol}</span>
          <input {...common} className="input money-input" type="text" inputMode="decimal" autoComplete="off" value={m.amount}
            placeholder={field.placeholder ?? '0'}
            onChange={e => onChange({ ...m, amount: e.target.value })}
            onBlur={() => { const g = groupAmount(m.amount, m.currency); if (g !== m.amount) onChange({ ...m, amount: g }) }} />
          <span className="money-code">{m.currency}</span>
        </div>
      )
    }
    case 'date':
      return <input {...common} className="input" type="date" value={str} onChange={e => onChange(e.target.value)} />
    case 'boolean':
      return (
        <div className="choices row">
          {[true, false].map(v => (
            <label key={String(v)} className="choice">
              <input type="radio" name={field.name} checked={draft === v} onChange={() => onChange(v)} disabled={disabled} />
              <span>{v ? S.yes : S.no}</span>
            </label>
          ))}
        </div>
      )
    case 'enum': {
      const options = field.options ?? []
      if (options.length <= 5) {
        return (
          <div className="choices">
            {options.map(o => (
              <label key={o.value} className="choice">
                <input type="radio" name={field.name} value={o.value} checked={str === o.value} onChange={() => onChange(o.value)} disabled={disabled} />
                <span>{o.label}</span>
              </label>
            ))}
          </div>
        )
      }
      return (
        <select {...common} className="input select" value={str} onChange={e => onChange(e.target.value)}>
          <option value="">{S.choose}</option>
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )
    }
    case 'document':
    case 'documents':
      return <FilePicker {...props} />
    default:
      return <input {...common} className="input" type="text" autoComplete={/name/i.test(field.name) ? 'name' : 'off'} value={str} placeholder={field.placeholder} onChange={e => onChange(e.target.value)} />
  }
}

function FilePicker({ field, draft, onChange, disabled, id, uploads = [], onFiles, accept, fileNote, camera, invalid, describedBy }: ControlProps) {
  const pickRef = React.useRef<HTMLInputElement>(null)
  const cameraRef = React.useRef<HTMLInputElement>(null)
  const docs: ExternalDocument[] = Array.isArray(draft) ? draft : []
  const multiple = field.kind === 'documents'
  const mine = uploads.filter(u => u.field === field.name)
  const full = !multiple && (docs.length > 0 || mine.length > 0)

  const take = (list: FileList | null, input: HTMLInputElement | null) => {
    const files = Array.from(list ?? [])
    if (input) input.value = ''
    if (files.length) onFiles?.(field, multiple ? files : files.slice(0, 1))
  }

  return (
    <div className="files" data-invalid={invalid ? '' : undefined}>
      {(docs.length > 0 || mine.length > 0) && (
        <ul className="file-list" aria-labelledby={`${id}-label`}>
          {docs.map(d => (
            <li key={d.id} className="file" data-file={d.name}>
              <Icon name="doc" className="icon file-icon" />
              <span className="file-name">{d.name}</span>
              <span className="file-size">{formatBytes(d.size)}</span>
              <button type="button" className="icon-button" onClick={() => onChange(docs.filter(x => x.id !== d.id))} disabled={disabled} aria-label={S.remove(d.name)}>
                <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </li>
          ))}
          {mine.map(u => (
            <li key={u.key} className="file uploading" aria-live="polite">
              <Icon name="doc" className="icon file-icon" />
              <span className="file-name">{S.uploading(u.name)}</span>
              <progress className="file-progress" max={1} value={u.progress} aria-label={S.uploading(u.name)} />
            </li>
          ))}
        </ul>
      )}
      {!full && (
        <div className="file-actions">
          <input ref={pickRef} id={id} className="visually-hidden" type="file" multiple={multiple} accept={accept} tabIndex={-1}
            aria-describedby={describedBy} onChange={e => take(e.target.files, e.target)} disabled={disabled} />
          <button type="button" className="button secondary" onClick={() => pickRef.current?.click()} disabled={disabled} aria-describedby={describedBy}>
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" /></svg>
            {docs.length > 0 ? S.addMore : multiple ? S.chooseFiles : S.chooseFile}
          </button>
          {camera && (
            <>
              <input ref={cameraRef} className="visually-hidden" type="file" accept="image/*" capture="environment" tabIndex={-1}
                onChange={e => take(e.target.files, e.target)} disabled={disabled} />
              <button type="button" className="button secondary" onClick={() => cameraRef.current?.click()} disabled={disabled}>
                <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-3zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" /></svg>
                {S.takePhoto}
              </button>
            </>
          )}
        </div>
      )}
      {fileNote && <p className="error" role="alert"><Icon name="alert" className="icon small" />{fileNote}</p>}
    </div>
  )
}
