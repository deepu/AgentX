/**
 * The map's "proposed change" mode (05 §9): the draft's playbook with what the change removes
 * drawn back in from the live playbook, and for every state and edge whether the change adds,
 * changes or removes it. Pure.
 */

import type { MwChangeKind, MwPlaybook, MwStructuralDiff } from '@memwise/shared/protocol'
import { TIMEOUT_EVENT } from './layout'

/** Marks an event key a removed transition takes when the draft reuses the same event elsewhere. */
export const REMOVED_EVENT_SUFFIX = '\u0000removed'

/** The event as written, without the marker. */
export function eventName(key: string): string {
  return key.endsWith(REMOVED_EVENT_SUFFIX) ? key.slice(0, -REMOVED_EVENT_SUFFIX.length) : key
}

export interface ChangeMap {
  /** The playbook to lay out: the draft plus removed states and transitions. */
  playbook: MwPlaybook
  /** state id → its change (absent: unchanged). */
  states: Record<string, MwChangeKind>
  /** `from>to` → the change of the edge (absent: unchanged). */
  edges: Record<string, MwChangeKind>
}

/**
 * Merges the live playbook's removed states and transitions into the draft's, so the map can draw
 * them red and dashed where they were. Without the live playbook only the draft is drawn.
 */
export function mergeForChange(draft: MwPlaybook, diff: MwStructuralDiff, live?: MwPlaybook | null): ChangeMap {
  const states = draft.states.map(s => ({ ...s, on: { ...s.on }, ...(s.wait ? { wait: { ...s.wait } } : {}) }))
  const steps = { ...draft.steps }
  const byId = new Map(states.map(s => [s.id, s]))

  if (live) {
    // Removed states go back in where the live playbook had them (after their predecessor).
    for (const [i, state] of live.states.entries()) {
      if (byId.has(state.id)) continue
      if (diff.states[state.id] !== 'removed') continue
      const copy = { ...state, on: {} as Record<string, string> }
      const before = live.states[i - 1]?.id
      const at = before ? states.findIndex(s => s.id === before) : -1
      states.splice(at === -1 ? states.length : at + 1, 0, copy)
      byId.set(copy.id, copy)
      if (state.stepId && live.steps[state.stepId] && !steps[state.stepId]) steps[state.stepId] = live.steps[state.stepId]!
    }
  }

  for (const tr of diff.transitions) {
    if (tr.change !== 'removed') continue
    const from = byId.get(tr.from)
    if (!from) continue
    if (tr.event === TIMEOUT_EVENT && !from.wait?.timeout) {
      const afterMs = live?.states.find(s => s.id === tr.from)?.wait?.timeout?.afterMs ?? 0
      from.wait = { ...(from.wait ?? {}), timeout: { afterMs, target: tr.to } }
      continue
    }
    const key = from.on[tr.event] === undefined ? tr.event : `${tr.event}${REMOVED_EVENT_SUFFIX}`
    if (from.on[key] === undefined) from.on[key] = tr.to
  }

  const playbook: MwPlaybook = { ...draft, states, steps }

  // Edge changes: an edge whose every event was added is added, every event removed is removed,
  // any other mix (some events changed) is changed.
  const perEdge = new Map<string, { added: number; removed: number; total: number }>()
  const count = (from: string, to: string) => {
    const key = `${from}>${to}`
    let entry = perEdge.get(key)
    if (!entry) perEdge.set(key, (entry = { added: 0, removed: 0, total: 0 }))
    return entry
  }
  for (const state of states) {
    for (const [key, to] of Object.entries(state.on)) {
      const event = eventName(key)
      const entry = count(state.id, to)
      entry.total++
      const tr = diff.transitions.find(x => x.from === state.id && x.event === event && x.to === to)
      if (tr?.change === 'added') entry.added++
      if (tr?.change === 'removed') entry.removed++
    }
    const timeout = state.wait?.timeout
    if (timeout) {
      const entry = count(state.id, timeout.target)
      entry.total++
      const tr = diff.transitions.find(x => x.from === state.id && x.event === TIMEOUT_EVENT && x.to === timeout.target)
      if (tr?.change === 'added') entry.added++
      if (tr?.change === 'removed') entry.removed++
    }
  }
  const edges: Record<string, MwChangeKind> = {}
  for (const [key, e] of perEdge) {
    if (e.added === e.total) edges[key] = 'added'
    else if (e.removed === e.total) edges[key] = 'removed'
    else if (e.added || e.removed) edges[key] = 'changed'
  }

  const stateChanges: Record<string, MwChangeKind> = {}
  for (const [id, change] of Object.entries(diff.states)) if (byId.has(id)) stateChanges[id] = change
  // A step whose file changed shows as changed even when its state's routes did not.
  for (const [id, step] of Object.entries(diff.steps)) if (byId.has(id) && !stateChanges[id]) stateChanges[id] = step.change

  return { playbook, states: stateChanges, edges }
}
