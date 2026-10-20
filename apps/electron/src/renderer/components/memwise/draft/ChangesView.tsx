/**
 * The "Changes" section of a draft: what it changes in plain words (from its structure), a warning
 * when the live playbook changed meanwhile, and, folded away, the exact lines of each file.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ChevronRight, Minus, PencilLine, Plus, Sparkles } from 'lucide-react'
import type { MwDraft, MwFileChange, MwPlaybook } from '@memwise/shared/protocol'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Badge } from '@/components/info/Info_Badge'
import { Info_Section } from '@/components/info/Info_Section'
import { cn } from '@/lib/utils'
import { changeLines, fileLabel, lineCounts, type ChangeLine } from './draft-model'

const LINE_ICON: Record<ChangeLine['kind'], React.ReactNode> = {
  added: <Plus className="size-3.5 text-success" aria-hidden />,
  removed: <Minus className="size-3.5 text-destructive" aria-hidden />,
  changed: <PencilLine className="size-3.5 text-info" aria-hidden />,
  info: <ChevronRight className="size-3.5 text-tertiary" aria-hidden />,
}

/** The change in plain words; lines about a step a pending chat edit touched are marked. */
export function ChangeSummary({ draft, live, pendingSteps, onOpenStep }: {
  draft: MwDraft
  live?: MwPlaybook | null
  /** Steps whose files a chat edit changed that is still waiting for keep or discard. */
  pendingSteps?: Set<string>
  onOpenStep?: (stepId: string) => void
}) {
  const { t, i18n } = useTranslation()
  if (!draft.structure) {
    return (
      <p className="px-4 py-3 text-label text-tertiary" data-changes-unavailable>
        {t('memwise.draft.changes.unavailable')}
      </p>
    )
  }
  const lines = changeLines(draft.structure, t, draft.playbook, live, i18n.resolvedLanguage)
  if (lines.length === 0) return <p className="px-4 py-3 text-label text-tertiary">{t('memwise.draft.changes.none')}</p>
  return (
    <ul className="divide-y divide-separator" data-change-summary>
      {lines.map((line, i) => {
        const pending = !!line.step && !!pendingSteps?.has(line.step)
        const open = line.step && onOpenStep && line.kind !== 'removed' ? () => onOpenStep(line.step!) : undefined
        return (
          <li key={i} className={cn('flex items-start gap-2.5 px-4 py-2 text-label', pending && 'bg-accent-tint/60')} data-change-kind={line.kind} data-pending={pending || undefined}>
            <span className="mt-0.5 shrink-0">{LINE_ICON[line.kind]}</span>
            {open ? (
              <button type="button" onClick={open} className="min-w-0 flex-1 text-left text-foreground hover:underline">{line.text}</button>
            ) : (
              <span className="min-w-0 flex-1 text-foreground">{line.text}</span>
            )}
            {pending && (
              <Info_Badge className="bg-accent-tint text-accent" icon={<Sparkles />}>{t('memwise.draft.fromChat')}</Info_Badge>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** One file's changed lines. */
export function FileDiff({ file, label, pending }: { file: MwFileChange; label: string; pending?: boolean }) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const id = React.useId()
  const { added, removed } = lineCounts(file)
  return (
    <div className={cn('border-b border-separator last:border-b-0', pending && 'bg-accent-tint/40')} data-file={file.path} data-file-status={file.status}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-fill-hover"
      >
        <ChevronRight className={cn('size-3.5 shrink-0 text-tertiary transition-transform', open && 'rotate-90')} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-label font-medium text-foreground">{label}</span>
          <span className="block truncate font-mono text-[11px] text-tertiary">{file.path}</span>
        </span>
        {file.conflict && <Info_Badge color="destructive" icon={<AlertTriangle />}>{t('memwise.draft.diff.conflict')}</Info_Badge>}
        {pending && <Info_Badge className="bg-accent-tint text-accent" icon={<Sparkles />}>{t('memwise.draft.fromChat')}</Info_Badge>}
        <Info_Badge color={file.status === 'added' ? 'success' : file.status === 'deleted' ? 'destructive' : 'default'}>
          {t(`memwise.draft.diff.${file.status}`)}
        </Info_Badge>
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          <span className="text-success">+{added}</span> <span className="text-destructive">−{removed}</span>
        </span>
      </button>
      {open && (
        <div id={id} className="overflow-x-auto border-t border-separator bg-sunken py-1 font-mono text-[12px] leading-5">
          {file.hunks.map((h, i) => (
            <div key={i} data-hunk>
              <div className="px-4 text-tertiary">@@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@</div>
              {h.lines.map((l, j) => (
                <div
                  key={j}
                  data-line={l.kind}
                  className={cn(
                    'whitespace-pre px-4',
                    l.kind === 'added' && 'bg-success-tint text-success',
                    l.kind === 'removed' && 'bg-destructive-tint text-destructive',
                    l.kind === 'same' && 'text-secondary',
                  )}
                >
                  <span className="mr-2 inline-block w-3 select-none" aria-hidden>{l.kind === 'added' ? '+' : l.kind === 'removed' ? '−' : ' '}</span>
                  {l.text}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ChangesView({ draft, live, pendingSteps, onOpenStep }: {
  draft: MwDraft
  live?: MwPlaybook | null
  pendingSteps?: Set<string>
  onOpenStep?: (stepId: string) => void
}) {
  const { t } = useTranslation()
  const pendingIds = new Set(draft.edits.filter(e => e.status === 'pending').map(e => e.id))
  return (
    <div className="space-y-6">
      {draft.conflicts.length > 0 && (
        <Info_Alert variant="error" icon={<AlertTriangle />} data-conflicts>
          <Info_Alert.Title>{t('memwise.draft.conflictTitle')}</Info_Alert.Title>
          <Info_Alert.Description>
            {t('memwise.draft.conflictDescription', { files: draft.conflicts.map(p => fileLabel(p, t, draft.playbook, live)).join(', ') })}
          </Info_Alert.Description>
        </Info_Alert>
      )}
      <Info_Section title={t('memwise.draft.changes.title')}>
        <ChangeSummary draft={draft} live={live} pendingSteps={pendingSteps} onOpenStep={onOpenStep} />
      </Info_Section>
      <Info_Section title={t('memwise.draft.diff.title')} count={draft.files.length} description={t('memwise.draft.diff.description')}>
        {draft.files.length === 0 ? (
          <p className="px-4 py-3 text-label text-tertiary">{t('memwise.draft.diff.none')}</p>
        ) : (
          draft.files.map(f => (
            <FileDiff
              key={f.path}
              file={f}
              label={fileLabel(f.path, t, draft.playbook, live)}
              pending={!!f.pendingEditId && pendingIds.has(f.pendingEditId)}
            />
          ))
        )}
      </Info_Section>
    </div>
  )
}
