/**
 * "Give inspectors access" (Stage 5, docs/memwise/26-projects-and-pages.md §8; mocks EInspection,
 * EInspector): read-only links for an inspection, each with the inspectors' names and an end date.
 * The link shows filed documents, signatures and the audit trail only, never drafts, chats or AI
 * suggestions; every view and download is logged, and the inspectors' questions come here and to
 * the inbox. Presentational: `InspectorSetup` loads it and passes the calls.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CalendarPlus, CheckCircle2, Copy, Link2, MessageCircleQuestion, Plus, Send, ShieldOff } from 'lucide-react'
import type { MwInspectorLink, MwInspectorLinkCreated, MwInspectorLinkInput, MwInspectorQuestion } from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Badge } from '@/components/info/Info_Badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { absoluteDate, relativeTime } from '../format'
import { Cell, RegulatedPage, Section, Table } from './parts'
import { defaultInspectorEnd, endOfDayIso, inspectorNames, inspectorStatusLabel, parseInspectors } from './regulated-model'

export interface InspectorSetupActions {
  create?: (input: Omit<MwInspectorLinkInput, 'project'>) => Promise<MwInspectorLinkCreated>
  revoke?: (linkId: string) => Promise<unknown>
  extend?: (linkId: string, expiresAt: string) => Promise<unknown>
  answer?: (questionId: string, answer: string) => Promise<unknown>
  copy?: (text: string) => Promise<void>
  /** No public address yet: where to set one up. */
  openPublicAddress?: () => void
  openRecord?: (entity: string, recordId: string) => void
}

export interface InspectorSetupViewProps {
  projectName: string
  links: MwInspectorLink[]
  questions: MwInspectorQuestion[]
  actions?: InspectorSetupActions
  /** The new link's name the form offers ("MHRA inspection"). */
  suggestedName?: string
  /** Tests: the form is open from the start, or a link was just made. */
  initialForm?: boolean
  initialCreated?: MwInspectorLinkCreated
  now?: number
}

const STATUS_COLOR = { active: 'success', expired: 'muted', revoked: 'muted' } as const

export function InspectorSetupView({ projectName, links, questions, actions = {}, suggestedName, initialForm, initialCreated, now = Date.now() }: InspectorSetupViewProps) {
  const { t, i18n } = useTranslation()
  const [form, setForm] = React.useState(initialForm ?? links.length === 0)
  const [name, setName] = React.useState(suggestedName ?? '')
  const [people, setPeople] = React.useState('')
  const [end, setEnd] = React.useState(() => defaultInspectorEnd(now))
  const [created, setCreated] = React.useState<MwInspectorLinkCreated | null>(initialCreated ?? null)
  const [copied, setCopied] = React.useState(false)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const run = async (key: string, call: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    try { await call() } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(null) }
  }

  const inspectors = parseInspectors(people)
  const expiresAt = endOfDayIso(end)
  const endInPast = !!expiresAt && Date.parse(expiresAt) <= now
  const canCreate = !!actions.create && !!name.trim() && inspectors.length > 0 && !!expiresAt && !endInPast

  const create = () => run('create', async () => {
    const r = await actions.create!({ name: name.trim(), inspectors, expiresAt: expiresAt! })
    setCreated(r)
    setCopied(false)
    setForm(false)
    setPeople('')
  })

  const shared = created ? created.url ?? created.token : ''
  const open = questions.filter(q => !q.answeredAt)
  const answered = questions.filter(q => q.answeredAt)

  return (
    <RegulatedPage
      data-inspector-setup
      crumbs={[projectName, t('memwise.regulated.audit.crumbSettings'), t('memwise.regulated.inspectors.title')]}
      title={t('memwise.regulated.inspectors.title')}
      subtitle={t('memwise.regulated.inspectors.subtitle')}
      actions={actions.create && !form ? (
        <Button variant="secondary" size="sm" onClick={() => setForm(true)} data-action="new-link"><Plus />{t('memwise.regulated.inspectors.give')}</Button>
      ) : undefined}
    >
      {error && <Info_Alert variant="error" inline icon={<AlertTriangle />}><Info_Alert.Title data-error>{error}</Info_Alert.Title></Info_Alert>}

      {created && (
        <Info_Alert variant="success" icon={<Link2 />} data-created={created.link.id}>
          <Info_Alert.Title>{t('memwise.regulated.inspectors.created', { name: created.link.name })}</Info_Alert.Title>
          <Info_Alert.Description>
            <span className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-background/60 px-2 py-1 font-mono text-[12px]" data-link-url>{shared}</code>
              {actions.copy && (
                <Button size="sm" variant="secondary" onClick={() => void run('copy', async () => { await actions.copy!(shared); setCopied(true) })} data-action="copy">
                  <Copy />{copied ? t('memwise.regulated.inspectors.copied') : t('memwise.regulated.inspectors.copy')}
                </Button>
              )}
            </span>
            <span className="mt-1 block">{created.url ? t('memwise.regulated.inspectors.shownOnce') : t('memwise.regulated.inspectors.noAddress')}</span>
            {!created.url && actions.openPublicAddress && (
              <button type="button" className="mt-1 font-medium underline" onClick={actions.openPublicAddress}>{t('memwise.regulated.inspectors.setUpAddress')}</button>
            )}
          </Info_Alert.Description>
        </Info_Alert>
      )}

      {form && actions.create && (
        <Section title={t('memwise.regulated.inspectors.give')} data-link-form>
          <div className="space-y-3 rounded-lg border border-separator p-4">
            <label className="block space-y-1">
              <span className="text-label-sm text-secondary">{t('memwise.regulated.inspectors.name')}</span>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder={t('memwise.regulated.inspectors.namePlaceholder')} data-field="name" />
            </label>
            <label className="block space-y-1">
              <span className="text-label-sm text-secondary">{t('memwise.regulated.inspectors.people')}</span>
              <Textarea value={people} onChange={e => setPeople(e.target.value)} rows={3} placeholder={t('memwise.regulated.inspectors.peoplePlaceholder')} data-field="inspectors" />
            </label>
            <label className="block space-y-1">
              <span className="text-label-sm text-secondary">{t('memwise.regulated.inspectors.ends')}</span>
              <Input type="date" value={end} onChange={e => setEnd(e.target.value)} className="w-48" data-field="ends" />
              {endInPast && <span className="block text-label-sm text-destructive">{t('memwise.regulated.inspectors.endInPast')}</span>}
            </label>
            <p className="text-label-sm text-secondary">{t('memwise.regulated.inspectors.whatTheySee')}</p>
            <div className="flex justify-end gap-2">
              {links.length > 0 && <Button variant="ghost" onClick={() => setForm(false)}>{t('memwise.regulated.inspectors.cancel')}</Button>}
              <Button variant="primary" disabled={!canCreate || !!busy} onClick={() => void create()} data-action="create">
                <Link2 />{t('memwise.regulated.inspectors.create')}
              </Button>
            </div>
          </div>
        </Section>
      )}

      <Section title={t('memwise.regulated.inspectors.links')} data-links>
        {links.length === 0 ? (
          <p className="text-label text-secondary">{t('memwise.regulated.inspectors.noLinks')}</p>
        ) : (
          <Table head={[t('memwise.regulated.inspectors.inspection'), t('memwise.regulated.inspectors.ends'), t('memwise.regulated.inspectors.activity'), t('memwise.regulated.inspectors.statusHead'), '']}>
            {links.map(l => (
              <tr key={l.id} data-link={l.id} data-status={l.status}>
                <Cell>
                  <p className="font-medium text-foreground">{l.name}</p>
                  <p className="text-label-sm text-secondary">{inspectorNames(l)}</p>
                </Cell>
                <Cell className="whitespace-nowrap">{absoluteDate(l.expiresAt, i18n.language)}</Cell>
                <Cell className="whitespace-nowrap text-secondary" data-activity>
                  {t('memwise.regulated.inspectors.views', { count: l.views })}
                  {' · '}
                  {t('memwise.regulated.inspectors.downloads', { count: l.downloads })}
                  {l.lastOpenedAt && <span className="block text-label-sm text-tertiary">{t('memwise.regulated.inspectors.lastOpened', { time: relativeTime(l.lastOpenedAt, now, i18n.language) })}</span>}
                </Cell>
                <Cell><Info_Badge color={STATUS_COLOR[l.status]} dot>{inspectorStatusLabel(l.status, t)}</Info_Badge></Cell>
                <Cell className="whitespace-nowrap text-right">
                  {l.status !== 'revoked' && actions.extend && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!!busy}
                      onClick={() => void run(`extend:${l.id}`, () => actions.extend!(l.id, new Date(Math.max(Date.parse(l.expiresAt), now) + 7 * 86_400_000).toISOString()))}
                      data-action="extend"
                    >
                      <CalendarPlus />{t('memwise.regulated.inspectors.extend')}
                    </Button>
                  )}
                  {l.status === 'active' && actions.revoke && (
                    <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run(`revoke:${l.id}`, () => actions.revoke!(l.id))} data-action="revoke">
                      <ShieldOff />{t('memwise.regulated.inspectors.revoke')}
                    </Button>
                  )}
                </Cell>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title={t('memwise.regulated.inspectors.questions')} data-questions>
        {questions.length === 0 ? (
          <p className="text-label text-secondary">{t('memwise.regulated.inspectors.noQuestions')}</p>
        ) : (
          <div className="space-y-2">
            {[...open, ...answered].map(q => (
              <QuestionCard key={q.id} q={q} now={now} answer={actions.answer} openRecord={actions.openRecord} />
            ))}
          </div>
        )}
      </Section>
    </RegulatedPage>
  )
}

export function QuestionCard({ q, now = Date.now(), answer, openRecord }: {
  q: MwInspectorQuestion
  now?: number
  answer?: (questionId: string, answer: string) => Promise<unknown>
  openRecord?: (entity: string, recordId: string) => void
}) {
  const { t, i18n } = useTranslation()
  const [text, setText] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const send = async () => {
    setBusy(true)
    setError(null)
    try { await answer!(q.id, text.trim()); setText('') } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }
  return (
    <div className="space-y-2 rounded-lg border border-separator px-4 py-3" data-question={q.id} data-answered={q.answeredAt ? 'true' : 'false'}>
      <p className="flex items-start gap-2 text-label text-foreground">
        <MessageCircleQuestion className="mt-0.5 size-3.5 shrink-0 text-tertiary" />
        <span>{q.question}</span>
      </p>
      <p className="text-label-sm text-secondary">
        {[q.askedBy ?? t('memwise.regulated.audit.inspector'), q.linkName, relativeTime(q.askedAt, now, i18n.language)].join(' · ')}
        {q.record && (
          <>
            {' · '}
            {openRecord
              ? <button type="button" className="hover:underline" onClick={() => openRecord(q.record!.entity, q.record!.id)}>{q.record.title}</button>
              : q.record.title}
          </>
        )}
      </p>
      {q.answeredAt ? (
        <p className="flex items-start gap-2 text-label text-foreground" data-answer>
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
          <span>{q.answer}<span className="text-secondary">{` · ${q.answeredBy?.name ?? ''} · ${absoluteDate(q.answeredAt, i18n.language)}`}</span></span>
        </p>
      ) : answer ? (
        <div className="space-y-2">
          <Textarea value={text} onChange={e => setText(e.target.value)} rows={2} placeholder={t('memwise.regulated.inspectors.answerPlaceholder')} aria-label={t('memwise.regulated.inspectors.answer')} />
          {error && <p className="text-label-sm text-destructive">{error}</p>}
          <div className="flex items-center justify-between gap-2">
            <p className="text-label-sm text-tertiary">{t('memwise.regulated.inspectors.answerNote')}</p>
            <Button size="sm" variant="primary" disabled={busy || !text.trim()} onClick={() => void send()} data-action="answer"><Send />{t('memwise.regulated.inspectors.answer')}</Button>
          </div>
        </div>
      ) : (
        <p className="text-label-sm text-info">{t('memwise.regulated.inspectors.waitingAnswer')}</p>
      )}
    </div>
  )
}
