import { pointerWithin, type CollisionDetection } from '@dnd-kit/core'
import { boardCollisionDetection } from '../../../app-shell/kanban/board-collision'

/**
 * A record board's columns are as tall as their cards (Filed with 63, Rejected with none), so
 * corner distance can pick a short neighbour over the tall column under the pointer: there the
 * column under the pointer wins, and the kanban's rule decides in the gaps between columns.
 */
export const recordsBoardCollision: CollisionDetection = args => {
  const under = pointerWithin(args)
  return under.length > 0 ? under : boardCollisionDetection(args)
}
