/**
 * A playbook's page in the project shell (doc 26 §5, mock `Playbook`): what starts it, its steps
 * and who does each, this week's runs, and the change its chat drafted: what changed (highlighted
 * in the steps), a test run on one record, Discard and Send for review (the Phase 3 review path).
 * Where the playbook came from closes the page.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { Check, ChevronDown, ChevronRight, CircleAlert, FlaskConical, Mail } from 'lucide-react'
import type { MwDraft, MwDraftTestRun, MwPlaybook, MwRole, MwRunTrace } from '@memwise/shared/protocol'
import { cn } from '@/lib/utils'
import { navigate, routes } from '@/lib/navigate'
import { memwiseCasesAtom, memwiseDomainsAtom, memwiseInboxAtom, memwiseRolesAtom, memwiseStatusAtom, memwiseWorkspaceIdAtom } from '@/atoms/memwise'
import { getMemwiseApi, useMemwiseCase, useMemwiseDraft, useMemwiseDrafts, useMemwisePlaybook, useMemwiseVersions } from '@/hooks/useMemwise'
import { useMemwiseRecordQuery, useMemwiseTriggers } from '@/hooks/useMemwiseRecords'
import { useMemwiseShellCalls } from '@/hooks/useMemwiseShellPages'
import { absoluteDate, absoluteTime, humanize, resultMessage, roleTitle, toolLabel } from '../../format'
import { useNow } from '../../use-now'
import { useProjectShell } from '../shell-context'
import { ShellPageFrame, ShellSection } from '../WaitingPage'
import { draftChangeCount, pageDraft, runsThisWeek, runWhere, stepRows, whoDoes, type StepRow, type Who } from './every-page-model'
import { ShellButton, ShellTable, Tag, ToneText } from './shell-ui'

export function PlaybookShellPage({ playbookId }: { playbookId: string }) {
  const { t } = useTranslation()
  const { data: playbook, error } = useMemwisePlaybook(playbookId)
  const { data: drafts } = useMemwiseDrafts(playbookId)
  const { data: versions } = useMemwiseVersions(playbookId)
  const { data: triggers } = useMemwiseTriggers()
  const cases = useAtomValue(memwiseCasesAtom)
  const inbox = useAtomValue(memwiseInboxAtom)
  const roles = useAtomValue(memwiseRolesAtom)
  const me = useAtomValue(memwiseStatusAtom)?.me
  const shell = useProjectShell()
  const now = useNow()
  const summary = pageDraft(drafts, playbookId)
  const { data: draft, reload: reloadDraft } = useMemwiseDraft(summary?.id ?? null)
  const shown = draft && draft.id === summary?.id ? draft : null

  if (!playbook) {
    return <div className="flex h-full items-center justify-center p-8 text-label text-tertiary">{error ?? t('memwise.entities.loading')}</div>
  }
  const rows = stepRows(playbook, shown && shown.stage !== 'published' ? shown : null)
  const runs = runsThisWeek(cases, playbookId, now)
  const starts = (triggers ?? []).filter(tr => tr.workflowId === playbookId)
  const live = versions?.find(v => v.version === playbook.version)
  const project = shell?.projectId ?? ''

  return (
    <ShellPageFrame
      crumb={<>{t('memwise.shell.playbooks')} <span className="text-tertiary">›</span> {playbook.title}</>}
      title={playbook.title}
      subtitle={(
        <span className="flex flex-wrap items-center gap-2">
          <Tag tone="green" data-testid="playbook-live">{t('memwise.everyPage.liveVersion', { version: playbook.version })}</Tag>
        </span>
      )}
    >
      {shown && (shown.stage === 'draft' || shown.stage === 'checked' || shown.stage === 'failed' || shown.stage === 'in_review') && (
        <DraftPanel draft={shown} playbook={playbook} onChanged={reloadDraft} />
      )}

      <ShellSection title={t('memwise.everyPage.startsWhen')}>
        <div className="text-label text-foreground" data-testid="playbook-starts">
          {starts.length ? starts.map(s => <p key={s.id}>{s.description}</p>) : <p className="text-secondary">{t('memwise.everyPage.startedByHand')}</p>}
        </div>
      </ShellSection>

      <ShellSection title={t('memwise.everyPage.steps')}>
        <ShellTable head={['', t('memwise.everyPage.step'), t('memwise.everyPage.who')]} testId="playbook-steps">
          {rows.map(r => <StepTableRow key={r.state} row={r} who={whoDoes(r.step, me?.roles ?? [])} roles={roles} />)}
        </ShellTable>
      </ShellSection>

      <ShellTable
        head={[t('memwise.everyPage.thisWeeksRuns'), t('memwise.everyPage.where'), t('memwise.everyPage.status')]}
        className="mb-6"
        testId="playbook-runs"
      >
        {runs.length === 0 && (
          <tr><td colSpan={3} className="px-4 py-3 text-secondary">{t('memwise.everyPage.noRunsThisWeek')}</td></tr>
        )}
        {runs.map(c => {
          const where = runWhere(c, playbook)
          const mine = (inbox ?? []).some(i => i.caseId === c.caseId)
          const tone = c.status === 'done' ? 'green' : mine ? 'amber' : 'muted'
          return (
            <tr key={c.caseId} className="cursor-pointer hover:bg-fill-hover" onClick={() => navigate(routes.view.project(project, { type: 'run', caseId: c.caseId }))} data-run={c.caseId}>
              <td className="px-4 py-2.5 text-foreground">{c.title}</td>
              <td className="px-4 py-2.5 text-secondary">
                {where.kind === 'done' ? t('memwise.everyPage.done') : where.kind === 'step' ? t('memwise.everyPage.stepWhere', { n: where.n, title: where.title }) : where.title}
              </td>
              <td className="px-4 py-2.5">
                <ToneText tone={tone}>
                  {c.status === 'done' ? t('memwise.everyPage.finished') : mine ? t('memwise.shell.waiting') : c.waitingOn?.kind === 'condition' ? t('memwise.everyPage.waitingOnRecord') : c.status === 'active' ? t('memwise.everyPage.running') : humanize(c.status)}
                </ToneText>
              </td>
            </tr>
          )
        })}
      </ShellTable>

      <p className="text-label-sm text-tertiary" data-testid="playbook-origin">
        {playbook.origin?.kind === 'plugin'
          ? t('memwise.everyPage.fromPlugin', { plugin: playbook.origin.plugin, version: playbook.version })
          : live
            ? t('memwise.everyPage.publishedBy', { version: live.version, date: absoluteDate(live.publishedAt), name: live.publishedByName ?? t('memwise.everyPage.someone') })
            : t('memwise.everyPage.versionOnly', { version: playbook.version })}
      </p>
    </ShellPageFrame>
  )
}

function whoLabel(who: Who, roles: MwRole[] | null, t: (k: string) => string): string {
  switch (who.kind) {
    case 'system': return t('memwise.everyPage.whoSystem')
    case 'agent': return t('memwise.everyPage.whoAgent')
    case 'you': return t('memwise.everyPage.whoYou')
    case 'external': return t('memwise.everyPage.whoExternal')
    case 'role': return roleTitle(who.role, roles) ?? humanize(who.role)
  }
}

function StepTableRow({ row, who, roles }: { row: StepRow; who: Who; roles: MwRole[] | null }) {
  const { t } = useTranslation()
  const c = row.change
  return (
    <tr className={cn(c && 'bg-accent-tint/40')} data-step={row.state} data-changed={c ? c.kind : undefined}>
      <td className="w-10 px-4 py-2.5 text-secondary">{row.n}</td>
      <td className="px-4 py-2.5 text-foreground">
        {c?.added ? (
          <>{row.title} <mark className="rounded-[3px] bg-accent-tint px-0.5 text-accent" data-testid="step-added">{c.added}</mark></>
        ) : c && c.title !== row.title ? (
          <mark className="rounded-[3px] bg-accent-tint px-0.5 text-accent">{c.title}</mark>
        ) : row.title}
        {c && !c.added && c.title === row.title && (
          <span className="ml-2 text-label-sm text-accent">{t('memwise.everyPage.changedParts', { parts: c.parts.map(humanize).join(', ') })}</span>
        )}
      </td>
      <td className="w-32 px-4 py-2.5 text-foreground">{whoLabel(who, roles, t)}</td>
    </tr>
  )
}

/** The draft its chat made: what changed, a test run on one record, Discard and Send for review. */
export function DraftPanel({ draft, playbook, onChanged }: { draft: MwDraft; playbook: MwPlaybook; onChanged: () => void }) {
  const { t } = useTranslation()
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  const [busy, setBusy] = React.useState<'discard' | 'send' | null>(null)
  const [open, setOpen] = React.useState(false)
  const changes = draftChangeCount(draft)
  // Sent: its change run checks it (examples, past cases) on the way to review.
  const { data: changeRun } = useMemwiseCase(draft.caseId ?? null)
  const checking = draft.stage !== 'in_review' && !draft.inChat && changeRun?.status === 'active' && changeRun.state !== 'review'
  const inReview = draft.stage === 'in_review' || checking
  const test = draft.lastTestRun && !draft.testRunStale ? draft.lastTestRun : undefined
  // Discard, Send for review and Run test are for someone who may change it (D122).
  const mayChange = draft.mayChange !== false

  const act = async (what: 'discard' | 'send') => {
    const api = getMemwiseApi()
    if (!api || !workspaceId) { toast.error(t('memwise.notAvailable')); return }
    setBusy(what)
    try {
      const r = what === 'send' ? await api.memwiseSubmitDraft(workspaceId, draft.id) : await api.memwiseDiscardDraft(workspaceId, draft.id)
      if (r.applied) toast.success(what === 'send' ? t('memwise.everyPage.sentForReview') : t('memwise.everyPage.draftDiscarded'))
      else toast.error(resultMessage(r, t) ?? t('memwise.inbox.notApplied'))
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mb-6 overflow-hidden rounded-[10px] border border-accent/25 bg-accent-tint/50" data-testid="playbook-draft" data-draft={draft.id} data-stage={draft.stage}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-label text-foreground" onClick={() => setOpen(o => !o)} aria-expanded={open} data-action="toggle-draft">
          {open ? <ChevronDown className="size-3.5 shrink-0 text-secondary" /> : <ChevronRight className="size-3.5 shrink-0 text-secondary" />}
          <span>
            <span className="font-semibold">{draft.chatId ? t('memwise.everyPage.draftFromChat') : t('memwise.everyPage.draft')}</span>{' '}
            <span data-testid="draft-line">
              {t('memwise.everyPage.changeCount', { count: changes })}
              {test ? ` · ${test.status === 'pass' ? t('memwise.everyPage.testRunPassed') : t('memwise.everyPage.testRunFailed')}` : ''}
              {checking ? ` · ${t('memwise.everyPage.checking')}` : inReview ? ` · ${t('memwise.everyPage.inReview')}` : ''}
            </span>
          </span>
        </button>
        {!inReview && mayChange && (
          <>
            <ShellButton onClick={() => void act('discard')} busy={busy === 'discard'} disabled={!!busy} data-action="discard-draft">{t('memwise.everyPage.discard')}</ShellButton>
            <ShellButton kind="solid" onClick={() => void act('send')} busy={busy === 'send'} disabled={!!busy} data-action="send-for-review">{t('memwise.everyPage.sendForReview')}</ShellButton>
          </>
        )}
        {inReview && draft.caseId && (
          <ShellButton onClick={() => navigate(routes.view.cases(draft.caseId!))}>{t('memwise.everyPage.openReview')}</ShellButton>
        )}
      </div>
      {open && (
        <div className="space-y-4 border-t border-accent/15 bg-background/70 px-4 py-3">
          <DraftChanges draft={draft} />
          {!inReview && mayChange && <TestRunBox draft={draft} playbook={playbook} />}
          {(inReview || !mayChange) && draft.lastTestRun && <TestRunResult run={draft.lastTestRun} stale={draft.testRunStale} />}
        </div>
      )}
      {!open && test && (
        <div className="border-t border-accent/15 bg-background/70 px-4 py-2 text-label-sm text-secondary" data-testid="test-run-summary">
          {testRunTitle(test, t)}{test.detail ? ` · ${sendsLine(test.trace, t) ?? t('memwise.everyPage.sendsNothing')}` : ''}
        </div>
      )}
    </div>
  )
}

function DraftChanges({ draft }: { draft: MwDraft }) {
  const { t } = useTranslation()
  const lines = draft.edits.filter(e => e.status !== 'discarded')
  return (
    <div>
      <p className="mb-1 text-label-sm font-semibold text-secondary">{t('memwise.everyPage.whatChanged')}</p>
      <ul className="space-y-1 text-label text-foreground" data-testid="draft-edits">
        {lines.map(e => (
          <li key={e.id} className="flex gap-2">
            <span className="min-w-0 flex-1">{e.summary}</span>
            <span className="shrink-0 text-label-sm text-tertiary">{e.via === 'chat' ? t('memwise.everyPage.fromChat') : e.byName ?? ''} · {absoluteTime(e.at)}</span>
          </li>
        ))}
        {lines.length === 0 && <li className="text-secondary">{t('memwise.everyPage.noChangesYet')}</li>}
      </ul>
    </div>
  )
}

/** The record type the playbook starts from: its first `Ref<…>` case field, required first. */
function startEntity(playbook: MwPlaybook, entities: { key: string; entity: string }[]): string | undefined {
  const refs = [...playbook.caseFields].sort((a, b) => Number(!!b.required) - Number(!!a.required))
    .map(f => /^Ref<([^>]+)>$/.exec(f.type)?.[1]).filter((x): x is string => !!x)
  for (const name of refs) {
    const hit = entities.find(e => e.key === name || e.entity === name || e.key.endsWith(`.${name}`))
    if (hit) return hit.key
  }
  return undefined
}

function TestRunBox({ draft, playbook }: { draft: MwDraft; playbook: MwPlaybook }) {
  const { t } = useTranslation()
  const domains = useAtomValue(memwiseDomainsAtom)
  const entities = React.useMemo(() => (domains ?? []).flatMap(d => d.entities), [domains])
  const entity = startEntity(playbook, entities)
  const { data: options } = useMemwiseRecordQuery(entity ? { entity, limit: 200 } : null)
  const [record, setRecord] = React.useState<string>('')
  const [running, setRunning] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const calls = useMemwiseShellCalls()
  const last = draft.lastTestRun
  React.useEffect(() => { if (!record && last?.record.id) setRecord(last.record.id) }, [last, record])

  const run = async () => {
    if (!entity || !record) return
    setRunning(true)
    setError(null)
    try {
      const r = await calls.testRunDraft(draft.id, { entity, id: record })
      if (!r.applied) setError(r.message ?? t('memwise.inbox.notApplied'))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div data-testid="test-run">
      <p className="mb-1 text-label-sm font-semibold text-secondary">{t('memwise.everyPage.testRun')}</p>
      <p className="mb-2 text-label-sm text-secondary">{t('memwise.everyPage.testRunHint')}</p>
      {entity ? (
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="h-8 min-w-0 flex-1 rounded-[7px] border border-foreground/15 bg-background px-2 text-label"
            value={record}
            onChange={e => setRecord(e.target.value)}
            disabled={running}
            data-testid="test-run-record"
            aria-label={t('memwise.everyPage.pickRecord')}
          >
            <option value="">{t('memwise.everyPage.pickRecord')}</option>
            {(options?.rows ?? []).map(r => <option key={r.id} value={r.id}>{r.title}</option>)}
          </select>
          <ShellButton onClick={() => void run()} busy={running} disabled={!record || running} data-action="run-test">
            <FlaskConical />
            {running ? t('memwise.everyPage.testRunning') : t('memwise.everyPage.runTest')}
          </ShellButton>
        </div>
      ) : (
        <p className="text-label text-secondary">{t('memwise.everyPage.noStartRecord')}</p>
      )}
      {error && <p className="mt-2 text-label-sm text-destructive" role="alert">{error}</p>}
      {last && <div className="mt-3"><TestRunResult run={last} stale={draft.testRunStale} /></div>}
    </div>
  )
}

/** "Test run on DE-104", or just "Test run" when the viewer may not see the record. */
function testRunTitle(run: MwDraftTestRun, t: (k: string, o?: Record<string, unknown>) => string): string {
  return run.record.title ? t('memwise.everyPage.testRunOn', { record: run.record.title }) : t('memwise.everyPage.testRun')
}

/** What a test run would send: the calls it stubbed, in a line ("to … · copied …"). */
function sendsLine(trace: MwRunTrace | undefined, t: (k: string, o?: Record<string, unknown>) => string): string | undefined {
  const call = trace?.calls.find(c => typeof c.args.sent_to === 'string' || typeof c.args.to === 'string')
  if (!call) return undefined
  const to = String(call.args.sent_to ?? call.args.to)
  const cc = call.args.copied ?? call.args.cc
  return cc ? t('memwise.everyPage.wouldSendCopied', { to, cc: String(cc) }) : t('memwise.everyPage.wouldSend', { to })
}

export function TestRunResult({ run, stale }: { run: MwDraftTestRun; stale?: boolean }) {
  const { t } = useTranslation()
  const trace = run.trace
  const effects = (trace?.calls ?? []).filter(c => !/\.(get|list|query|search)$/.test(c.tool))
  return (
    <div className="rounded-[8px] border border-foreground/10 bg-background px-3 py-2.5 text-label" data-testid="test-run-result" data-status={run.status}>
      <p className="flex flex-wrap items-center gap-2">
        {run.status === 'pass' ? <Check className="size-3.5 text-success" /> : <CircleAlert className="size-3.5 text-destructive" />}
        <span className="font-medium text-foreground">{testRunTitle(run, t)}</span>
        <span className="text-secondary">{run.status === 'pass' ? t('memwise.everyPage.passed') : run.status === 'skip' ? t('memwise.everyPage.couldNotRun') : t('memwise.everyPage.failed')}</span>
        {stale && <Tag tone="amber">{t('memwise.everyPage.staleTestRun')}</Tag>}
        <span className="ml-auto text-label-sm text-tertiary">{absoluteTime(run.at)}</span>
      </p>
      {!run.detail && <p className="mt-1 text-secondary" data-testid="test-run-not-mine">{t('memwise.everyPage.testRunOnlyForRunner', { name: run.byName ?? t('memwise.everyPage.someoneElse') })}</p>}
      {run.reason && <p className="mt-1 text-secondary">{run.reason}</p>}
      {run.differences.map((d, i) => <p key={i} className="mt-1 text-destructive">{d}</p>)}
      {trace && (
        <ol className="mt-2 space-y-0.5 text-label-sm text-secondary">
          {trace.steps.map((s, i) => (
            <li key={i}>{i + 1}. {s.title ?? humanize(s.state)}{s.outcome ? ` → ${humanize(s.outcome)}` : ''}</li>
          ))}
          <li className="text-tertiary">{t('memwise.everyPage.stoppedAt', { state: humanize(trace.state) })}</li>
        </ol>
      )}
      {effects.length > 0 && (
        <div className="mt-2 space-y-1.5" data-testid="test-run-effects">
          <p className="text-label-sm font-semibold text-secondary">{t('memwise.everyPage.wouldDo')}</p>
          {effects.map((c, i) => (
            <div key={i} className="rounded-[6px] bg-fill-hover/60 px-2.5 py-1.5 text-label-sm">
              <p className="flex items-center gap-1.5 font-medium text-foreground"><Mail className="size-3 text-secondary" />{toolLabel(c.tool)}{c.stubbed && <span className="font-normal text-tertiary">· {t('memwise.everyPage.notSent')}</span>}</p>
              {Object.entries(c.args).filter(([k, v]) => typeof v === 'string' && k !== 'site' && k !== 'body').slice(0, 5).map(([k, v]) => (
                <p key={k} className="text-secondary" data-arg={k}><span className="text-tertiary">{humanize(k)}:</span> {String(v)}</p>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
