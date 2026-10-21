/**
 * Stage 4 (docs/memwise/26-projects-and-pages.md §2, D123): the filter a list's chat put on the
 * list (`records_filter`), per person and record type. The list's page shows it as chips above the
 * rows with "Save as a page"; × clears it. It is the chat's view of the list, not a saved one, so
 * it lives with the running app and is gone after a restart (saving it makes it a page).
 */
import type { MwRecordsChatFilter } from '@memwise/shared/protocol'

const filters = new Map<string, MwRecordsChatFilter>()
const keyOf = (personId: string, entity: string) => `${personId}\u0000${entity}`

export function setRecordsChatFilter(f: Omit<MwRecordsChatFilter, 'at'> & { personId: string }): MwRecordsChatFilter {
  const { personId, ...rest } = f
  const value: MwRecordsChatFilter = { ...rest, at: new Date().toISOString() }
  filters.set(keyOf(personId, f.entity), value)
  return value
}

export function getRecordsChatFilter(personId: string, entity: string): MwRecordsChatFilter | null {
  return filters.get(keyOf(personId, entity)) ?? null
}

export function clearRecordsChatFilter(personId: string, entity: string): boolean {
  return filters.delete(keyOf(personId, entity))
}
