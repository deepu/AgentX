/**
 * A record type's cards (doc 26 §2, mock `Documents`): one column per lifecycle state, a card per
 * record, built on the kanban board's drag pieces (its pointer sensor and collision rule). Dropping
 * a card on a column asks the record's page which move that is: a move the person may make goes
 * through the gateway (with a reason in a regulated project); a signed move opens the step that
 * signs it; anything else is refused with a short message.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { DndContext, DragOverlay, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core'
import type { MwInboxItem, MwRecordQueryResult } from '@memwise/shared/protocol'
import { SmartPointerSensor } from '@/components/ui/sortable-list'
import { cn } from '@/lib/utils'
import { navigate, routes } from '@/lib/navigate'
import { memwiseInboxAtom, memwiseWorkspaceIdAtom } from '@/atoms/memwise'
import { getMemwiseApi } from '@/hooks/useMemwise'
import { useMemwiseRecordCalls } from '@/hooks/useMemwiseRecords'
import { recordsBoardCollision } from './records-board-collision'
import { humanize } from '../../format'
import { ReasonBox, useReasonedWrite, writeResultMessage } from '../../records/RecordBlocks'
import { useProjectShell } from '../shell-context'
import { boardColumns, dropDecision } from './every-page-model'

type Row = MwRecordQueryResult['rows'][number]

export interface RecordsBoardProps {
  entity: string
  entityName: string
  states: string[]
  rows: Row[]
  regulated: boolean
  /** The card's second and third lines: values worth seeing at a glance. */
  detail?: (row: Row) => string[]
}

export function RecordsBoard({ entity, entityName, states, rows, regulated, detail }: RecordsBoardProps) {
  const { t } = useTranslation()
  const sensors = useSensors(useSensor(SmartPointerSensor, { activationConstraint: { distance: 5 } }))
  const [dragging, setDragging] = React.useState<Row | null>(null)
  const columns = boardColumns(states, rows)
  const move = useReasonedWrite(regulated)
  const calls = useMemwiseRecordCalls()
  const workspaceId = useAtomValue(memwiseWorkspaceIdAtom)
  const inbox = useAtomValue(memwiseInboxAtom)
  const shell = useProjectShell()
  const open = (row: Row) => navigate(routes.view.project(shell?.projectId ?? '', { type: 'record', entity, recordId: row.id }))

  const drop = async (row: Row, to: string) => {
    const api = getMemwiseApi()
    if (!api || !workspaceId) return
    const page = await api.memwiseGetRecordPage(workspaceId, { entity, id: row.id }).catch(() => null)
    if (!page) { toast.error(t('memwise.record.missing')); return }
    const decision = dropDecision(page.status, to, page.lifecycle?.transitions ?? [])
    const target = humanize(to)
    switch (decision.kind) {
      case 'same': return
      case 'move':
        move.write(async reason => {
          const r = await calls.transition({ entity, id: row.id, transition: decision.transition.name, ...(reason ? { reason } : {}) })
          if (r.applied) toast.success(t('memwise.everyPage.moved', { record: row.title, state: target }))
          else if (r.status !== 'reason-required') toast.error(t('memwise.everyPage.cantMove', { state: target }), { description: writeResultMessage(r, t) })
          return r
        })
        return
      case 'sign': {
        const review = signingItem(inbox, entity, row.id)
        if (review) {
          toast(t('memwise.everyPage.signToMove', { state: target }))
          navigate(routes.view.project(shell?.projectId ?? '', { type: 'waiting', itemId: review.id }))
        } else {
          toast.error(t('memwise.everyPage.cantMove', { state: target }), { description: t('memwise.everyPage.needsSignature') })
        }
        return
      }
      case 'refuse':
        toast.error(t('memwise.everyPage.cantMove', { state: target }), {
          description: decision.reason === 'no-move'
            ? t('memwise.everyPage.noSuchMove', { from: humanize(page.status ?? ''), to: target, entity: entityName })
            : decision.reason === 'automatic' ? t('memwise.everyPage.onlyPlaybook', { state: target }) : decision.message ?? t('memwise.everyPage.notYours'),
        })
    }
  }

  const onDragStart = (e: DragStartEvent) => setDragging(rows.find(r => r.id === e.active.id) ?? null)
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null)
    const row = rows.find(r => r.id === e.active.id)
    const to = e.over?.id
    if (row && typeof to === 'string') void drop(row, to)
  }

  return (
    <div data-testid="records-board">
      {move.asking && (
        <div className="mb-3">
          <ReasonBox onConfirm={move.asking} onCancel={move.cancel} busy={move.busy} label={t('memwise.record.reasonForMove')} />
        </div>
      )}
      <DndContext sensors={sensors} autoScroll={false} collisionDetection={recordsBoardCollision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
        <div className="flex gap-2 overflow-x-auto pb-2">
          {columns.map(col => (
            <BoardColumn key={col.state} state={col.state} total={col.total}>
              {col.rows.map(r => <Card key={r.id} row={r} lines={detail?.(r) ?? []} onOpen={() => open(r)} />)}
              {col.total > col.rows.length && <p className="px-1 text-label-sm text-secondary">{t('memwise.everyPage.moreCards', { count: col.total - col.rows.length })}</p>}
            </BoardColumn>
          ))}
        </div>
        <DragOverlay dropAnimation={null}>
          {dragging ? <CardBody row={dragging} lines={detail?.(dragging) ?? []} lifted /> : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
}

/** The inbox item that signs this record (its review step), if one waits for the person. */
function signingItem(inbox: MwInboxItem[] | null, entity: string, id: string): MwInboxItem | undefined {
  return (inbox ?? []).find(i => (i.kind === 'input' || i.kind === 'decision') && !!i.sign && i.review?.kind === 'document' && i.review.entity === entity && i.review.recordId === id)
}

function BoardColumn({ state, total, children }: { state: string; total: number; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: state })
  return (
    <section
      ref={setNodeRef}
      aria-label={humanize(state)}
      data-column={state}
      className={cn(
        'flex flex-col gap-2 self-start rounded-[10px] bg-fill-hover p-2 transition-colors',
        // An empty state stays a narrow drop target, so a lifecycle's columns fit the page.
        total > 0 ? 'min-w-[88px] flex-1 basis-0' : 'w-[68px] flex-none',
        isOver && 'bg-accent-tint/60 outline-dashed outline-1 outline-accent/50',
      )}
    >
      <h3 className="truncate px-1 text-label-sm font-semibold text-foreground" title={humanize(state)}>
        {humanize(state)} <span className="font-normal text-tertiary">{total}</span>
      </h3>
      {children}
    </section>
  )
}

function Card({ row, lines, onOpen }: { row: Row; lines: string[]; onOpen: () => void }) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: row.id })
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} onClick={onOpen} className={cn('cursor-grab', isDragging && 'opacity-40')} data-card={row.id}>
      <CardBody row={row} lines={lines} />
    </div>
  )
}

function CardBody({ row, lines, lifted }: { row: Row; lines: string[]; lifted?: boolean }) {
  return (
    <div className={cn('min-w-0 rounded-[8px] border border-foreground/8 bg-background px-2 py-2 text-label', lifted && 'shadow-elev-2')}>
      <p className="break-words font-medium leading-snug text-foreground [overflow-wrap:anywhere]">{row.title}</p>
      {lines.map((l, i) => <p key={i} className="mt-0.5 line-clamp-2 text-label-sm text-secondary [overflow-wrap:anywhere]">{l}</p>)}
    </div>
  )
}
