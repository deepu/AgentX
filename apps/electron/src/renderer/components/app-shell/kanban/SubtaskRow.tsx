import { CheckCircle2, Circle, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Spinner } from '@memwise/ui'
import { cn } from '@/lib/utils'
import { ModelChip } from './ModelChip'
import type { KanbanSubtask, SubtaskRunState } from './types'

/**
 * Run-state glyph for a spawned subtask (design spec §2.4 vocabulary): done (success check),
 * running (the working mark in accent), pending (quiet ring), failed (destructive cross).
 * Each state has its own shape, so state is never carried by color alone.
 */
function RunStateIcon({ runState }: { runState: SubtaskRunState }) {
  const { t } = useTranslation()
  switch (runState) {
    case 'done':
      return <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-label={t('common.done')} />
    case 'running':
      return <Spinner className="shrink-0 text-label text-accent" />
    case 'failed':
      return <XCircle className="size-3.5 shrink-0 text-destructive" strokeWidth={2} aria-label={t('common.failed')} />
    case 'pending':
    default:
      return <Circle className="size-3.5 shrink-0 text-tertiary" strokeWidth={1.5} aria-label={t('common.pending')} />
  }
}

interface SubtaskRowProps {
  subtask: KanbanSubtask
  className?: string
  /** When set, the row becomes a button that opens the subtask's session window. */
  onClick?: () => void
}

/** One spawned-subtask row: run-state icon + title + the model it was routed to. */
export function SubtaskRow({ subtask, className, onClick }: SubtaskRowProps) {
  const isDone = subtask.runState === 'done'
  const interactive = !!onClick
  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={
        interactive
          ? e => {
              e.stopPropagation()
              onClick?.()
            }
          : undefined
      }
      onKeyDown={
        interactive
          ? e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                onClick?.()
              }
            }
          : undefined
      }
      className={cn(
        'flex min-h-6 items-center gap-2 py-0.5',
        interactive &&
          '-mx-1 cursor-pointer rounded-sm px-1 transition-colors duration-micro ease-out-subtle hover:bg-fill-hover hover:duration-instant',
        className
      )}
    >
      <RunStateIcon runState={subtask.runState} />
      <span className={cn('flex-1 truncate text-label-sm', isDone ? 'text-tertiary line-through' : 'text-secondary')}>
        {subtask.title}
      </span>
      <ModelChip model={subtask.model} short className="w-20 shrink-0" />
    </div>
  )
}
