/**
 * An inspector's read-only view of a regulated project (`/v/<token>`, Stage 5,
 * docs/memwise/26-projects-and-pages.md §8; mock EInspector): the TMF index's zones, the filed
 * documents of a zone, a document with its signatures, its audit trail and its file, and
 * questions to the study team with their answers. Nothing here changes anything; the business
 * logs every view and download.
 */

import * as React from 'react'
import type {
  InspectorPageDocument, InspectorPageIndex, InspectorPageQuestion, InspectorRefusal, InspectorTrailEntry,
} from '@memwise/defs/external'
import { inspectorApi, isInspectorRefusal, Unreachable, type InspectorApi } from './api'
import { Callout, Icon, Loading, MessagePage, TroublePage } from './ui'
import { documentLine, formatSize, formatWhen, lastSignature, trailWhat, trailWho } from './inspector-model'
import { S } from './strings'

type Phase =
  | { kind: 'loading' }
  | { kind: 'trouble'; error: Unreachable }
  | { kind: 'refused'; refusal: InspectorRefusal }
  | { kind: 'open'; index: InspectorPageIndex }

export function InspectorPage({ apiBase, api: given }: { apiBase: string; api?: InspectorApi }) {
  const api = React.useMemo(() => given ?? inspectorApi(apiBase), [given, apiBase])
  const [phase, setPhase] = React.useState<Phase>({ kind: 'loading' })

  const load = React.useCallback(async () => {
    setPhase({ kind: 'loading' })
    try {
      const answer = await api.index()
      setPhase(isInspectorRefusal(answer) ? { kind: 'refused', refusal: answer } : { kind: 'open', index: answer })
    } catch (err) {
      setPhase({ kind: 'trouble', error: err instanceof Unreachable ? err : new Unreachable('network') })
    }
  }, [api])

  React.useEffect(() => { void load() }, [load])
  React.useEffect(() => {
    if (phase.kind === 'open') document.title = `${phase.index.session.name} · ${phase.index.session.projectName}`
  }, [phase])

  switch (phase.kind) {
    case 'loading': return <Loading />
    case 'trouble': return <TroublePage error={phase.error} onRetry={() => void load()} />
    case 'refused': return <InspectorRefusalPage refusal={phase.refusal} />
    case 'open': return <InspectorView index={phase.index} api={api} onRefused={refusal => setPhase({ kind: 'refused', refusal })} />
  }
}

export function InspectorRefusalPage({ refusal }: { refusal: InspectorRefusal }) {
  const [title, body] = refusal.refused === 'expired' ? [S.inspEndedTitle, S.inspEndedBody]
    : refusal.refused === 'revoked' ? [S.inspRevokedTitle, S.inspRevokedBody]
      : [S.inspUnknownTitle, S.inspUnknownBody]
  return (
    <MessagePage icon={refusal.refused === 'expired' ? 'clock' : refusal.refused === 'revoked' ? 'lock' : 'search'} title={title}>
      <p data-refusal={refusal.refused}>{body}</p>
    </MessagePage>
  )
}

/** The view itself: zones, the zone's documents, the chosen document. */
export function InspectorView({ index, api, onRefused, initial }: {
  index: InspectorPageIndex
  api: InspectorApi
  onRefused: (r: InspectorRefusal) => void
  /** Tests and screenshots: what is already loaded. */
  initial?: { zone?: string; documents?: InspectorPageDocument[]; total?: number; selected?: InspectorPageDocument; trail?: InspectorTrailEntry[]; requests?: InspectorPageQuestion[] }
}) {
  const s = index.session
  const firstZone = initial?.zone ?? index.zones.find(z => z.filed > 0)?.number ?? index.zones[0]?.number ?? ''
  const [zone, setZone] = React.useState(firstZone)
  const [site, setSite] = React.useState('')
  const [query, setQuery] = React.useState('')
  const [docs, setDocs] = React.useState<{ documents: InspectorPageDocument[]; total: number } | null>(
    initial?.documents ? { documents: initial.documents, total: initial.total ?? initial.documents.length } : null)
  const [selected, setSelected] = React.useState<InspectorPageDocument | null>(initial?.selected ?? null)
  const [view, setView] = React.useState<'document' | 'trail'>(initial?.trail ? 'trail' : 'document')
  const [trail, setTrail] = React.useState<{ entries: InspectorTrailEntry[]; chain: { ok: boolean } } | null>(
    initial?.trail ? { entries: initial.trail, chain: { ok: true } } : null)
  const [requests, setRequests] = React.useState<InspectorPageQuestion[]>(initial?.requests ?? [])
  const [asking, setAsking] = React.useState(false)
  const [note, setNote] = React.useState<{ tone: 'good' | 'warn'; text: string } | null>(null)
  const skipFirst = React.useRef(!!initial?.documents)

  const guard = React.useCallback(<T,>(r: T | InspectorRefusal): T | null => {
    if (isInspectorRefusal(r)) { onRefused(r); return null }
    return r
  }, [onRefused])

  // The zone's documents (search waits for a pause in typing).
  React.useEffect(() => {
    if (skipFirst.current) { skipFirst.current = false; return }
    let live = true
    const t = setTimeout(async () => {
      try {
        const r = guard(await api.documents({ zone, ...(site ? { site } : {}), ...(query.trim() ? { q: query.trim() } : {}) }))
        if (live && r) setDocs(r)
      } catch { if (live) setNote({ tone: 'warn', text: S.networkBody }) }
    }, query ? 300 : 0)
    return () => { live = false; clearTimeout(t) }
  }, [api, zone, site, query, guard])

  const loadRequests = React.useCallback(async () => {
    try {
      const r = guard(await api.requests())
      if (r) setRequests(r)
    } catch { /* shown again on the next load */ }
  }, [api, guard])
  React.useEffect(() => { if (!initial?.requests) void loadRequests() }, [loadRequests, initial?.requests])

  const open = async (d: InspectorPageDocument) => {
    setNote(null)
    setAsking(false)
    setView('document')
    setTrail(null)
    try {
      const r = guard(await api.document(d.entity, d.id))
      if (r && 'id' in r) setSelected(r)
    } catch { setNote({ tone: 'warn', text: S.networkBody }) }
  }

  const showTrail = async () => {
    if (!selected) return
    setView('trail')
    if (trail) return
    try {
      const r = guard(await api.trail(selected.entity, selected.id))
      if (r && 'entries' in r) setTrail(r)
    } catch { setNote({ tone: 'warn', text: S.networkBody }) }
  }

  const zoneRow = index.zones.find(z => z.number === zone)
  const ends = formatWhen(s.expiresAt)

  return (
    <div className="insp" data-inspector>
      <header className="insp-top">
        <span className="insp-mark" aria-hidden="true">M</span>
        <h1 className="insp-title">{S.inspTitle(s.projectName)}</h1>
        <span className="insp-pill">{S.inspLogged}</span>
        <span className="insp-who">{S.inspWho(s.inspector, ends)}</span>
      </header>

      <div className="insp-body">
        <nav className="insp-zones" aria-label={S.inspIndex}>
          <p className="insp-label">{S.inspIndex}</p>
          <ul>
            {index.zones.map(z => (
              <li key={z.number}>
                <button type="button" className="insp-zone" aria-current={z.number === zone ? 'true' : undefined}
                  onClick={() => { setZone(z.number); setSelected(null) }} data-zone={z.number}>
                  <span>{z.number} · {z.name}</span>
                  {z.filed > 0 && <span className="insp-count">{z.filed}</span>}
                </button>
              </li>
            ))}
          </ul>
          <p className="insp-foot">{S.inspNotShown}</p>
        </nav>

        <section className="insp-list" aria-label={zoneRow ? `${zoneRow.number} ${zoneRow.name}` : S.inspZones}>
          <p className="insp-crumb">{zoneRow ? `${zoneRow.number} ${zoneRow.name}` : ''}{site ? ` › ${S.inspSite(index.sites.find(x => x.id === site)?.label ?? site)}` : ''}</p>
          <div className="insp-filters">
            <label className="visually-hidden" htmlFor="insp-q">{S.inspSearch}</label>
            <input id="insp-q" className="input" type="search" placeholder={S.inspSearch} value={query} onChange={e => setQuery(e.target.value)} />
            {index.sites.length > 1 && (
              <select className="input insp-site" value={site} onChange={e => setSite(e.target.value)} aria-label={S.inspAllSites}>
                <option value="">{S.inspAllSites}</option>
                {index.sites.map(x => <option key={x.id} value={x.id}>{S.inspSite(x.label)}</option>)}
              </select>
            )}
          </div>
          {docs && docs.documents.length === 0 && <p className="muted">{S.inspNone}</p>}
          {docs && docs.documents.length > 0 && (
            <ul className="insp-docs">
              {docs.documents.map(d => (
                <li key={`${d.entity}:${d.id}`}>
                  <button type="button" className="insp-doc" aria-current={selected?.id === d.id ? 'true' : undefined} onClick={() => void open(d)} data-doc={d.id}>
                    <span className="insp-doc-main">
                      <span className="strong">{d.title}</span>
                      <span className="insp-doc-line">{documentLine(d)}</span>
                    </span>
                    <span className="insp-filed">{S.inspFiled}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {docs && <p className="insp-showing">{S.inspShowing(docs.documents.length, docs.total)}</p>}

          {requests.length > 0 && (
            <div className="insp-requests" data-requests>
              <p className="strong">{S.inspRequests}</p>
              <ul>
                {requests.map(r => (
                  <li key={r.id}>
                    {r.question}{' · '}
                    {r.answer
                      ? <span className="insp-answered">{S.inspAnsweredBy(r.answeredBy?.name ?? '', formatWhen(r.answeredAt ?? r.askedAt))}<span className="insp-answer">{r.answer}</span></span>
                      : <span className="insp-waiting">{S.inspWithTeam}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="insp-detail" aria-live="polite">
          {note && <Callout tone={note.tone} icon={note.tone === 'good' ? 'check' : 'alert'} live><p>{note.text}</p></Callout>}
          {!selected && <p className="muted insp-pick">{S.inspPick}</p>}
          {selected && (
            <>
              <h2 className="insp-doc-title">{selected.title}</h2>
              <div className="insp-tabs" role="tablist">
                <button type="button" role="tab" aria-selected={view === 'document'} onClick={() => setView('document')}>{S.inspDocument}</button>
                <button type="button" role="tab" aria-selected={view === 'trail'} onClick={() => void showTrail()} data-action="trail">{S.inspTrail}</button>
              </div>
              {view === 'document' ? <DocumentCard doc={selected} /> : <TrailTable trail={trail} />}
              <div className="insp-actions">
                {selected.file && <a className="button secondary" href={api.downloadUrl(selected.entity, selected.id)} download data-action="download">{S.inspDownload}</a>}
                <span className="insp-spacer" />
                {!asking && <button type="button" className="button primary" onClick={() => { setAsking(true); setNote(null) }} data-action="ask">{S.inspAsk}</button>}
              </div>
              {asking && (
                <AskForm
                  about={selected}
                  api={api}
                  onCancel={() => setAsking(false)}
                  onSent={async () => { setAsking(false); setNote({ tone: 'good', text: S.inspAsked }); await loadRequests() }}
                  onRefused={onRefused}
                />
              )}
            </>
          )}
        </section>
      </div>
    </div>
  )
}

function DocumentCard({ doc }: { doc: InspectorPageDocument }) {
  const sig = lastSignature(doc)
  return (
    <div className="insp-card" data-document={doc.id}>
      {doc.values.length > 0 && (
        <dl className="values insp-values">
          {doc.values.map(v => (
            <div key={v.field} className="value-row"><dt>{v.label}</dt><dd>{v.value}</dd></div>
          ))}
        </dl>
      )}
      {doc.file && (
        <p className="insp-file"><Icon name="doc" className="icon small" />{S.inspFile(doc.file.name, formatSize(doc.file.size))}<span className="insp-sha">{S.inspSha(doc.file.sha256)}</span></p>
      )}
      <div className="insp-signature" data-signature>
        {sig ? (
          <>
            <p><span className="strong">{S.inspSignedBy(sig.name)}</span>{` · ${sig.meaning} · ${formatWhen(sig.at)}`}</p>
            <p className="muted">{S.inspPart11(doc.version)}{sig.changedSince ? ` · ${S.inspChangedSince}` : ''}</p>
          </>
        ) : <p className="muted">{S.inspNoSignature}</p>}
      </div>
    </div>
  )
}

function TrailTable({ trail }: { trail: { entries: InspectorTrailEntry[]; chain: { ok: boolean } } | null }) {
  if (!trail) return <Loading />
  return (
    <div className="insp-card" data-trail>
      <table className="insp-trail">
        <thead><tr><th>{S.inspTrailWhen}</th><th>{S.inspTrailWho}</th><th>{S.inspTrailWhat}</th></tr></thead>
        <tbody>
          {trail.entries.map(e => {
            const who = trailWho(e)
            return (
              <tr key={e.id} data-action={e.action}>
                <td className="insp-when">{formatWhen(e.at, { year: false })}</td>
                <td>{who.ai && <span className="insp-ai">{S.inspAi}</span>}{who.text}</td>
                <td>{trailWhat(e)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="muted insp-chain" data-chain={trail.chain.ok ? 'ok' : 'broken'}>{trail.chain.ok ? S.inspChainOk : S.inspChainBroken}</p>
    </div>
  )
}

function AskForm({ about, api, onCancel, onSent, onRefused }: {
  about: InspectorPageDocument
  api: InspectorApi
  onCancel: () => void
  onSent: () => void | Promise<void>
  onRefused: (r: InspectorRefusal) => void
}) {
  const [text, setText] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const send = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.ask({ question: text.trim(), entity: about.entity, recordId: about.id })
      if (isInspectorRefusal(r)) { onRefused(r); return }
      if ('status' in r) { setError(r.message); return }
      await onSent()
    } catch {
      setError(S.inspAskFailed)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="card insp-ask" aria-labelledby="insp-ask-title" data-ask>
      <h3 id="insp-ask-title" className="card-title">{S.inspAskAbout(about.title)}</h3>
      <div className="field">
        <label className="label" htmlFor="insp-question"><span className="label-text">{S.inspQuestion}</span></label>
        <textarea id="insp-question" className="input" rows={4} value={text} onChange={e => setText(e.target.value)} disabled={busy} aria-describedby="insp-question-help" />
        <p className="help" id="insp-question-help">{S.inspQuestionHelp}</p>
        {error && <p className="error" role="alert"><Icon name="alert" className="icon small" />{error}</p>}
      </div>
      <div className="decide-buttons">
        <button type="button" className="button primary" onClick={() => void send()} disabled={busy || !text.trim()} data-action="send">{busy ? S.sending : S.inspSend}</button>
        <button type="button" className="button ghost" onClick={onCancel} disabled={busy}>{S.inspCancel}</button>
      </div>
    </section>
  )
}
