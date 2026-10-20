import { useState } from "react"
import { parseLabelEntry, formatLabelEntry, formatDisplayValue } from "@memwise/shared/labels"
import { resolveEntityColor } from "@memwise/shared/colors"
import { useTheme } from "@/context/ThemeContext"
import { cn } from "@/lib/utils"
import { openLabelLink } from "@/lib/open-label-link"
import { LabelValuePopover } from "./label-value-popover"
import { LabelValueTypeIcon } from "./label-icon"
import type { LabelConfig } from "@memwise/shared/labels"

interface EntityListLabelBadgeProps {
  label: LabelConfig
  rawValue?: string
  sessionLabels: string[]
  onLabelsChange?: (updatedLabels: string[]) => void
  /** Controlled value-editor state (the chat header pins a chip while its editor is open) */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Session whose composer gets focus back when the editor closes */
  sessionId?: string
  /** Preferred side for the value editor */
  popoverSide?: 'top' | 'bottom'
  /**
   * The entry this chip shows in `sessionLabels`. When set, edits and removal touch only that entry,
   * so repeated ids (e.g. `customer::acme` + `customer::globex`) stay distinct. Without it, every
   * entry with the label's id changes.
   */
  entryIndex?: number
}

export function EntityListLabelBadge({
  label,
  rawValue,
  sessionLabels,
  onLabelsChange,
  open: controlledOpen,
  onOpenChange,
  sessionId,
  popoverSide,
  entryIndex,
}: EntityListLabelBadgeProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }
  const { isDark } = useTheme()
  const color = label.color ? resolveEntityColor(label.color, isDark) : null
  const displayValue = rawValue ? formatDisplayValue(rawValue, label.valueType) : undefined
  const isLink = label.valueType === 'link' && !!rawValue

  return (
    <LabelValuePopover
      label={label}
      value={rawValue}
      open={open}
      onOpenChange={setOpen}
      sessionId={sessionId}
      side={popoverSide}
      onValueChange={(newValue) => {
        const updated = sessionLabels.map((entry, index) => {
          const isThisChip = entryIndex !== undefined ? index === entryIndex : parseLabelEntry(entry).id === label.id
          return isThisChip ? formatLabelEntry(label.id, newValue) : entry
        })
        onLabelsChange?.(updated)
      }}
      onRemove={() => {
        const updated = sessionLabels.filter((entry, index) => (
          entryIndex !== undefined ? index !== entryIndex : parseLabelEntry(entry).id !== label.id
        ))
        onLabelsChange?.(updated)
      }}
    >
      {/* The chip is tinted with the label's own color (no separate dot: it cost ~10px per chip and read
       * as a stray status mark). Text stays in the solved foreground/secondary roles, so arbitrary user
       * colors never decide the contrast. Uncolored labels keep the neutral fill.
       * A div, not a button: in list rows it sits inside the row's button. Keyboard activation is wired by hand. */}
      <div
        role="button"
        tabIndex={0}
        title={displayValue ? `${label.name} · ${displayValue}` : label.name}
        className={cn(
          'shrink-0 h-5 @max-mobile/shell:h-6 max-w-[140px] px-1.5 rounded-xs text-label-sm flex items-center whitespace-nowrap gap-1 cursor-pointer overflow-hidden -outline-offset-2',
          color ? 'text-foreground' : 'bg-fill-hover text-secondary',
        )}
        style={color ? { backgroundColor: `color-mix(in srgb, ${color} 18%, transparent)` } : undefined}
        onMouseDown={(e) => { e.stopPropagation(); e.preventDefault() }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          e.stopPropagation()
          setOpen(!open)
        }}
      >
        <span className="truncate min-w-0">{label.name}</span>
        {displayValue ? (
          <>
            <span className={cn('shrink-0', color ? 'text-secondary' : 'text-tertiary')} aria-hidden="true">·</span>
            <span
              className={cn('truncate min-w-0', color ? 'text-secondary' : 'text-tertiary', isLink && 'cursor-pointer hover:underline underline-offset-2')}
              title={isLink ? rawValue : undefined}
              onClick={isLink ? (e) => { e.stopPropagation(); openLabelLink(rawValue!) } : undefined}
            >{displayValue}</span>
          </>
        ) : (
          label.valueType && (
            <>
              <span className={cn('shrink-0', color ? 'text-secondary' : 'text-tertiary')} aria-hidden="true">·</span>
              <LabelValueTypeIcon valueType={label.valueType} size={10} />
            </>
          )
        )}
      </div>
    </LabelValuePopover>
  )
}
