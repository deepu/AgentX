/**
 * Key numbers as tiles (25 §5): a big tabular number, its label, and optionally a detail line
 * and a target. A number below its target reads in the destructive role, with the target
 * repeated in words (never colour alone).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Target } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface KpiTile {
  label: string
  value: number | null
  /** `percent`: the value is already 0–100. */
  format?: 'number' | 'percent'
  unit?: string
  target?: number
  detail?: string
  /** Shown instead of the formatted number (e.g. a date). */
  display?: string
}

export interface KpiTilesProps {
  items: KpiTile[]
  className?: string
}

export function kpiBelowTarget(tile: Pick<KpiTile, 'value' | 'target'>): boolean {
  return tile.target !== undefined && tile.value !== null && tile.value < tile.target
}

export function KpiTiles({ items, className }: KpiTilesProps) {
  const { t, i18n } = useTranslation()
  const fmt = (n: number, format?: KpiTile['format']) =>
    format === 'percent'
      ? `${new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(n)}%`
      : new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 }).format(n)
  if (items.length === 0) return null
  return (
    <div className={cn('grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3', className)} data-kpis>
      {items.map((k, i) => {
        const below = kpiBelowTarget(k)
        const value = k.display ?? (k.value === null ? t('chart.noValue') : fmt(k.value, k.format))
        return (
          <div key={`${i}:${k.label}`} className="min-w-0 rounded-lg bg-raised p-3.5 shadow-elev-1" data-kpi={k.label}>
            <div className={cn('truncate text-title tabular-nums', below ? 'text-destructive' : k.value === null && !k.display ? 'text-tertiary' : 'text-foreground')}>
              {value}
              {k.unit && k.value !== null && <span className="ml-1 text-label font-normal text-secondary">{k.unit}</span>}
            </div>
            <div className="mt-0.5 text-label font-medium text-foreground">{k.label}</div>
            {(k.detail || k.target !== undefined) && (
              <div className="mt-1 space-y-0.5 text-label-sm text-tertiary">
                {k.detail && <div>{k.detail}</div>}
                {k.target !== undefined && (
                  <div className={cn('flex items-center gap-1', below && 'text-destructive')} data-target>
                    <Target className="size-3" aria-hidden />
                    {t('chart.target', { value: fmt(k.target, k.format) })}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
