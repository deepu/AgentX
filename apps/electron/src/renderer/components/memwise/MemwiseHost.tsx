/**
 * Mounted once by the app shell: keeps the MemWise lists in sync for the active workspace
 * and hosts the dialogs any MemWise screen can open.
 */

import { useMemwiseData } from '@/hooks/useMemwise'
import { StartCaseDialog } from './StartCaseDialog'

export function MemwiseHost({ workspaceId }: { workspaceId: string | null | undefined }) {
  useMemwiseData(workspaceId)
  return <StartCaseDialog />
}
