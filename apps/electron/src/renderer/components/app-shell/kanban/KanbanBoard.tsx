import * as React from 'react'
import { Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  DndContext,
  DragOverlay,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  FLIP_ANIMATION_ID,
  SPRING,
  cancelFlip,
  playFlip,
  prefersReducedMotion,
  snapshotRects,
  springTiming,
  type FlipSnapshot,
} from '@memwise/ui/motion'
import type { KanbanColumnDef } from '@memwise/shared/projects/types'
import { SmartPointerSensor } from '@/components/ui/sortable-list'
import { IconButton } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ProjectColorTreatment } from '@/utils/project-colors'
import type { SessionStatus } from '@/config/session-status-config'
import { useKanbanColumnColors, makeColumnColor } from '@/hooks/useKanbanColumnColors'
import { KanbanColumn } from './KanbanColumn'
import { KANBAN_COLUMNS } from './status-column'
import { boardCollisionDetection } from './board-collision'
import { TaskTile } from './TaskTile'
import type {
  KanbanColumnId,
  KanbanColumnMeta,
  KanbanModelProviderGroup,
  KanbanProject,
  KanbanTask,
} from './types'

interface KanbanBoardProps {
  /** Ordered columns to render. Built-ins carry `labelKey`; custom columns carry `name`. */
  columns: readonly KanbanColumnMeta[]
  tasks: KanbanTask[]
  projectsById: Map<string, KanbanProject>
  statusesById: Map<string, SessionStatus>
  /** Ordered workspace statuses for the per-tile status picker. */
  statuses?: SessionStatus[]
  /** Change a task's status from its tile. Enables the status-badge picker when set. */
  onChangeStatus?: (taskId: string, statusId: string) => void
  /** Project color treatment. Defaults to 'stripe-tint'. */
  treatment?: ProjectColorTreatment
  expandedTaskIds: Set<string>
  onTaskClick?: (taskId: string) => void
  /** Open the full-pane editor against a tile (edit mode). Enables the tile's "Edit task" action. */
  onEditTask?: (taskId: string) => void
  onToggleSubtasks?: (taskId: string) => void
  onSubtaskClick?: (taskId: string, subtaskId: string) => void
  onAddSubtask?: (taskId: string, title: string, model: string) => void
  /** Run all pending subtasks of a task. Shows each tile's Play button when set. */
  onRunSubtasks?: (taskId: string) => void
  /** Provider→model catalog for each tile's "Add subtask" composer. */
  subtaskModelGroups?: KanbanModelProviderGroup[]
  /** Model id pre-selected in the composer. */
  defaultSubtaskModel?: string
  /** Create a task tile from a typed title. Renders the inline composer in the first column. */
  onCreateTask?: (title: string) => void
  /** Move a tile to another column (drag-and-drop). Placement only — never touches status. */
  onMoveTask?: (taskId: string, toColumn: KanbanColumnId) => void
  /** Per-column status auto-applied on drop. Keyed by column id; empty = leave untouched. */
  columnDropStatus?: Partial<Record<KanbanColumnId, string>>
  /** Set a column's drop-status from its header. Enables the header picker when provided. */
  onSelectDropStatus?: (column: KanbanColumnId, statusId: string) => void
  /** Rename/recolor a custom column (single-project edit mode). Enables the column editor. */
  onUpdateColumn?: (columnId: string, patch: Partial<KanbanColumnDef>) => void
  /** Remove a custom column (single-project edit mode); its cards reassign to the first column. */
  onRemoveColumn?: (columnId: string) => void
  /** Append a new custom column (single-project edit mode). Renders the "add column" affordance. */
  onAddColumn?: () => void
}

/** Newest tiles first within each column (a freshly created task lands on top). */
const taskRecency = (task: KanbanTask) => task.createdAt ?? task.lastMessageAt ?? 0

const BUILT_IN_COLUMN_IDS: ReadonlySet<string> = new Set(KANBAN_COLUMNS.map(c => c.id))

/** Tilt of the lifted card (≤ 2°, spec §6.3). CSS scales it by --motion-scale, so 0 under reduced motion. */
const DRAG_TILT_DEG = 1.5

/** Rects captured at drop time; played once the board has re-rendered the tiles in place. */
interface PendingSettle {
  taskId: string
  /** Where the lifted card was released (the overlay clone's box). */
  released: DOMRect
  /** Every tile's position before the drop commit, for the neighbour glide. */
  tiles: FlipSnapshot
}

/**
 * The dropped card settles from where it was released into its slot on the gesture spring
 * (keeps the release feel; spec §6.3), shedding the drag tilt on the way. Transform only.
 */
function settleDroppedTile(el: HTMLElement, released: DOMRect): Animation | null {
  if (prefersReducedMotion()) return null
  const slot = el.getBoundingClientRect()
  // Centers, so the tilted overlay box (slightly larger than the card) lines up.
  const dx = released.left + released.width / 2 - (slot.left + slot.width / 2)
  const dy = released.top + released.height / 2 - (slot.top + slot.height / 2)
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return null
  const { easing, duration } = springTiming(SPRING.gesture)
  const animation = el.animate(
    [{ transform: `translate(${dx}px, ${dy}px) rotate(${DRAG_TILT_DEG}deg)` }, { transform: 'none' }],
    { duration, easing },
  )
  animation.id = FLIP_ANIMATION_ID
  return animation
}

/**
 * While cards glide, let short columns paint their overflow: a card on its way in is then neither
 * clipped by the column's scroll box nor flashes a scrollbar. Columns that actually scroll keep
 * clipping (their content is clipped anyway). Returns an undo for the inline styles it set.
 */
function liftForSettle(board: HTMLElement, dropped: HTMLElement | undefined): () => void {
  const bodies = Array.from(board.querySelectorAll<HTMLElement>('[data-kanban-scroll]')).filter(
    body => body.scrollTop === 0 && body.scrollHeight <= body.clientHeight + 1,
  )
  for (const body of bodies) body.style.overflowY = 'visible'
  // The settling card passes over its neighbours (and other columns) on the way to its slot.
  if (dropped) dropped.style.zIndex = 'var(--z-local)'
  return () => {
    for (const body of bodies) body.style.removeProperty('overflow-y')
    dropped?.style.removeProperty('z-index')
  }
}

/**
 * The board. Renders the supplied `columns` and buckets tiles strictly by
 * `task.column` (placement is independent from the status badge); a tile whose
 * column id matches none of the active columns falls back to the first column.
 * The "New Task" composer lives at the top of the first column (opened from its
 * header "+") — creating a parent session drops a named tile there.
 *
 * Drag (spec §6.3): the lifted clone follows the pointer 1:1 on elev-3 with a small tilt; a 4px
 * accent bar marks where the card will land; on drop the card settles on the gesture spring and
 * its neighbours glide on `base`. The dnd logic itself (sensors, collision, onMoveTask) is unchanged.
 */
export function KanbanBoard({
  columns,
  tasks,
  projectsById,
  statusesById,
  statuses,
  onChangeStatus,
  treatment = 'stripe-tint',
  expandedTaskIds,
  onTaskClick,
  onEditTask,
  onToggleSubtasks,
  onSubtaskClick,
  onAddSubtask,
  onRunSubtasks,
  subtaskModelGroups,
  defaultSubtaskModel,
  onCreateTask,
  onMoveTask,
  columnDropStatus,
  onSelectDropStatus,
  onUpdateColumn,
  onRemoveColumn,
  onAddColumn,
}: KanbanBoardProps) {
  const { t } = useTranslation()
  const firstColumnId = columns[0]?.id

  const tasksByColumn = React.useMemo(() => {
    const known = new Set(columns.map(c => c.id))
    const buckets = new Map<KanbanColumnId, KanbanTask[]>()
    for (const c of columns) buckets.set(c.id, [])
    for (const task of tasks) {
      // A tile whose persisted column no longer exists falls back to the first column.
      const target = known.has(task.column) ? task.column : firstColumnId
      if (target === undefined) continue
      buckets.get(target)!.push(task)
    }
    for (const list of buckets.values()) list.sort((a, b) => taskRecency(b) - taskRecency(a))
    return buckets
  }, [tasks, columns, firstColumnId])

  const columnColors = useKanbanColumnColors()

  const [activeId, setActiveId] = React.useState<string | null>(null)
  // 5px threshold so a click-to-open isn't read as a drag; the sensor also skips
  // elements marked data-no-dnd (chevron toggle, "Add subtask" composer).
  const sensors = useSensors(useSensor(SmartPointerSensor, { activationConstraint: { distance: 5 } }))

  const activeTask = activeId ? tasks.find(t => t.id === activeId) ?? null : null

  // Where the dragged card would land in each column it doesn't already sit in: its recency slot
  // (the same ordering tasksByColumn applies), so the drop bar shows the real destination.
  const dropIndexByColumn = React.useMemo(() => {
    if (!activeTask) return null
    const recency = taskRecency(activeTask)
    const map = new Map<KanbanColumnId, number>()
    for (const [columnId, list] of tasksByColumn) {
      if (list.some(task => task.id === activeTask.id)) continue
      map.set(columnId, list.filter(task => taskRecency(task) > recency).length)
    }
    return map
  }, [activeTask, tasksByColumn])

  // ---- drop motion (visual only): settle the dropped card, glide its neighbours ----
  const boardRef = React.useRef<HTMLDivElement>(null)
  const overlayRef = React.useRef<HTMLDivElement>(null)
  const pendingSettleRef = React.useRef<PendingSettle | null>(null)
  /** Undo for the running settle's inline styles; a newer drop runs it before starting its own. */
  const undoLiftRef = React.useRef<(() => void) | null>(null)

  const tileElements = React.useCallback(
    () => Array.from(boardRef.current?.querySelectorAll<HTMLElement>('[data-kanban-tile]') ?? []),
    [],
  )

  /** Measure before the drop commits: the release box and every tile's current position. */
  const captureSettle = React.useCallback(
    (taskId: string) => {
      const overlay = overlayRef.current
      if (!overlay) return
      const tiles = tileElements()
      // An interrupted glide keeps its visual position: snapshot while its in-flight transform still
      // applies, then cancel it, so the next glide starts where the tile is on screen.
      const rects = snapshotRects(tiles)
      cancelFlip(tiles)
      pendingSettleRef.current = { taskId, released: overlay.getBoundingClientRect(), tiles: rects }
    },
    [tileElements],
  )

  // After the commit that ends the drag (overlay gone, tile re-rendered in its column), before paint.
  React.useLayoutEffect(() => {
    const pending = pendingSettleRef.current
    const board = boardRef.current
    if (!pending || activeId !== null || !board) return
    pendingSettleRef.current = null
    undoLiftRef.current?.()
    undoLiftRef.current = null
    const tiles = tileElements()
    const dropped = tiles.find(el => el.dataset.kanbanTile === pending.taskId)
    // Measure which columns scroll before any transform starts (transforms add scrollable overflow).
    const undoLift = liftForSettle(board, dropped)
    const animations = playFlip(
      pending.tiles,
      tiles.filter(el => el !== dropped).map(el => ({ el })),
      { spring: SPRING.base },
    )
    const settle = dropped ? settleDroppedTile(dropped, pending.released) : null
    if (settle) animations.push(settle)
    if (animations.length === 0) {
      undoLift()
      return
    }
    undoLiftRef.current = undoLift
    // Finished or cancelled (a newer drop cancels the glide first): restore, unless superseded.
    void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
      if (undoLiftRef.current !== undoLift) return
      undoLift()
      undoLiftRef.current = null
    })
  })

  const handleDragStart = React.useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id))
  }, [])

  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      captureSettle(String(active.id))
      setActiveId(null)
      if (!over) return
      const toColumn = over.id as KanbanColumnId
      const task = tasks.find(t => t.id === String(active.id))
      if (!task || task.column === toColumn) return
      onMoveTask?.(String(active.id), toColumn)
    },
    [tasks, onMoveTask, captureSettle]
  )

  const handleDragCancel = React.useCallback(() => {
    if (activeId) captureSettle(activeId)
    setActiveId(null)
  }, [activeId, captureSettle])

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={boardCollisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div
        ref={boardRef}
        className={cn(
          'flex h-full gap-3 overflow-x-auto px-4 pt-1 pb-4',
          // Compact shell (spec §7.16): full-width columns stacked vertically, and the board scrolls
          // instead of each column. Narrow desktop split panels keep the row and scroll sideways.
          '@max-mobile/shell:flex-col @max-mobile/shell:overflow-x-hidden @max-mobile/shell:overflow-y-auto @max-mobile/shell:px-3'
        )}
      >
        {columns.map((column, index) => (
          <KanbanColumn
            key={column.id}
            column={column}
            // Custom columns carry their own accent; built-ins resolve from the global color hook.
            color={column.color ? makeColumnColor(column.color) : columnColors.get(column.id)}
            tasks={tasksByColumn.get(column.id) ?? []}
            projectsById={projectsById}
            statusesById={statusesById}
            statuses={statuses}
            onChangeStatus={onChangeStatus}
            treatment={treatment}
            expandedTaskIds={expandedTaskIds}
            onTaskClick={onTaskClick}
            onEditTask={onEditTask}
            onToggleSubtasks={onToggleSubtasks}
            onSubtaskClick={onSubtaskClick}
            onAddSubtask={onAddSubtask}
            onRunSubtasks={onRunSubtasks}
            subtaskModelGroups={subtaskModelGroups}
            defaultSubtaskModel={defaultSubtaskModel}
            onCreateTask={index === 0 ? onCreateTask : undefined}
            dropStatusId={column.dropStatusId ?? columnDropStatus?.[column.id]}
            // Built-in columns are named after statuses (todo · in-progress · done)
            homeStatusId={column.dropStatusId ?? columnDropStatus?.[column.id] ?? (BUILT_IN_COLUMN_IDS.has(column.id) ? column.id : undefined)}
            onSelectDropStatus={
              onSelectDropStatus ? statusId => onSelectDropStatus(column.id, statusId) : undefined
            }
            onRename={onUpdateColumn ? name => onUpdateColumn(column.id, { name }) : undefined}
            onSetColor={onUpdateColumn ? color => onUpdateColumn(column.id, { color }) : undefined}
            // Guard against removing the last column — the board must always keep one.
            onRemove={onRemoveColumn && columns.length > 1 ? () => onRemoveColumn(column.id) : undefined}
            dropIndicatorIndex={dropIndexByColumn?.get(column.id)}
          />
        ))}
        {onAddColumn && (
          <IconButton
            size="lg"
            icon={<Plus />}
            aria-label={t('kanban.column.add')}
            tooltip
            onClick={onAddColumn}
            className="self-start bg-fill-hover hover:bg-fill-pressed"
          />
        )}
      </div>

      {/* position:fixed overlay clone — escapes the column's overflow clipping.
          dropAnimation is disabled: on a cross-column drop the source tile is
          gone (it re-renders into the target), so a "fly back" would be wrong —
          the settle runs on the re-rendered tile instead (settleDroppedTile). */}
      <DragOverlay dropAnimation={null} style={{ zIndex: 'var(--z-floating-menu, 400)' }}>
        {activeTask ? (
          <div ref={overlayRef} style={{ rotate: `calc(${DRAG_TILT_DEG}deg * var(--motion-scale))` }}>
            <TaskTile
              task={activeTask}
              project={activeTask.projectId ? projectsById.get(activeTask.projectId) : undefined}
              status={statusesById.get(activeTask.statusId)}
              treatment={treatment}
              expanded={expandedTaskIds.has(activeTask.id)}
              dragOverlay
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
