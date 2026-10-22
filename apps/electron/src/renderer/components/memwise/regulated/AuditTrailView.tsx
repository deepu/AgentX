/**
 * A project's audit trail (Stage 5, docs/memwise/26-projects-and-pages.md §8; mock EAudit): record
 * versions, signatures and step records in one table, people and AI alike. An AI entry names the
 * model and quotes the sentence it relied on. The trail is append-only and each entry is chained to
 * the one before; "Export for inspectors" downloads it signed, "Check the chain" verifies it.
 * Presentational: `AuditTrailScreen` loads it and passes the calls.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, Download, ShieldCheck, X } from 'lucide-react'
import type { MwAuditEntry, MwAuditLog, MwAuditVerifyResult } from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Cell, RegulatedPage, Table } from './parts'
import { auditWhat, auditWho, trailWhen, verifyMessage } from './regulated-model'

export interface AuditTrailViewProps {
  projectName: string
  log: MwAuditLog
  /** The trail is of one record: its chip, with a way back to the whole project. */
  scope?: { label: string; onClear?: () => void }
  /** Only people's and the AI's entries (not the system's or the inspectors'). */
  peopleAndAi: boolean
  onPeopleAndAi?: (on: boolean) => void
  onExport?: () => Promise<unknown>
  onVerify?: () => Promise<MwAuditVerifyResult>
  /** Tests: a verify result to show from the start. */
  initialVerify?: MwAuditVerifyResult
  openRecord?: (entity: string, recordId: string) => void
}

const STRONG = new Set(['signature.signed', 'change.published'])

export function AuditTrailView({ projectName, log, scope, peopleAndAi, onPeopleAndAi, onExport, onVerify, initialVerify, openRecord }: AuditTrailViewProps) {
  const { t, i18n } = useTranslation()
  const [busy, setBusy] = React.useState<'export' | 'verify' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [verified, setVerified] = React.useState<MwAuditVerifyResult | null>(initialVerify ?? null)

  const run = async (key: 'export' | 'verify', call: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    try { await call() } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(null) }
  }

  const row = (e: MwAuditEntry) => {
    const who = auditWho(e, t)
    const record = !scope && e.entity && e.recordId ? { entity: e.entity, id: e.recordId, title: e.recordTitle ?? e.recordId } : null
    return (
      <tr key={e.id} data-entry={e.seq} data-actor={e.actorKind} data-action-kind={e.action}>
        <Cell className="whitespace-nowrap text-secondary" title={e.at}>{trailWhen(e.at, i18n.language)}</Cell>
        <Cell className="whitespace-nowrap">
          {who.ai && <span className="mr-1.5 rounded bg-accent/10 px-1 py-px text-[10px] font-semibold text-accent" data-ai>{t('memwise.regulated.audit.aiBadge')}</span>}
          {who.text}
        </Cell>
        <Cell>
          <span className={cn(STRONG.has(e.action) && 'font-medium text-foreground')}>{auditWhat(e, t)}</span>
          {record && (
            <span className="text-secondary">
              {' · '}
              {openRecord
                ? <button type="button" className="text-left hover:underline" onClick={() => openRecord(record.entity, record.id)}>{record.title}</button>
                : record.title}
            </span>
          )}
        </Cell>
      </tr>
    )
  }

  return (
    <RegulatedPage
      data-audit-trail
      crumbs={[projectName, t('memwise.regulated.audit.crumbSettings'), t('memwise.regulated.audit.title')]}
      title={t('memwise.regulated.audit.title')}
      subtitle={t('memwise.regulated.audit.subtitle', { project: projectName })}
      actions={(
        <>
          {onVerify && (
            <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void run('verify', async () => setVerified(await onVerify()))} data-action="verify">
              <ShieldCheck />{t('memwise.regulated.audit.verify.action')}
            </Button>
          )}
          {onExport && (
            <Button variant="secondary" size="sm" disabled={!!busy || log.entries.length === 0} onClick={() => void run('export', onExport)} data-action="export">
              <Download />{t('memwise.regulated.audit.export')}
            </Button>
          )}
        </>
      )}
    >
      <div className="flex flex-wrap items-center gap-2" data-filters>
        {scope && (
          <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2.5 py-1 text-label-sm text-accent" data-scope>
            {scope.label}
            {scope.onClear && (
              <button type="button" aria-label={t('memwise.regulated.audit.clearScope')} onClick={scope.onClear} className="rounded-full hover:bg-accent/15"><X className="size-3" /></button>
            )}
          </span>
        )}
        <button
          type="button"
          aria-pressed={peopleAndAi}
          disabled={!onPeopleAndAi}
          onClick={() => onPeopleAndAi?.(!peopleAndAi)}
          className={cn('rounded-full px-2.5 py-1 text-label-sm', peopleAndAi ? 'bg-foreground/10 text-foreground' : 'bg-fill-hover text-secondary')}
          data-filter="people-and-ai"
        >
          {t('memwise.regulated.audit.peopleAndAi')}
        </button>
      </div>

      {error && <Info_Alert variant="error" inline icon={<AlertTriangle />}><Info_Alert.Title data-error>{error}</Info_Alert.Title></Info_Alert>}
      {!log.chain.ok && (
        <Info_Alert variant="error" inline icon={<AlertTriangle />} data-chain-broken>
          <Info_Alert.Title>{t('memwise.regulated.audit.chainBroken')}</Info_Alert.Title>
          {log.chain.message && <Info_Alert.Description>{log.chain.message}</Info_Alert.Description>}
        </Info_Alert>
      )}
      {verified && (
        <Info_Alert variant={verified.ok ? 'success' : 'error'} inline icon={verified.ok ? <CheckCircle2 /> : <AlertTriangle />} data-verify={verified.ok ? 'ok' : 'failed'}>
          <Info_Alert.Title>{verifyMessage(verified, t)}</Info_Alert.Title>
        </Info_Alert>
      )}

      {log.entries.length === 0 ? (
        <p className="text-label text-secondary" data-empty>{t('memwise.regulated.audit.empty')}</p>
      ) : (
        <Table head={[t('memwise.regulated.audit.when'), t('memwise.regulated.audit.who'), t('memwise.regulated.audit.what')]}>
          {log.entries.map(row)}
        </Table>
      )}
      <p className="text-label-sm text-secondary">{t('memwise.regulated.audit.footnote')}</p>
    </RegulatedPage>
  )
}
