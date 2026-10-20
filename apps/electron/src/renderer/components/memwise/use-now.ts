/**
 * The current time for relative times ("3 minutes ago"), refreshed every 30 seconds so they keep
 * up while a screen stays open. One timer for every screen that uses it, running only while one
 * does.
 */

import { useSyncExternalStore } from 'react'

const TICK_MS = 30_000

let now = Date.now()
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!timer) {
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      for (const l of listeners) l()
    }, TICK_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

/** Between uses the time goes stale; refreshed (at most once a tick) so a screen opened later starts right. */
function getSnapshot(): number {
  if (!timer && Date.now() - now >= TICK_MS) now = Date.now()
  return now
}
const getServerSnapshot = getSnapshot

/** `fixed` (tests, the playground) wins; otherwise the shared ticking time. */
export function useNow(fixed?: number): number {
  const ticking = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return fixed ?? ticking
}
