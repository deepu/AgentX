/**
 * The process's MemWise kernel host (19 §9). DBOS is process-wide, so there is one service per
 * process; the RPC handlers find it here. Kept free of kernel imports so the handlers (and the
 * registration tests that load them) never pull in the kernel until it is started.
 */
import type { MwChange, MwDiagnostic } from '@memwise/shared/protocol'
import type { MemwiseService } from './service'

export type MemwisePhase = 'off' | 'starting' | 'ready' | 'failed' | 'stopped'

export interface MemwiseHostStatus {
  phase: MemwisePhase
  /** Plain words for the status screen. */
  message?: string
  projectDir?: string
  modelConfigured: boolean
  diagnostics: MwDiagnostic[]
}

type ChangeListener = (change: MwChange) => void

let current: MemwiseService | null = null
let status: MemwiseHostStatus = {
  phase: 'off',
  message: 'Playbooks are not running in this app.',
  modelConfigured: false,
  diagnostics: [],
}
const listeners = new Set<ChangeListener>()

export function getMemwiseService(): MemwiseService | null {
  return current
}

export function setMemwiseService(service: MemwiseService | null): void {
  current = service
}

export function getMemwiseHostStatus(): MemwiseHostStatus {
  return status
}

export function setMemwiseHostStatus(next: Partial<MemwiseHostStatus>): void {
  status = { ...status, ...next }
  emitMemwiseChange({ kind: 'status' })
}

/** Changes the screens should refetch on; survives the service being restarted. */
export function onMemwiseChange(listener: ChangeListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function emitMemwiseChange(change: MwChange): void {
  for (const l of listeners) {
    try { l(change) } catch { /* a listener's failure is its own */ }
  }
}

/** Test seam: forget the service and status between tests. */
export function resetMemwiseHost(): void {
  current = null
  status = { phase: 'off', message: 'Playbooks are not running in this app.', modelConfigured: false, diagnostics: [] }
}
