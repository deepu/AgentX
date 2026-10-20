/**
 * The "Checks" section of a draft: problems found in the files (shown as you edit), then the last
 * full check: example cases, recent cases replayed on the draft, and what the change does to the
 * cases already running.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, CircleSlash, Clock, XCircle } from 'lucide-react'
import type { MwDiagnostic, MwDraft, MwDraftReport, MwExampleOutcome, MwPastCaseOutcome, MwPlaybook } from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Badge } from '@/components/info/Info_Badge'
import { Info_Section } from '@/components/info/Info_Section'
import { Button } from '@/components/ui/button'
import { Spinner } from '@memwise/ui'
import { cn } from '@/lib/utils'
import { absoluteTime, humanize, relativeTime } from '../format'
import { EffectBadge } from '../playbook/Tags'
import { stepName } from './draft-model'

export function DiagnosticList({ diagnostics }: { diagnostics: MwDiagnostic[] }) {
  return (
    <ul className="divide-y divide-separator" data-diagnostics>
      {diagnostics.map((d, i) => {
        const Icon = d.severity === 'error' ? XCircle : AlertTriangle
        return (
          <li key={`${d.code}-${i}`} className="flex items-start gap-2.5 px-4 py-2 text-label" data-severity={d.severity}>
            <Icon className={cn('mt-0.5 size-3.5 shrink-0', d.severity === 'error' ? 'text-destructive' : 'text-info')} aria-hidden />
            <span className="min-w-0 text-foreground">
              {d.message}
              {d.file && (
                <span className="ml-1.5 font-mono text-[11px] text-tertiary">
                  {d.file}
                  {d.line !== undefined ? `:${d.line}` : ''}
                </span>
              )}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

const EXAMPLE_BADGE: Record<MwExampleOutcome['status'], { color: 'success' | 'destructive' | 'default'; icon: React.ReactNode }> = {
  pass: { color: 'success', icon: <CheckCircle2 /> },
  fail: { color: 'destructive', icon: <XCircle /> },
  skip: { color: 'default', icon: <CircleSlash /> },
}

const PAST_BADGE: Record<MwPastCaseOutcome['status'], { color: 'success' | 'warning' | 'destructive' | 'default' }> = {
  same: { color: 'success' },
  different: { color: 'warning' },
  skip: { color: 'default' },
  error: { color: 'destructive' },
}

export function ExampleRow({ example }: { example: MwExampleOutcome }) {
  const { t } = useTranslation()
  const badge = EXAMPLE_BADGE[example.status]
  return (
    <li className="px-4 py-2.5" data-example={example.name} data-example-status={example.status}>
      <div className="flex flex-wrap items-center gap-2 text-label">
        <span className="font-medium text-foreground">{humanize(example.name)}</span>
        <Info_Badge color={badge.color} icon={badge.icon}>{t(`memwise.draft.checks.example.${example.status}`)}</Info_Badge>
      </div>
      {example.reason && <p className="mt-0.5 text-label-sm text-secondary">{t('memwise.draft.checks.skippedBecause', { reason: example.reason })}</p>}
      {example.differences.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-label-sm text-secondary">
          {example.differences.map((d, i) => <li key={i}>{d}</li>)}
        </ul>
      )}
    </li>
  )
}

function PathLine({ label, path, playbook, live }: { label: string; path: string[]; playbook?: MwPlaybook | null; live?: MwPlaybook | null }) {
  const { t } = useTranslation()
  return (
    <div className="flex gap-2 text-label-sm">
      <span className="w-24 shrink-0 text-tertiary">{label}</span>
      <span className="min-w-0 text-secondary">{path.map(s => stepName(s, t, playbook, live)).join(' → ')}</span>
    </div>
  )
}

function PastCaseRow({ outcome, playbook, live, onOpenCase }: { outcome: MwPastCaseOutcome; playbook?: MwPlaybook | null; live?: MwPlaybook | null; onOpenCase?: (caseId: string) => void }) {
  const { t } = useTranslation()
  return (
    <li className="space-y-1 px-4 py-2.5" data-past-case={outcome.caseId} data-past-status={outcome.status}>
      <div className="flex flex-wrap items-center gap-2 text-label">
        {onOpenCase ? (
          <button type="button" className="font-medium text-foreground hover:underline" onClick={() => onOpenCase(outcome.caseId)}>{outcome.title}</button>
        ) : (
          <span className="font-medium text-foreground">{outcome.title}</span>
        )}
        <Info_Badge color={PAST_BADGE[outcome.status].color}>{t(`memwise.draft.checks.past.${outcome.status}`)}</Info_Badge>
      </div>
      {outcome.differences.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-label-sm text-secondary">
          {outcome.differences.map((d, i) => <li key={i}>{d}</li>)}
        </ul>
      )}
      {outcome.livePath.length > 0 && <PathLine label={t('memwise.draft.checks.past.livePath')} path={outcome.livePath} playbook={playbook} live={live} />}
      {outcome.draftPath.length > 0 && <PathLine label={t('memwise.draft.checks.past.draftPath')} path={outcome.draftPath} playbook={playbook} live={live} />}
    </li>
  )
}

function ImpactView({ report, playbook, live }: { report: MwDraftReport; playbook?: MwPlaybook | null; live?: MwPlaybook | null }) {
  const { t } = useTranslation()
  const impact = report.impact
  if (!impact) return null
  const byState = Object.entries(impact.openCases.byState).filter(([, n]) => n > 0)
  return (
    <Info_Section title={t('memwise.draft.checks.impact.title')} description={t('memwise.draft.checks.impact.description')}>
      <div className="space-y-3 px-4 py-3" data-impact>
        {impact.summary.length > 0 && (
          <ul className="space-y-1 text-label text-foreground">
            {impact.summary.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        )}
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-label">
          <dt className="text-tertiary">{t('memwise.draft.checks.impact.version')}</dt>
          <dd className="text-secondary">
            {impact.liveVersion !== undefined
              ? t('memwise.draft.checks.impact.versionChange', { from: impact.liveVersion, to: impact.newVersion })
              : t('memwise.draft.checks.impact.versionNew', { to: impact.newVersion })}
          </dd>
          <dt className="text-tertiary">{t('memwise.draft.checks.impact.openCases')}</dt>
          <dd className="text-secondary">
            {t('memwise.draft.checks.impact.openCasesCount', { count: impact.openCases.total })}
            {byState.length > 0 && (
              <span className="text-tertiary"> · {byState.map(([s, n]) => `${stepName(s, t, playbook, live)}: ${n}`).join(', ')}</span>
            )}
          </dd>
          {impact.removedStatesWithCases.length > 0 && (
            <>
              <dt className="text-tertiary">{t('memwise.draft.checks.impact.removedWithCases')}</dt>
              <dd className="text-secondary">
                {impact.removedStatesWithCases.map(r => t('memwise.draft.checks.impact.stepCases', { step: stepName(r.state, t, playbook, live), count: r.cases })).join(', ')}
              </dd>
            </>
          )}
          {impact.newTools.length > 0 && (
            <>
              <dt className="text-tertiary">{t('memwise.draft.checks.impact.newTools')}</dt>
              <dd className="flex flex-col gap-1">
                {impact.newTools.map(tool => (
                  <span key={tool.name} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[12px] text-foreground">{tool.name}</span>
                    {tool.effect && <EffectBadge effect={tool.effect} />}
                    {!tool.bound && <Info_Badge color="destructive">{t('memwise.draft.checks.impact.notBound')}</Info_Badge>}
                  </span>
                ))}
              </dd>
            </>
          )}
          {impact.newRequiredTools.length > 0 && (
            <>
              <dt className="text-tertiary">{t('memwise.draft.checks.impact.newRequired')}</dt>
              <dd className="text-secondary">
                {impact.newRequiredTools.map(r => t('memwise.draft.checks.impact.mustUse', { step: stepName(r.step, t, playbook, live), tool: r.tool })).join('; ')}
              </dd>
            </>
          )}
          {impact.otherPlaybooks.length > 0 && (
            <>
              <dt className="text-tertiary">{t('memwise.draft.checks.impact.otherPlaybooks')}</dt>
              <dd className="text-secondary">{impact.otherPlaybooks.map(p => `${humanize(p.id)} (${p.uses.join(', ')})`).join('; ')}</dd>
            </>
          )}
        </dl>
      </div>
    </Info_Section>
  )
}

export interface ChecksViewProps {
  draft: MwDraft
  live?: MwPlaybook | null
  /** Set while a check runs. */
  checking?: { startedAt: number } | null
  onCheck?: () => void
  onOpenCase?: (caseId: string) => void
  now?: number
}

export function CheckProgress({ startedAt, now }: { startedAt: number; now?: number }) {
  const { t } = useTranslation()
  const [tick, setTick] = React.useState(() => now ?? Date.now())
  React.useEffect(() => {
    if (now !== undefined) return
    const timer = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [now])
  const seconds = Math.max(0, Math.round(((now ?? tick) - startedAt) / 1000))
  return (
    <Info_Alert variant="info" icon={<Spinner className="text-[14px]" />} data-checking>
      <Info_Alert.Title>{t('memwise.draft.checks.running')}</Info_Alert.Title>
      <Info_Alert.Description>{t('memwise.draft.checks.runningDescription', { seconds })}</Info_Alert.Description>
    </Info_Alert>
  )
}

export function ChecksView({ draft, live, checking, onCheck, onOpenCase, now }: ChecksViewProps) {
  const { t, i18n } = useTranslation()
  const report = draft.report
  const current = draft.diagnostics
  return (
    <div className="space-y-6" data-checks>
      {checking && <CheckProgress startedAt={checking.startedAt} now={now} />}

      <Info_Section title={t('memwise.draft.checks.now')} description={t('memwise.draft.checks.nowDescription')} count={current.length}>
        {current.length === 0 ? (
          <p className="flex items-center gap-2 px-4 py-3 text-label text-secondary">
            <CheckCircle2 className="size-3.5 text-success" aria-hidden />
            {t('memwise.draft.checks.noProblems')}
          </p>
        ) : (
          <DiagnosticList diagnostics={current} />
        )}
      </Info_Section>

      {!report ? (
        <Info_Alert variant="warning" icon={<Clock />} data-not-checked>
          <Info_Alert.Title>{t('memwise.draft.checks.notChecked')}</Info_Alert.Title>
          <Info_Alert.Description>{t('memwise.draft.checks.notCheckedDescription')}</Info_Alert.Description>
          {onCheck && !checking && (
            <Button variant="secondary" size="sm" className="mt-2" onClick={onCheck}>{t('memwise.draft.check')}</Button>
          )}
        </Info_Alert>
      ) : (
        <>
          <Info_Alert
            variant={report.outcome === 'passed' ? 'success' : 'error'}
            icon={report.outcome === 'passed' ? <CheckCircle2 /> : <XCircle />}
            data-report-outcome={report.outcome}
          >
            <Info_Alert.Title>{t(report.outcome === 'passed' ? 'memwise.draft.checks.passed' : 'memwise.draft.checks.failed')}</Info_Alert.Title>
            <Info_Alert.Description>
              {report.summary}
              {' '}
              <span className="text-tertiary" title={absoluteTime(report.at, i18n.language)}>
                {t('memwise.draft.checks.checkedAt', { time: relativeTime(report.at, now, i18n.language) })}
              </span>
            </Info_Alert.Description>
          </Info_Alert>
          {draft.reportStale && (
            <Info_Alert variant="warning" icon={<AlertTriangle />} data-report-stale>
              <Info_Alert.Title>{t('memwise.draft.checks.stale')}</Info_Alert.Title>
              <Info_Alert.Description>{t('memwise.draft.checks.staleDescription')}</Info_Alert.Description>
              {onCheck && !checking && (
                <Button variant="secondary" size="sm" className="mt-2" onClick={onCheck}>{t('memwise.draft.checkAgain')}</Button>
              )}
            </Info_Alert>
          )}
          {report.diagnostics.length > 0 && (
            <Info_Section title={t('memwise.draft.checks.found')} count={report.diagnostics.length}>
              <DiagnosticList diagnostics={report.diagnostics} />
            </Info_Section>
          )}
          <Info_Section title={t('memwise.draft.checks.examples')} description={t('memwise.draft.checks.examplesDescription')} count={report.examples.length}>
            {report.examples.length === 0 ? (
              <p className="px-4 py-3 text-label text-tertiary">{t('memwise.draft.checks.noExamples')}</p>
            ) : (
              <ul className="divide-y divide-separator">{report.examples.map(e => <ExampleRow key={e.name} example={e} />)}</ul>
            )}
          </Info_Section>
          <Info_Section title={t('memwise.draft.checks.pastCases')} description={t('memwise.draft.checks.pastCasesDescription')} count={report.pastCases.length}>
            {report.pastCases.length === 0 ? (
              <p className="px-4 py-3 text-label text-tertiary">{t('memwise.draft.checks.noPastCases')}</p>
            ) : (
              <ul className="divide-y divide-separator">
                {report.pastCases.map(p => <PastCaseRow key={p.caseId} outcome={p} playbook={draft.playbook} live={live} onOpenCase={onOpenCase} />)}
              </ul>
            )}
          </Info_Section>
          <ImpactView report={report} playbook={draft.playbook} live={live} />
        </>
      )}
    </div>
  )
}
