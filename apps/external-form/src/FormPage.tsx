/**
 * The form a link opens (`/f/<token>`): who is asking, the step's instructions and the comments
 * sent back, the fields, files read into answers, a draft saved as the person goes, and one
 * submission. Every refusal and connection problem gets a plain page of its own.
 */

import * as React from 'react'
import type { ExternalForm, ExternalFormField, ExtractSuggestion, LinkRefusal } from '@memwise/defs/external'
import { formApi, isRefusal, Unreachable, type FormApi } from './api'
import { FieldRow, type Upload } from './fields'
import {
  activeSource,
  applySuggestions,
  buildSubmission,
  clockTime,
  draftPayload,
  fileProblem,
  initialDrafts,
  initialSources,
  longDate,
  mergeSuggestions,
  offersFor,
  submitSources,
  toDraft,
  type Draft,
  type Drafts,
} from './model'
import { Callout, Frame, Icon, Instructions, Loading, MessagePage, RefusalPage, TroublePage } from './ui'
import { S } from './strings'

type Phase =
  | { kind: 'loading' }
  | { kind: 'trouble'; error: Unreachable }
  | { kind: 'refused'; refusal: LinkRefusal }
  | { kind: 'open'; form: ExternalForm }
  | { kind: 'done'; form: ExternalForm }

const SAVE_DELAY_MS = 1200

export function FormPage({ apiBase, api: given }: { apiBase: string; api?: FormApi }) {
  const api = React.useMemo(() => given ?? formApi(apiBase), [given, apiBase])
  const [phase, setPhase] = React.useState<Phase>({ kind: 'loading' })

  const load = React.useCallback(async () => {
    setPhase({ kind: 'loading' })
    try {
      const answer = await api.form()
      setPhase(isRefusal(answer) ? { kind: 'refused', refusal: answer } : { kind: 'open', form: answer })
    } catch (err) {
      setPhase({ kind: 'trouble', error: err instanceof Unreachable ? err : new Unreachable('network') })
    }
  }, [api])

  React.useEffect(() => { void load() }, [load])

  React.useEffect(() => {
    if (phase.kind === 'open' || phase.kind === 'done') document.title = `${phase.form.title} · ${phase.form.business}`
  }, [phase])

  switch (phase.kind) {
    case 'loading': return <Loading />
    case 'trouble': return <TroublePage error={phase.error} onRetry={() => void load()} />
    case 'refused': return <RefusalPage refusal={phase.refusal} onRetry={() => void load()} />
    case 'done': {
      const first = phase.form.participant.name?.trim().split(/\s+/)[0]
      return (
        <MessagePage icon="check" tone="good" title={S.thanks(first)}>
          <p data-done>{S.hasDetails(phase.form.business)}</p>
          <p className="muted">{S.closePage}</p>
        </MessagePage>
      )
    }
    case 'open':
      return (
        <OpenForm
          form={phase.form}
          api={api}
          onDone={() => setPhase({ kind: 'done', form: phase.form })}
          onRefused={refusal => setPhase({ kind: 'refused', refusal })}
        />
      )
  }
}

type SaveState = { state: 'idle' | 'saving' | 'saved' | 'failed'; at?: string }

function OpenForm({ form, api, onDone, onRefused }: {
  form: ExternalForm
  api: FormApi
  onDone: () => void
  onRefused: (r: LinkRefusal) => void
}) {
  const [drafts, setDrafts] = React.useState<Drafts>(() => initialDrafts(form.fields))
  const [sources, setSources] = React.useState<Record<string, string>>(() => initialSources(form.fields))
  const [suggestions, setSuggestions] = React.useState<ExtractSuggestion[]>(form.suggestions)
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [uploads, setUploads] = React.useState<Upload[]>([])
  const [fileNotes, setFileNotes] = React.useState<Record<string, string>>({})
  const [reading, setReading] = React.useState(false)
  const [readNote, setReadNote] = React.useState<{ tone: 'good' | 'info' | 'warn'; text: string } | null>(null)
  const [readIds, setReadIds] = React.useState<Set<string>>(() => new Set(form.suggestions.map(s => s.documentId)))
  const [save, setSave] = React.useState<SaveState>(form.draftSavedAt ? { state: 'saved', at: form.draftSavedAt } : { state: 'idle' })
  const [sending, setSending] = React.useState(false)
  const [topNote, setTopNote] = React.useState<{ tone: 'error' | 'warn'; text: string } | null>(null)
  const dirty = React.useRef(false)
  const draftsRef = React.useRef(drafts)
  draftsRef.current = drafts
  const sourcesRef = React.useRef(sources)
  sourcesRef.current = sources
  const suggestionsRef = React.useRef(suggestions)
  suggestionsRef.current = suggestions
  const sendingRef = React.useRef(false)
  const camera = React.useMemo(() => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches, [])

  const extract = form.extract
  const docField = extract ? form.fields.find(f => f.name === extract.documentsField) : undefined
  // With extraction on offer the documents come first: what they say fills the rest.
  const ordered = React.useMemo(
    () => (docField ? [docField, ...form.fields.filter(f => f !== docField)] : form.fields),
    [form.fields, docField],
  )

  // ---- the draft, saved as the person goes
  const saveNow = React.useCallback(async () => {
    if (!dirty.current || sendingRef.current) return
    dirty.current = false
    setSave(s => ({ ...s, state: 'saving' }))
    try {
      const r = await api.saveDraft(draftPayload(form.fields, draftsRef.current))
      if (isRefusal(r)) { onRefused(r); return }
      setSave({ state: 'saved', at: r.savedAt })
    } catch {
      dirty.current = true
      setSave(s => ({ ...s, state: 'failed' }))
    }
  }, [api, form.fields, onRefused])

  const [changes, setChanges] = React.useState(0)
  React.useEffect(() => {
    if (changes === 0) return
    const timer = setTimeout(() => void saveNow(), SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [changes, saveNow])

  React.useEffect(() => {
    const flush = () => { if (document.visibilityState === 'hidden') void saveNow() }
    const online = () => { if (dirty.current) void saveNow() }
    document.addEventListener('visibilitychange', flush)
    window.addEventListener('online', online)
    return () => {
      document.removeEventListener('visibilitychange', flush)
      window.removeEventListener('online', online)
    }
  }, [saveNow])

  const touch = () => { dirty.current = true; setChanges(n => n + 1) }

  const setField = (field: ExternalFormField, draft: Draft) => {
    setDrafts(prev => ({ ...prev, [field.name]: draft }))
    if (errors[field.name]) setErrors(prev => { const next = { ...prev }; delete next[field.name]; return next })
    touch()
  }

  const useSuggestion = (field: ExternalFormField, s: ExtractSuggestion) => {
    setField(field, toDraft(field, s.value))
    setSources(prev => ({ ...prev, [field.name]: s.id }))
  }

  // ---- reading the documents into answers
  const read = React.useCallback(async (documentIds: string[]) => {
    if (!extract || documentIds.length === 0) return
    setReading(true)
    setReadNote(null)
    try {
      const r = await api.extract(documentIds)
      if (isRefusal(r)) {
        if (r.status === 'rate_limited') setReadNote({ tone: 'warn', text: r.message || S.readFailed })
        else onRefused(r)
        return
      }
      setReadIds(prev => new Set([...prev, ...documentIds]))
      const all = mergeSuggestions(suggestionsRef.current, r.suggestions)
      setSuggestions(all)
      const next = applySuggestions(form.fields, { drafts: draftsRef.current, sources: sourcesRef.current }, r.suggestions, all)
      if (next.filled.length) {
        setDrafts(next.drafts)
        setSources(next.sources)
        setErrors(prev => { const e = { ...prev }; for (const f of next.filled) delete e[f]; return e })
        touch()
      }
      const offered = r.suggestions.some(s => !next.filled.includes(s.field))
      setReadNote(next.filled.length
        ? { tone: 'good', text: S.filledSome(next.filled.length) }
        : offered ? { tone: 'info', text: S.foundOnly } : { tone: 'info', text: S.foundNothing })
    } catch {
      setReadNote({ tone: 'warn', text: S.readFailed })
    } finally {
      setReading(false)
    }
  }, [api, extract, form.fields, onRefused])

  // ---- files
  const onFiles = async (field: ExternalFormField, files: File[]) => {
    const current = drafts[field.name]
    const have = Array.isArray(current) ? current.length : 0
    const room = Math.max(0, form.limits.maxFiles - have - uploads.filter(u => u.field === field.name).length)
    const notes: string[] = []
    const ok: File[] = []
    for (const f of files) {
      const problem = fileProblem(f, form.limits)
      if (problem) notes.push(problem)
      else if (ok.length >= room) { notes.push(S.tooManyFiles(form.limits.maxFiles)); break }
      else ok.push(f)
    }
    setFileNotes(prev => ({ ...prev, [field.name]: notes.join(' ') }))
    if (ok.length === 0) return
    const batch = ok.map((file, i) => ({ file, up: { key: `${Date.now()}-${i}-${file.name}`, field: field.name, name: file.name, progress: 0 } }))
    setUploads(prev => [...prev, ...batch.map(b => b.up)])
    const added: string[] = []
    const failed: string[] = []
    await Promise.all(batch.map(async ({ file, up }) => {
      try {
        const r = await api.upload(file, p => setUploads(prev => prev.map(u => (u.key === up.key ? { ...u, progress: p } : u))))
        if ('document' in r) {
          const doc = r.document
          added.push(doc.id)
          setDrafts(prev => {
            const list = Array.isArray(prev[field.name]) ? (prev[field.name] as typeof doc[]) : []
            return { ...prev, [field.name]: field.kind === 'document' ? [doc] : [...list, doc] }
          })
          setErrors(prev => { if (!prev[field.name]) return prev; const e = { ...prev }; delete e[field.name]; return e })
        } else if (isRefusal(r)) {
          if (r.status === 'rate_limited') failed.push(r.message || S.uploadFailed(file.name))
          else onRefused(r)
        } else {
          failed.push(r.message || S.uploadFailed(file.name))
        }
      } catch {
        failed.push(S.uploadFailed(file.name))
      } finally {
        setUploads(prev => prev.filter(u => u.key !== up.key))
      }
    }))
    if (failed.length) setFileNotes(prev => ({ ...prev, [field.name]: [prev[field.name], ...failed].filter(Boolean).join(' ') }))
    if (added.length) {
      touch()
      // Read what was just added, so the answers it holds appear without another tap.
      if (extract && field.name === extract.documentsField) void read(added)
    }
  }

  // ---- sending
  const formRef = React.useRef<HTMLFormElement>(null)
  const focusField = (name: string) => {
    const row = formRef.current?.querySelector<HTMLElement>(`[data-field="${CSS.escape(name)}"]`)
    const target = row?.querySelector<HTMLElement>('input:not(.visually-hidden), textarea, select, button')
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    target?.focus({ preventScroll: true })
  }

  const send = async (outcome?: string) => {
    if (sendingRef.current) return
    const s = buildSubmission(form.fields, drafts)
    setErrors(s.errors)
    if (!s.valid) {
      const names = ordered.map(f => f.name).filter(n => s.errors[n])
      setTopNote({ tone: 'error', text: S.fixBelow(names.length) })
      if (names[0]) focusField(names[0])
      return
    }
    setTopNote(null)
    sendingRef.current = true
    setSending(true)
    try {
      const sourcesToSend = submitSources(form.fields, drafts, sources, suggestions)
      const r = await api.submit({
        ...(outcome ? { outcome } : {}),
        values: s.values,
        ...(Object.keys(sourcesToSend).length ? { sources: sourcesToSend } : {}),
      })
      if (r.status === 'applied') { onDone(); return }
      if (r.status === 'invalid') {
        const fieldErrors: Record<string, string> = {}
        for (const [k, list] of Object.entries(r.errors ?? {})) if (list.length) fieldErrors[k] = list.join(' ')
        setErrors(fieldErrors)
        const names = ordered.map(f => f.name).filter(n => fieldErrors[n])
        setTopNote({ tone: 'error', text: names.length ? S.fixBelow(names.length) : r.message })
        if (names[0]) focusField(names[0])
        else window.scrollTo({ top: 0, behavior: 'smooth' })
        return
      }
      if (r.status === 'rate_limited') { setTopNote({ tone: 'warn', text: r.message }); return }
      onRefused(r)
    } catch {
      setTopNote({ tone: 'warn', text: S.sendFailed })
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  const unread = docField && Array.isArray(drafts[docField.name])
    ? (drafts[docField.name] as { id: string }[]).map(d => d.id).filter(id => !readIds.has(id))
    : []
  const docsInField = docField && Array.isArray(drafts[docField.name]) ? (drafts[docField.name] as unknown[]).length : 0
  const busyUploading = uploads.length > 0
  const accept = form.limits.accept.join(',') || undefined
  const outcomes = form.outcomes.length > 1 ? form.outcomes : []

  const renderField = (field: ExternalFormField) => (
    <FieldRow
      key={field.name}
      field={field}
      draft={drafts[field.name]}
      onChange={d => setField(field, d)}
      error={errors[field.name]}
      source={activeSource(field, drafts[field.name], sources, suggestions)}
      offers={offersFor(field, drafts[field.name], suggestions)}
      onUse={s => useSuggestion(field, s)}
      disabled={sending}
      uploads={uploads}
      onFiles={(f, files) => void onFiles(f, files)}
      accept={accept}
      fileNote={fileNotes[field.name] || undefined}
      camera={camera}
    />
  )

  return (
    <Frame
      kicker={S.asks(form.business)}
      footer={
        <div className="submit-bar">
          <div className="submit-inner">
            <SaveStatus save={save} />
            <div className="submit-buttons">
              {outcomes.length > 0
                ? outcomes.map((o, i) => (
                    <button key={o.id} type={i === 0 ? 'submit' : 'button'} form="external-form" className={`button ${i === 0 ? 'primary' : 'secondary'}`}
                      onClick={i === 0 ? undefined : () => void send(o.id)} disabled={sending || busyUploading} data-outcome={o.id}>
                      {sending ? S.sending : o.label}
                    </button>
                  ))
                : (
                    <button type="submit" form="external-form" className="button primary wide" disabled={sending || busyUploading} data-submit>
                      {sending ? S.sending : S.send(form.business)}
                    </button>
                  )}
            </div>
          </div>
        </div>
      }
    >
      <h1 className="title">{form.title}</h1>
      <Instructions source={form.instructions} />

      {form.comments.length > 0 && (
        <section className="comments" aria-label={S.notesForYou} data-comments>
          {form.comments.map((c, i) => (
            <Callout key={i} tone="note" icon="mail">
              <p className="callout-title">{c.from === 'MemWise' ? S.noteFrom(form.business) : S.commentFrom(c.from)}</p>
              <p className="callout-text">{c.text}</p>
            </Callout>
          ))}
        </section>
      )}

      {topNote && <Callout tone={topNote.tone} icon="alert" live><p>{topNote.text}</p></Callout>}

      <form id="external-form" ref={formRef} className="form" noValidate onSubmit={e => { e.preventDefault(); void send(outcomes[0]?.id) }}>
        {docField && (
          <section className="read-docs" data-extract>
            {renderField(docField)}
            <p className="help">{S.readHelp}</p>
            {reading && (
              <p className="reading" role="status"><span className="spinner small" aria-hidden="true" />{S.reading}</p>
            )}
            {!reading && readNote && (
              <Callout tone={readNote.tone === 'warn' ? 'warn' : readNote.tone} icon={readNote.tone === 'good' ? 'check' : 'info'} live>
                <p>{readNote.text}</p>
              </Callout>
            )}
            {!reading && docsInField > 0 && (unread.length > 0 || readNote?.tone === 'warn') && (
              <button type="button" className="button secondary" onClick={() => void read(unread.length ? unread : (drafts[docField.name] as { id: string }[]).map(d => d.id))} disabled={sending || busyUploading} data-action="read">
                <Icon name="doc" />
                {readIds.size > 0 ? S.readAgain : S.readDocuments}
              </button>
            )}
          </section>
        )}
        {ordered.filter(f => f !== docField).map(renderField)}
        <p className="fine-print">
          {S.savedHelp}
          {form.expiresAt && longDate(form.expiresAt) ? ` ${S.expiresOn(longDate(form.expiresAt))}` : ''}
        </p>
      </form>
    </Frame>
  )
}

function SaveStatus({ save }: { save: SaveState }) {
  let text = ''
  if (save.state === 'saving') text = S.saving
  else if (save.state === 'failed') text = S.saveFailed
  else if (save.at) text = S.savedAt(clockTime(save.at))
  return <p className="save-status" data-save={save.state} aria-live="polite">{text}</p>
}
