import type { SessionToolContext, ProjectMemoryAppendInput } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export type ProjectMemoryAppendArgs = ProjectMemoryAppendInput;

/**
 * project_memory_append — add a dated note to the session's project MEMORY.md.
 * Append-only by design: sessions that rewrote the file from their start-of-session
 * snapshot dropped notes other sessions had added meanwhile. The file write lives
 * behind ctx.appendProjectMemory (projects storage in @memwise/shared).
 */
export async function handleProjectMemoryAppend(
  ctx: SessionToolContext,
  args: ProjectMemoryAppendArgs
): Promise<ToolResult> {
  if (!ctx.appendProjectMemory) {
    return errorResponse('project_memory_append is not available in this context.');
  }
  if (!args.note?.trim()) {
    return errorResponse('note is required.');
  }

  try {
    const result = await ctx.appendProjectMemory(args);
    return successResponse(`Added to ${result.path} under "## ${result.heading}".`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to add the note: ${message}`);
  }
}
