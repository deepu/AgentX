/**
 * Review template update (26 §3): what a newer version of the app's template changes and what
 * each change means for this project (taken, already done the same way here, changed here
 * differently, left out), a test run of one of the project's past cases on the new version, and
 * Take or Skip. Presentational; TemplateUpdateScreen calls the host.
 */

import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { FlaskConical } from 'lucide-react'
import type { MwTemplateTestRun, MwTemplateUpdateChange, MwTemplateUpdateReview } from '@memwise/shared/protocol'
import { Info_Page } from '@/components/info/Info_Page'
import { Info_Section } from '@/components/info/Info_Section'
import { Button } from '@/components/ui/button'
import { Spinner } from '@memwise/ui'
import { cn } from '@/lib/utils'

export type TemplateUpdateBusy = 'test' | 'take' | 'skip'

export interface TemplateUpdateViewProps {
  review: MwTemplateUpdateReview
  busy?: TemplateUpdateBusy | null
  error?: string | null
  /** The result of taking it ("Now on version 5"). */
  taken?: { version: number; removed: string[] } | null
  onTest?: () => void
  onTake?: () => void
  onSkip?: () => void
  onOpenProject?: () => void
}

export function TemplateUpdateView({ review, busy, error, taken, onTest, onTake, onSkip, onOpenProject }: TemplateUpdateViewProps) {
  const { t } = useTranslation()
  const { item } = review
  const done = !!taken
  return (
    <Info_Page.Content>
      <div className="space-y-6" data-template-update={item.id}>
        <div className="space-y-1">
          <div className="text-label-sm text-tertiary" data-breadcrumbs>
            {item.projectName} › {t('memwise.projects.update.title')}
          </div>
          <h2 className="text-title text-foreground">{t('memwise.projects.update.heading', { app: item.appTitle, version: item.to })}</h2>
          <p className="text-label-sm text-secondary">{t('memwise.projects.update.fromTo', { from: item.from, to: item.to, project: item.projectName })}</p>
        </div>

        {review.nothingChanges && (
          <p className="rounded-md bg-info-tint px-3 py-2.5 text-label text-foreground" data-nothing-changes>{t('memwise.projects.update.nothingChanges')}</p>
        )}

        <Info_Section title={t('memwise.projects.update.changes')} count={review.changes.length}>
          <ul className="divide-y divide-separator" data-changes>
            {review.changes.map((c) => (
              <li key={c.path} className="space-y-0.5 px-3.5 py-2.5" data-change={c.path} data-meaning={c.project}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 text-label font-semibold text-foreground">{c.title}</span>
                  <span className="text-label-sm text-tertiary">{changeKind(c, t)}</span>
                </div>
                <p className={cn('text-label-sm', c.project === 'takes' ? 'text-secondary' : 'text-tertiary')}>{changeMeaning(c, t)}</p>
              </li>
            ))}
            {review.changes.length === 0 && <li className="px-3.5 py-3 text-label text-tertiary">{t('memwise.projects.update.noChanges')}</li>}
          </ul>
        </Info_Section>

        <Info_Section
          title={t('memwise.projects.update.testRun')}
          actions={onTest && !review.test && !done ? (
            <Button variant="secondary" size="sm" onClick={onTest} disabled={!!busy} data-action="test">
              {busy === 'test' ? <Spinner className="text-label-sm" /> : <FlaskConical />}
              {t('memwise.projects.update.runTest')}
            </Button>
          ) : undefined}
        >
          <div className="px-3.5 py-3">
            {review.test ? <TestRun run={review.test} /> : <p className="text-label text-tertiary">{t('memwise.projects.update.testHint')}</p>}
          </div>
        </Info_Section>

        {error && <p className="text-label-sm text-destructive" role="alert">{error}</p>}
        {taken && (
          <p className="text-label text-foreground" data-taken={taken.version}>
            {t('memwise.projects.update.taken', { version: taken.version })}
            {taken.removed.length > 0 && ` ${t('memwise.projects.update.overridesGone', { count: taken.removed.length })}`}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-separator pt-4" data-actions>
          {done ? (
            onOpenProject && <Button variant="secondary" onClick={onOpenProject} data-action="open-project">{t('memwise.projects.waiting.openProject')}</Button>
          ) : (
            <>
              {onSkip && <Button variant="secondary" onClick={onSkip} disabled={!!busy} data-action="skip">{t('memwise.projects.update.skip')}</Button>}
              {onTake && <Button onClick={onTake} disabled={!!busy} data-action="take">{t('memwise.projects.update.take', { version: item.to })}</Button>}
            </>
          )}
        </div>
      </div>
    </Info_Page.Content>
  )
}

function TestRun({ run }: { run: MwTemplateTestRun }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-1.5" data-test-run={run.status}>
      <p className="text-label text-foreground">
        {testLine(run, t)}
      </p>
      {run.examples.total > 0 && (
        <p className="text-label-sm text-secondary">{t('memwise.projects.update.examples', { passed: run.examples.passed, total: run.examples.total })}</p>
      )}
      {run.differences.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-label-sm text-secondary">
          {run.differences.map((d) => <li key={d}>{d}</li>)}
        </ul>
      )}
    </div>
  )
}

export function changeKind(c: MwTemplateUpdateChange, t: TFunction): string {
  switch (c.kind) {
    case 'added': return t('memwise.projects.update.kind.added')
    case 'changed': return t('memwise.projects.update.kind.changed')
    case 'removed': return t('memwise.projects.update.kind.removed')
  }
}

export function testLine(run: MwTemplateTestRun, t: TFunction): string {
  const name = run.title ?? run.caseId ?? run.workflowId
  switch (run.status) {
    case 'same': return t('memwise.projects.update.test.same', { case: name })
    case 'different': return t('memwise.projects.update.test.different', { case: name })
    case 'error': return t('memwise.projects.update.test.error', { case: name })
    case 'skip': return t('memwise.projects.update.test.skip', { case: name })
  }
}

/** What a change means here, in the reader's language. */
export function changeMeaning(c: MwTemplateUpdateChange, t: TFunction): string {
  switch (c.project) {
    case 'takes': return t('memwise.projects.update.meaning.takes')
    case 'overridden-same': return t('memwise.projects.update.meaning.same')
    case 'overridden-differs': return t('memwise.projects.update.meaning.differs')
    case 'left-out': return t('memwise.projects.update.meaning.leftOut')
  }
}
