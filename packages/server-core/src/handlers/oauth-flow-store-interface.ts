/**
 * IOAuthFlowStore — abstract interface for the pending OAuth flow store.
 *
 * Handlers program against this; concrete implementations satisfy it.
 * See OAuthFlowStore in @memwise/shared/auth for the canonical impl.
 */

import type { PendingOAuthFlow, OAuthFlowWaiter, OAuthFlowOutcome, OAuthFlowStatus } from '@memwise/shared/auth'

export interface IOAuthFlowStore {
  store(flow: PendingOAuthFlow): void
  getByState(state: string): PendingOAuthFlow | null
  getLiveForSource(workspaceId: string, sourceSlug: string): PendingOAuthFlow | null
  join(state: string, waiter: OAuthFlowWaiter): PendingOAuthFlow | null
  remove(state: string, outcome?: OAuthFlowOutcome): PendingOAuthFlow | null
  getStatus(flowId: string, workspaceId: string): OAuthFlowStatus
}
