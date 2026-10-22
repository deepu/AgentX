import { describe, it, expect } from 'bun:test'
import type { ClientRect, DroppableContainer, UniqueIdentifier } from '@dnd-kit/core'
import { recordsBoardCollision } from '../project/pages/records-board-collision'

const rect = (left: number, top: number, width: number, height: number): ClientRect => ({
  left, top, width, height, right: left + width, bottom: top + height,
})

function detect(columns: Record<string, ClientRect>, dragged: ClientRect, pointer: { x: number; y: number }) {
  const droppableRects = new Map<UniqueIdentifier, ClientRect>(Object.entries(columns))
  const droppableContainers = Object.keys(columns).map(id => ({ id, disabled: false, data: { current: undefined } }) as unknown as DroppableContainer)
  return recordsBoardCollision({
    active: { id: 'card', data: { current: undefined }, rect: { current: { initial: dragged, translated: dragged } } },
    collisionRect: dragged,
    droppableRects,
    droppableContainers,
    pointerCoordinates: pointer,
  } as Parameters<typeof recordsBoardCollision>[0])[0]?.id
}

describe('recordsBoardCollision (Stage 4 record boards)', () => {
  // Documents: an empty Rejected column beside a Filed column with 63 cards.
  const columns = {
    in_qc: rect(1008, 337, 115, 1400),
    rejected: rect(1131, 337, 68, 30),
    filed: rect(1207, 337, 107, 7000),
  }

  it('drops on the tall column under the pointer, not the short neighbour', () => {
    const dragged = rect(1210, 360, 100, 120)
    expect(detect(columns, dragged, { x: 1260, y: 397 })).toBe('filed')
  })

  it('drops on the short column when the pointer is on it', () => {
    const dragged = rect(1120, 330, 100, 120)
    expect(detect(columns, dragged, { x: 1160, y: 350 })).toBe('rejected')
  })

  it('falls back to the closest column in a gap', () => {
    const dragged = rect(1150, 360, 100, 120)
    expect(detect(columns, dragged, { x: 1203, y: 397 })).toBeDefined()
  })
})
