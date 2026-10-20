/**
 * The chat header's leading status glyph (design spec §7.3): the session's workflow status at the
 * session-row glyph size, opening the existing status menu. In the compact shell it opens the
 * session drawer's Status pane instead: touch rows, and no filter field that raises the keyboard.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import { SessionStatusMenu, statusDisplayLabel } from '@/components/ui/session-status-menu'
import {
  getState,
  getStateIcon,
  getStateIconStyle,
  type SessionStatus,
  type SessionStatusId,
} from '@/config/session-status-config'

interface ChatHeaderStatusButtonProps {
  sessionId: string
  statusId: SessionStatusId
  statuses: SessionStatus[]
  onSelect: (statusId: SessionStatusId) => void
  /** Compact shell: opens the session drawer on its Status pane instead of the popover (gets this button, for focus return) */
  onOpenCompact?: (opener: HTMLElement) => void
  /** Compact shell: whether the drawer is open on the Status pane */
  compactExpanded?: boolean
}

export function ChatHeaderStatusButton({
  sessionId,
  statusId,
  statuses,
  onSelect,
  onOpenCompact,
  compactExpanded = false,
}: ChatHeaderStatusButtonProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  // The desktop popover must not come back open after a trip through the compact layout.
  const isCompact = !!onOpenCompact
  React.useEffect(() => setOpen(false), [isCompact])
  const state = getState(statusId, statuses)
  const label = t('chat.statusButton', { status: state ? statusDisplayLabel(state, t) : statusId })

  const glyph = (
    <span
      aria-hidden="true"
      className="flex size-4 items-center justify-center in-data-compact:size-5 [&>svg]:size-full [&>img]:size-full [&>span]:text-label"
      style={getStateIconStyle(statusId, statuses)}
    >
      {getStateIcon(statusId, statuses)}
    </span>
  )

  if (onOpenCompact) {
    return (
      <PanelHeaderCenterButton
        icon={glyph}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={compactExpanded}
        onClick={(event) => onOpenCompact(event.currentTarget)}
        className="panel-header-status"
      />
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <PanelHeaderCenterButton icon={glyph} aria-label={label} title={label} className="panel-header-status" />
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0 border-0 shadow-none bg-transparent"
        side="bottom"
        align="start"
        sideOffset={4}
        onCloseAutoFocus={(e) => {
          // Like the composer chip this replaces: typing continues in the composer.
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('memwise:focus-input', { detail: { sessionId } }))
        }}
      >
        <SessionStatusMenu
          activeState={statusId}
          states={statuses}
          onSelect={(id) => {
            setOpen(false)
            onSelect(id)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
