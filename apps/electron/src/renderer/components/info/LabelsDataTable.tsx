/**
 * LabelsDataTable
 *
 * Hierarchical data table for displaying label configurations.
 * Uses TanStack Table's built-in expand/collapse for tree rendering.
 * Columns: Color, Name (indented + chevron), Value Type.
 */

import * as React from 'react'
import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { ColumnDef, Row } from '@tanstack/react-table'
import { ChevronRight } from 'lucide-react'
import { Info_DataTable, SortableHeader, INFO_TABLE_HEADER_CLASS, INFO_TABLE_SORTABLE_HEADER_CLASS } from './Info_DataTable'
import { Info_Badge } from './Info_Badge'
import { Info_FullscreenButton } from './Info_FullscreenButton'
import { DataTableOverlay } from '@memwise/ui'
import { LabelIcon } from '@/components/ui/label-icon'
import { cn } from '@/lib/utils'
import { useTheme } from '@/hooks/useTheme'
import type { LabelConfig } from '@memwise/shared/labels'

interface LabelsDataTableProps {
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

/**
 * ExpandableNameCell - Renders label name with indentation and expand/collapse chevron.
 * Depth-based indentation with a rotating chevron for parent nodes.
 */
function ExpandableNameCell({ row }: { row: Row<LabelConfig> }) {
  const canExpand = row.getCanExpand()
  const isExpanded = row.getIsExpanded()

  return (
    <div
      className="flex items-center gap-1.5 p-1.5 pl-2.5"
      // Indent based on depth: 16px per level
      style={{ paddingLeft: `${row.depth * 16 + 10}px` }}
    >
      {/* Expand/collapse chevron for parent nodes */}
      {canExpand ? (
        <button
          type="button"
          aria-expanded={isExpanded}
          aria-label={row.original.name}
          onClick={(e) => {
            e.stopPropagation()
            row.toggleExpanded()
          }}
          className="-m-1 inline-grid size-6 place-items-center rounded-sm transition-colors duration-micro ease-out-subtle hover:bg-fill-hover hover:duration-instant"
        >
          <ChevronRight
            className={cn(
              // Rotation on the snap spring; instant under reduced motion (--motion-scale 0)
              'size-3 text-tertiary transition-transform duration-[calc(var(--spring-snap-dur)*var(--motion-scale))] ease-[var(--spring-snap)]',
              isExpanded && 'rotate-90'
            )}
          />
        </button>
      ) : (
        // Spacer to keep alignment consistent with expandable rows
        <span className="w-4" />
      )}
      <span className="truncate text-label text-foreground">{row.original.name}</span>
    </div>
  )
}

// Column definitions for the labels tree table
function getColumns(t: TFunction): ColumnDef<LabelConfig>[] {
  return [
    {
      id: 'color',
      header: () => <span className={cn("p-1.5 pl-2.5", INFO_TABLE_HEADER_CLASS)}>{t("common.color")}</span>,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5">
          <LabelIcon
            label={row.original}
            size="sm"
            hasChildren={!!row.original.children?.length}
          />
        </div>
      ),
      minSize: 60,
      maxSize: 60,
    },
    {
      accessorKey: 'name',
      header: ({ column }) => <SortableHeader column={column} title={t("common.name")} className={INFO_TABLE_SORTABLE_HEADER_CLASS} />,
      cell: ({ row }) => <ExpandableNameCell row={row} />,
      meta: { fillWidth: true },
    },
    {
      id: 'valueType',
      accessorKey: 'valueType',
      header: ({ column }) => <SortableHeader column={column} title={t("common.type")} className={INFO_TABLE_SORTABLE_HEADER_CLASS} />,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5">
          {row.original.valueType ? (
            <Info_Badge color="default" className="capitalize whitespace-nowrap">
              {t(`sidebar.labelValueType.${row.original.valueType}`)}
            </Info_Badge>
          ) : (
            <span className="text-label text-tertiary">—</span>
          )}
        </div>
      ),
      minSize: 120,
    },
  ]
}

/**
 * Extract children from a LabelConfig for tree expansion.
 * Returns undefined if no children (tells TanStack this is a leaf node).
 */
function getSubRows(row: LabelConfig): LabelConfig[] | undefined {
  return row.children?.length ? row.children : undefined
}

export function LabelsDataTable({
  data,
  searchable = false,
  maxHeight = 400,
  fullscreen = false,
  fullscreenTitle = 'Labels',
  className,
}: LabelsDataTableProps) {
  const { t } = useTranslation()
  const [isFullscreen, setIsFullscreen] = useState(false)
  const { isDark } = useTheme()
  const columns = useMemo(() => getColumns(t), [t])

  // Fullscreen button (shown on hover via group class)
  const fullscreenButton = fullscreen ? (
    <Info_FullscreenButton onClick={() => setIsFullscreen(true)} />
  ) : undefined

  // Count all labels recursively for the subtitle
  const countLabels = (labels: LabelConfig[]): number =>
    labels.reduce((sum, l) => sum + 1 + countLabels(l.children || []), 0)
  const totalCount = countLabels(data)

  return (
    <>
      <Info_DataTable
        columns={columns}
        data={data}
        searchable={searchable ? { placeholder: t("table.searchLabels") } : false}
        maxHeight={maxHeight}
        emptyContent={t("table.noLabelsConfigured")}
        floatingAction={fullscreenButton}
        className={cn(fullscreen && 'group', className)}
        getSubRows={getSubRows}
      />

      {/* Fullscreen overlay */}
      {fullscreen && (
        <DataTableOverlay
          isOpen={isFullscreen}
          onClose={() => setIsFullscreen(false)}
          title={fullscreenTitle}
          subtitle={t("table.labelCount", { count: totalCount })}
          theme={isDark ? 'dark' : 'light'}
        >
          <Info_DataTable
            columns={columns}
            data={data}
            searchable={searchable ? { placeholder: t("table.searchLabels") } : false}
            emptyContent={t("table.noLabelsConfigured")}
            getSubRows={getSubRows}
          />
        </DataTableOverlay>
      )}
    </>
  )
}
