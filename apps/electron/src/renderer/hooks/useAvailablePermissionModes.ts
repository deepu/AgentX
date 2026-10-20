import { useMemo } from 'react'
import { useAtomValue } from 'jotai'
import { availablePermissionModes, type PermissionMode } from '@memwise/shared/agent/modes'
import { guardedModeAvailableAtom } from '@/atoms/permission-modes'

/**
 * Modes a picker offers, strictest → loosest. Guarded appears while its feature is
 * on, or when it is `current` (a session left in it can still see and leave it).
 * The array is stable between renders until either input changes.
 */
export function useAvailablePermissionModes(current?: PermissionMode): PermissionMode[] {
  const guardedAvailable = useAtomValue(guardedModeAvailableAtom)
  return useMemo(() => availablePermissionModes(guardedAvailable, current), [guardedAvailable, current])
}
