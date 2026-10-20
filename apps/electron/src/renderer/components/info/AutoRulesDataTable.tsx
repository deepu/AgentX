/**
 * AutoRulesDataTable
 *
 * Flat data table displaying all auto-label rules across all labels.
 * Each row shows which label a rule belongs to, the regex pattern, flags,
 * value template, and description.
 *
 * Rules are collected by recursively traversing the label tree and flattening
 * all autoRules into a single list.
 */

import * as React from 'react'
import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { ColumnDef } from '@tanstack/react-table'
import { Info_DataTable, SortableHeader, INFO_TABLE_HEADER_CLASS, INFO_TABLE_SORTABLE_HEADER_CLASS } from './Info_DataTable'
import { Info_Badge } from './Info_Badge'
import { Info_FullscreenButton } from './Info_FullscreenButton'
import { Tooltip, TooltipTrigger, TooltipContent } from '@memwise/ui'
import { DataTableOverlay } from '@memwise/ui'
import { LabelIcon } from '@/components/ui/label-icon'
import { cn } from '@/lib/utils'
import { useTheme } from '@/hooks/useTheme'
import { toast } from 'sonner'
import type { LabelConfig, AutoLabelRule } from '@memwise/shared/labels'
import { isSemanticAutoLabelRule, DEFAULT_SEMANTIC_RULE_THRESHOLD } from '@memwise/shared/labels'

/**
 * Flattened auto-rule row: associates a rule with its parent label
 */
interface AutoRuleRow {
  /** The label this rule belongs to */
  label: LabelConfig
  /** The auto-label rule */
  rule: AutoLabelRule
}

interface AutoRulesDataTableProps {
  /** Label tree (root-level nodes with nested children) */
  data: LabelConfig[]
  /** Show search input */
  searchable?: boolean
  /** Max height with scroll */
  maxHeight?: number
  /** Enable fullscreen button */
  fullscreen?: boolean
  /** Title for fullscreen overlay */
  fullscreenTitle?: string
  className?: string
}

/** The value a rule stores: its template or fixed value — none on a plain label, which ignores both. */
function ruleValueText({ label, rule }: AutoRuleRow): string | undefined {
  if (!label.valueType) return undefined
  return isSemanticAutoLabelRule(rule) ? rule.value : rule.valueTemplate
}

/**
 * PatternBadge - Monospace regex pattern with click-to-copy and tooltip.
 * Mirrors the PatternBadge from PermissionsDataTable for consistency.
 */
function PatternBadge({ pattern }: { pattern: string }) {
  const { t } = useTranslation()
  const handleClick = async () => {
    try {
      await navigator.clipboard.writeText(pattern)
      toast.success(t('toast.patternCopied'))
    } catch {
      toast.error(t('toast.failedToCopyPattern'))
    }
  }

  const badge = (
    <button type="button" onClick={handleClick} className="-my-0.5 rounded-xs py-0.5 text-left">
      <Info_Badge color="muted" className="font-mono font-normal select-none">
        <span className="block overflow-hidden whitespace-nowrap text-ellipsis max-w-[200px]">
          {pattern}
        </span>
      </Info_Badge>
    </button>
  )

  if (pattern.length >= 25) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent className="font-mono max-w-md break-all">{pattern}</TooltipContent>
      </Tooltip>
    )
  }

  return badge
}

// Column definitions for the auto-rules flat table
function getColumns(t: TFunction): ColumnDef<AutoRuleRow>[] {
  return [
    {
      id: 'label',
      header: ({ column }) => <SortableHeader column={column} title={t("table.label")} className={INFO_TABLE_SORTABLE_HEADER_CLASS} />,
      accessorFn: (row) => row.label.name,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5 flex items-center gap-1.5">
          <LabelIcon label={row.original.label} size="xs" />
          <span className="truncate text-label text-foreground">{row.original.label.name}</span>
        </div>
      ),
      minSize: 100,
    },
    {
      id: 'pattern',
      header: ({ column }) => <SortableHeader column={column} title={t("table.pattern")} className={INFO_TABLE_SORTABLE_HEADER_CLASS} />,
      // Semantic rules (decision model) show their yes/no question where regex rules show the pattern.
      accessorFn: (row) => (isSemanticAutoLabelRule(row.rule) ? row.rule.semantic : row.rule.pattern),
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5 flex items-center gap-1.5 min-w-0">
          {isSemanticAutoLabelRule(row.original.rule) ? (
            <>
              <Info_Badge color="default" className="whitespace-nowrap shrink-0">{t("table.semanticRule")}</Info_Badge>
              <span className="truncate text-label text-foreground" title={row.original.rule.semantic}>{row.original.rule.semantic}</span>
            </>
          ) : (
            <PatternBadge pattern={row.original.rule.pattern} />
          )}
        </div>
      ),
      minSize: 120,
    },
    {
      id: 'flags',
      header: () => <span className={cn("p-1.5 pl-2.5", INFO_TABLE_HEADER_CLASS)}>{t("table.flags")}</span>,
      // Semantic rules have no flags; the column carries their threshold instead.
      accessorFn: (row) => (isSemanticAutoLabelRule(row.rule) ? `≥ ${(row.rule.threshold ?? DEFAULT_SEMANTIC_RULE_THRESHOLD).toFixed(2)}` : row.rule.flags ?? 'gi'),
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5">
          <span className="font-mono text-mono-ui text-tertiary">
            {isSemanticAutoLabelRule(row.original.rule)
              ? `≥ ${(row.original.rule.threshold ?? DEFAULT_SEMANTIC_RULE_THRESHOLD).toFixed(2)}`
              : row.original.rule.flags ?? 'gi'}
          </span>
        </div>
      ),
      minSize: 50,
    },
    {
      id: 'template',
      header: () => <span className={cn("p-1.5 pl-2.5", INFO_TABLE_HEADER_CLASS)}>{t("table.template")}</span>,
      accessorFn: (row) => ruleValueText(row) ?? '',
      cell: ({ row }) => {
        const text = ruleValueText(row.original)
        return (
          <div className="p-1.5 pl-2.5">
            {text ? (
              <Info_Badge color="muted" className="font-mono font-normal whitespace-nowrap">
                {text}
              </Info_Badge>
            ) : (
              <span className="text-label text-tertiary">—</span>
            )}
          </div>
        )
      },
      minSize: 80,
    },
    {
      id: 'description',
      header: () => <span className={cn("p-1.5 pl-2.5", INFO_TABLE_HEADER_CLASS)}>{t("common.description")}</span>,
      accessorFn: (row) => row.rule.description ?? '',
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5 min-w-0">
          <span className="truncate block text-label text-secondary">
            {row.original.rule.description || '—'}
          </span>
        </div>
      ),
      meta: { fillWidth: true, truncate: true },
    },
  ]
}

/**
 * Recursively collect all auto-rules from the label tree,
 * associating each rule with its parent label.
 */
function collectAutoRules(labels: LabelConfig[]): AutoRuleRow[] {
  const rows: AutoRuleRow[] = []

  function traverse(nodes: LabelConfig[]) {
    for (const label of nodes) {
      if (label.autoRules?.length) {
        for (const rule of label.autoRules) {
          rows.push({ label, rule })
        }
      }
      if (label.children?.length) {
        traverse(label.children)
      }
    }
  }

  traverse(labels)
  return rows
}

export function AutoRulesDataTable({
  data,
  searchable = false,
  maxHeight = 400,
  fullscreen = false,
  fullscreenTitle = 'Auto-Apply Rules',
  className,
}: AutoRulesDataTableProps) {
  const { t } = useTranslation()
  const [isFullscreen, setIsFullscreen] = useState(false)
  const { isDark } = useTheme()
  const columns = useMemo(() => getColumns(t), [t])

  // Flatten label tree into auto-rule rows
  const rows = useMemo(() => collectAutoRules(data), [data])

  // Fullscreen button (shown on hover)
  const fullscreenButton = fullscreen ? (
    <Info_FullscreenButton onClick={() => setIsFullscreen(true)} />
  ) : undefined

  return (
    <>
      <Info_DataTable
        columns={columns}
        data={rows}
        searchable={searchable ? { placeholder: t("table.searchRules") } : false}
        maxHeight={maxHeight}
        emptyContent={t("settings.labels.noAutoApplyRules")}
        floatingAction={fullscreenButton}
        className={cn(fullscreen && 'group', className)}
      />

      {/* Fullscreen overlay */}
      {fullscreen && (
        <DataTableOverlay
          isOpen={isFullscreen}
          onClose={() => setIsFullscreen(false)}
          title={fullscreenTitle}
          subtitle={t("table.ruleCount", { count: rows.length })}
          theme={isDark ? 'dark' : 'light'}
        >
          <Info_DataTable
            columns={columns}
            data={rows}
            searchable={searchable ? { placeholder: t("table.searchRules") } : false}
            emptyContent={t("settings.labels.noAutoApplyRules")}
          />
        </DataTableOverlay>
      )}
    </>
  )
}
