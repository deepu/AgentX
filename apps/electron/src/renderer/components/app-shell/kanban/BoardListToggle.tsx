import { LayoutGrid, List } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@memwise/ui'
import { cn } from '@/lib/utils'

export type BoardListValue = 'list' | 'board'

interface BoardListToggleProps {
  value: BoardListValue
  onChange: (value: BoardListValue) => void
  className?: string
}

/**
 * List ⇄ Board view switch. Rendered both in the sessions navigator header (list
 * mode) and in the board's own header (board mode), since the navigator is hidden
 * while the board is open and would otherwise have nowhere to host the switch.
 *
 * A segmented control (spec §4/A5): neutral well, the selected segment is raised. Icon segments
 * carry their name as tooltip + accessible name.
 */
export function BoardListToggle({ value, onChange, className }: BoardListToggleProps) {
  const { t } = useTranslation()
  return (
    <div
      role="group"
      className={cn(
        'titlebar-no-drag inline-flex items-center gap-0.5 rounded-md bg-fill-hover p-0.5',
        className
      )}
    >
      <ToggleButton active={value === 'list'} icon={List} label={t('kanban.list')} onClick={() => onChange('list')} />
      <ToggleButton
        active={value === 'board'}
        icon={LayoutGrid}
        label={t('kanban.board')}
        onClick={() => onChange('board')}
      />
    </div>
  )
}

function ToggleButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean
  icon: typeof List
  label: string
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-pressed={active}
          aria-label={label}
          className={cn(
            'inline-grid h-control-sm w-7 place-items-center rounded-sm',
            'transition-[background-color,color,box-shadow] duration-micro ease-out-subtle hover:duration-instant',
            active ? 'bg-floating text-foreground shadow-elev-1' : 'text-secondary hover:text-foreground'
          )}
        >
          <Icon className="size-3.5" strokeWidth={2} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
