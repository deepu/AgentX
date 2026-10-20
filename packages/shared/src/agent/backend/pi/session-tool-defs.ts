/**
 * Pi Session Tool Proxy Definitions
 *
 * Thin wrapper around the canonical tool definitions in @memwise/session-tools-core.
 * Adds the `mcp__session__` prefix that the Pi SDK expects.
 */

import {
  getToolDefsAsJsonSchema,
  SESSION_TOOL_NAMES,
  type JsonSchemaToolDef,
} from '@memwise/session-tools-core';
import { FEATURE_FLAGS } from '../../../feature-flags.ts';
import { isDecisionFeatureActive } from '../../../decisions/resolve.ts';

export type SessionToolProxyDef = JsonSchemaToolDef;

export { SESSION_TOOL_NAMES };

export function getSessionToolProxyDefs(opts?: {
  /** Per session: the MemWise playbook_* tools, for chats anchored to a conversation step. */
  includePlaybookTools?: boolean;
}): SessionToolProxyDef[] {
  return getToolDefsAsJsonSchema({
    includePlaybookTools: opts?.includePlaybookTools ?? false,
    prefix: 'mcp__session__',
    includeDeveloperFeedback: FEATURE_FLAGS.developerFeedback,
    // Same gate as the Claude path (session-scoped-tools.ts): advertise `decide`
    // only while the decision layer is on.
    includeDecide: isDecisionFeatureActive('decideTool'),
  });
}
