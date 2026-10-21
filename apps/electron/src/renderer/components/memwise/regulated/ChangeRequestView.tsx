/**
 * A change request of a regulated playbook (Stage 5, docs/memwise/26-projects-and-pages.md §8; mock
 * EChange): what changes (the steps with strikeouts), the reason, the validation runs on past cases
 * ("41 of 42 match QC", then "42 of 42"), and the sign-offs: the person who raised it signs it to
 * QA, and QA's signature publishes it as the playbook's next version. Presentational: the screen
 * (`ChangeRequestScreen`) loads it and passes the actions.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, MessagesSquare, PenLine, PlayCircle } from 'lucide-react'
import type { MwChangeRequest, MwChangeSignResult, MwChangeValidation } from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Badge } from '@/components/info/Info_Badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { absoluteDate } from '../format'
import { SignDialog } from '../records/SignDialog'
import { Cell, DiffText, RegulatedPage, Section, Table } from './parts'
import {
  changeStatusColor, changeStatusLabel, signResultForForm, signoffRoleLabel, validationResult, validationRunLabel, whoLabel,
} from './regulated-model'

export interface ChangeRequestActions {
  saveReason?: (reason: string) => Promise<unknown>
  validate?: () => Promise<MwChangeValidation>
  sign?: (password: string) => Promise<MwChangeSignResult>
  withdraw?: () => Promise<unknown>
  /** The chat that edits the request (the shell's left column). */
  openChat?: () => void
  openPlaybook?: (workflowId: string) => void
  openCase?: (caseId: string) => void
}

export interface ChangeRequestViewProps {
  cr: MwChangeRequest
  actions?: ChangeRequestActions
  /** Who signs from this screen (the signing dialog names them). */
  signer?: { name: string; role?: string }
  /** Tests: the signing dialog is open from the start. */
  initialSigning?: boolean
}

export function ChangeRequestView({ cr, actions = {}, signer, initialSigning = false }: ChangeRequestViewProps) {
  const { t, i18n } = useTranslation()
  const [reason, setReason] = React.useState(cr.reason)
  React.useEffect(() => setReason(cr.reason), [cr.reason])
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [signing, setSigning] = React.useState(initialSigning)
  const last = cr.validations.at(-1)
  const editing = cr.can.edit && !!actions.saveReason
  const dirty = reason.trim() !== cr.reason.trim()
  const raiser = cr.signoffs.find(s => s.role === 'raiser')
  const qa = cr.signoffs.find(s => s.role === 'qa')
  const signoff = cr.can.approve ? qa : raiser

  const run = async (key: string, call: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    try { await call() } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(null) }
  }

  const closed = cr.status === 'published' || cr.status === 'withdrawn'
  const footer = closed ? (
    <p className="flex-1 text-label text-secondary" data-closed={cr.status}>
      {cr.status === 'published'
        ? t('memwise.regulated.change.publishedNote', { version: cr.toVersion ?? '', date: absoluteDate(cr.closedAt, i18n.language), name: cr.closedBy?.name ?? '' })
        : t('memwise.regulated.change.withdrawnNote', { date: absoluteDate(cr.closedAt, i18n.language), name: cr.closedBy?.name ?? '' })}
    </p>
  ) : (
    <>
      <p className="flex-1 text-label text-secondary" data-goes-live>
        {t('memwise.regulated.change.goesLive', { next: cr.nextVersion ?? '', live: cr.liveVersion ?? '' })}
        {cr.openCasesOnLive > 0 && ` ${t('memwise.regulated.change.openCases', { count: cr.openCasesOnLive, live: cr.liveVersion ?? '' })}`}
      </p>
      {cr.can.withdraw && actions.withdraw && (
        <Button variant="secondary" disabled={!!busy} onClick={() => void run('withdraw', actions.withdraw!)} data-action="withdraw">
          {t('memwise.regulated.change.withdraw')}
        </Button>
      )}
      {(cr.can.send || cr.can.approve) && actions.sign && (
        <Button variant="primary" disabled={!!busy || dirty} onClick={() => setSigning(true)} data-action={cr.can.approve ? 'approve' : 'send'}>
          <PenLine />
          {cr.can.approve ? t('memwise.regulated.change.approve') : t('memwise.regulated.change.send')}
        </Button>
      )}
    </>
  )

  return (
    <RegulatedPage
      data-change-request={cr.label}
      crumbs={[t('memwise.regulated.change.crumbPlaybooks'), cr.playbookTitle, t('memwise.regulated.change.title', { label: cr.label })]}
      title={t('memwise.regulated.change.title', { label: cr.label })}
      badge={<Info_Badge color={changeStatusColor(cr.status)} dot data-status={cr.status}>{changeStatusLabel(cr.status, t)}</Info_Badge>}
      subtitle={[cr.title, cr.playbookTitle, cr.regulated ? t('memwise.regulated.change.regulatedPart11') : null, cr.sessionId ? t('memwise.regulated.change.fromChat') : null].filter(Boolean).join(' · ')}
      actions={actions.openChat && !closed ? (
        <Button variant="ghost" size="sm" onClick={actions.openChat} data-action="chat"><MessagesSquare />{t('memwise.regulated.change.chat')}</Button>
      ) : undefined}
      footer={footer}
    >
      {error && (
        <Info_Alert variant="error" inline icon={<AlertTriangle />}><Info_Alert.Title data-error>{error}</Info_Alert.Title></Info_Alert>
      )}

      <Section title={t('memwise.regulated.change.whatChanges')} data-what-changes>
        {cr.steps.length === 0 ? (
          <p className="text-label text-secondary">{closed ? t('memwise.regulated.change.stepsClosed') : t('memwise.regulated.change.noSteps')}</p>
        ) : (
          <Table head={['', t('memwise.regulated.change.step'), t('memwise.regulated.change.who.title')]}>
            {cr.steps.map(s => (
              <tr key={s.stepId} data-step={s.stepId} data-change={s.change} className={cn(s.change !== 'same' && 'bg-accent/5')}>
                <Cell className="w-8 text-secondary">{s.n}</Cell>
                <Cell>
                  <div className={cn(s.change === 'removed' && 'line-through text-tertiary')}><DiffText segments={s.title} /></div>
                  {s.rules.some(r => r.kind !== 'same') && (
                    <ul className="mt-1 space-y-0.5 text-label-sm" data-rules>
                      {s.rules.filter(r => r.kind !== 'same').map((r, i) => (
                        <li key={i} data-rule={r.kind}>
                          {r.kind === 'added'
                            ? <ins className="text-accent underline decoration-accent/50 underline-offset-2">{t('memwise.regulated.change.ruleAdded', { rule: r.text })}</ins>
                            : <del className="text-tertiary line-through">{t('memwise.regulated.change.ruleRemoved', { rule: r.text })}</del>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {s.change === 'changed' && (s.instructionsChanged || s.outcomesChanged) && !s.rules.some(r => r.kind !== 'same') && (
                    <p className="mt-1 text-label-sm text-secondary">{s.outcomesChanged ? t('memwise.regulated.change.outcomesChanged') : t('memwise.regulated.change.instructionsChanged')}</p>
                  )}
                </Cell>
                <Cell className="whitespace-nowrap">
                  {s.whoBefore && whoLabel(s.whoBefore, t) !== whoLabel(s.who, t)
                    ? <><del className="text-tertiary line-through">{whoLabel(s.whoBefore, t)}</del>{' '}<ins className="text-accent">{whoLabel(s.who, t)}</ins></>
                    : whoLabel(s.who, t)}
                </Cell>
              </tr>
            ))}
          </Table>
        )}
        {cr.files.length > 0 && (
          <details className="text-label-sm" data-files>
            <summary className="cursor-pointer text-secondary">{t('memwise.regulated.change.files', { count: cr.files.length })}</summary>
            <div className="mt-2 space-y-3">
              {cr.files.map(f => (
                <div key={f.path} className="rounded-md border border-separator" data-file={f.path}>
                  <p className="border-b border-separator px-3 py-1.5 font-mono text-secondary">{f.path}</p>
                  <pre className="overflow-x-auto px-3 py-2 font-mono text-[12px] leading-5">
                    {f.lines.map((l, i) => (
                      <div key={i} className={cn(l.kind === 'added' && 'bg-success/10 text-success', l.kind === 'removed' && 'bg-destructive/10 text-destructive')}>
                        {l.kind === 'added' ? '+ ' : l.kind === 'removed' ? '- ' : '  '}{l.text}
                      </div>
                    ))}
                  </pre>
                </div>
              ))}
            </div>
          </details>
        )}
        {cr.checks.errors > 0 && (
          <Info_Alert variant="error" inline icon={<AlertTriangle />}>
            <Info_Alert.Title>{t('memwise.regulated.change.checkErrors', { count: cr.checks.errors })}</Info_Alert.Title>
            <Info_Alert.Description>{cr.checks.messages.join(' · ')}</Info_Alert.Description>
          </Info_Alert>
        )}
      </Section>

      <Section title={t('memwise.regulated.change.reason')} data-reason>
        {editing ? (
          <div className="space-y-2">
            <Textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} placeholder={t('memwise.regulated.change.reasonPlaceholder')} aria-label={t('memwise.regulated.change.reason')} />
            {dirty && (
              <div className="flex justify-end">
                <Button size="sm" variant="secondary" disabled={!!busy || !reason.trim()} onClick={() => void run('reason', () => actions.saveReason!(reason.trim()))} data-action="save-reason">
                  {t('memwise.regulated.change.saveReason')}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <p className="text-label text-foreground">{cr.reason || <span className="text-secondary">{t('memwise.regulated.change.noReason')}</span>}</p>
        )}
      </Section>

      <Section
        title={t('memwise.regulated.change.validation.title')}
        data-validation
        actions={cr.can.validate && actions.validate ? (
          <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void run('validate', actions.validate!)} data-action="validate">
            <PlayCircle />{busy === 'validate' ? t('memwise.regulated.change.validation.running') : last ? t('memwise.regulated.change.validation.again') : t('memwise.regulated.change.validation.run')}
          </Button>
        ) : undefined}
      >
        {cr.validations.length === 0 ? (
          <p className="text-label text-secondary">{t('memwise.regulated.change.validation.none')}</p>
        ) : (
          <Table head={[
            cr.validationSet.label || last?.setLabel
              ? t('memwise.regulated.change.validation.onSet', { set: cr.validationSet.label || last?.setLabel })
              : t('memwise.regulated.change.validation.onPast'),
            t('memwise.regulated.change.validation.result'),
          ]}>
            {cr.validations.map((v, i) => (
              <tr key={v.id} data-validation-run={i + 1} data-status={v.status}>
                <Cell>
                  {validationRunLabel(i + 1, t)}
                  <span className="text-secondary">{` · ${v.byName ?? ''} · ${absoluteDate(v.at, i18n.language)}`}</span>
                  {!v.current && <span className="ml-1.5 text-label-sm text-tertiary">{t('memwise.regulated.change.validation.earlierDraft')}</span>}
                </Cell>
                <Cell className={cn('whitespace-nowrap', v.status === 'passed' ? 'text-success' : 'text-info')}>{validationResult(v, cr, t)}</Cell>
              </tr>
            ))}
          </Table>
        )}
        {last && last.results.some(r => !r.matches) && (
          <ul className="space-y-1 text-label" data-mismatches>
            {last.results.filter(r => !r.matches).map(r => (
              <li key={r.caseId} className="flex gap-2" data-mismatch={r.caseId}>
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-info" />
                <span>
                  {actions.openCase
                    ? <button type="button" className="font-medium hover:underline" onClick={() => actions.openCase!(r.caseId)}>{r.title}</button>
                    : <span className="font-medium">{r.title}</span>}
                  {': '}
                  {r.ai === 'error'
                    ? t('memwise.regulated.change.validation.caseError', { error: r.error ?? '' })
                    : r.ai === 'pass'
                      ? t('memwise.regulated.change.validation.aiPassedPersonNot', { outcome: r.decided.outcome.replace(/_/g, ' '), by: r.decided.by ?? '' })
                      : t('memwise.regulated.change.validation.aiFailedPersonAccepted', { rules: (r.failedRules ?? []).map(f => f.rule).join('; '), by: r.decided.by ?? '' })}
                  {r.decided.comment && <span className="text-secondary">{` “${r.decided.comment}”`}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
        {last?.status === 'passed' && last.current && cr.status === 'open' && (
          <p className="flex items-center gap-1.5 text-label text-success" data-validated><CheckCircle2 className="size-3.5" />{t('memwise.regulated.change.validation.ready')}</p>
        )}
      </Section>

      <Section title={t('memwise.regulated.change.signoff.title')} data-signoffs>
        <Table head={[t('memwise.regulated.change.signoff.title'), t('memwise.regulated.change.signoff.status')]}>
          {cr.signoffs.map(s => (
            <tr key={s.role} data-signoff={s.role} data-status={s.status}>
              <Cell>
                {[s.person?.name, signoffRoleLabel(s, t), s.role === 'raiser' ? t('memwise.regulated.change.signoff.raised') : null].filter(Boolean).join(' · ')}
                <p className="text-label-sm text-tertiary">{s.meaning}</p>
              </Cell>
              <Cell className={cn('whitespace-nowrap', s.status === 'signed' ? 'text-success' : s.status === 'waiting' ? 'text-info' : 'text-secondary')}>
                {s.status === 'signed'
                  ? t('memwise.regulated.change.signoff.signed', { date: absoluteDate(s.signedAt, i18n.language) })
                  : s.status === 'waiting' ? t('memwise.regulated.change.signoff.waiting') : t('memwise.regulated.change.signoff.notYet')}
              </Cell>
            </tr>
          ))}
        </Table>
      </Section>

      {actions.sign && signoff && (
        <SignDialog
          open={signing}
          onOpenChange={setSigning}
          name={signer?.name ?? ''}
          {...(signer?.role ? { role: signer.role } : {})}
          meaning={signoff.meaning}
          action={cr.can.approve ? t('memwise.regulated.change.approve') : t('memwise.regulated.change.send')}
          onSign={async password => {
            const r = await actions.sign!(password)
            if (r.applied) setSigning(false)
            return signResultForForm(r)
          }}
        />
      )}
    </RegulatedPage>
  )
}
