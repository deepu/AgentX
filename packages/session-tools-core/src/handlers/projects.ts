/**
 * MemWise project tool handlers (docs/memwise/26-projects-and-pages.md §3): project_options and
 * project_draft, for a chat answering an app's create-project step ("Describe it in chat").
 * They act as the person in the chat through the injected ctx.memwise callbacks (server-core
 * memwise/chat-tools.ts); this package stays free of @memwise/* imports.
 */

import type { ProjectDraftInput, SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

const PROJECT_TOOLS_UNAVAILABLE =
  'Project tools are only available in a chat that makes a new project (opened from "Describe it in chat" in New project).';

function toError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

export type ProjectOptionsArgs = Record<string, never>;

export async function handleProjectOptions(ctx: SessionToolContext, _args: ProjectOptionsArgs): Promise<ToolResult> {
  if (!ctx.memwise?.projectOptions) return errorResponse(PROJECT_TOOLS_UNAVAILABLE);
  try {
    return successResponse(JSON.stringify(await ctx.memwise.projectOptions(), null, 2));
  } catch (error) {
    return errorResponse(`Could not list what a project can start from: ${toError(error)}`);
  }
}

export type ProjectDraftArgs = ProjectDraftInput;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export async function handleProjectDraft(ctx: SessionToolContext, args: ProjectDraftArgs): Promise<ToolResult> {
  if (!ctx.memwise?.projectDraft) return errorResponse(PROJECT_TOOLS_UNAVAILABLE);
  if (str(args?.template) && str(args?.copyFrom)) return errorResponse('Give a template or a project to copy, not both.');
  if (args?.people !== undefined) {
    if (!Array.isArray(args.people)) return errorResponse('people is a list of { email, name?, roles }.');
    for (const p of args.people) {
      if (!p || !str(p.email) || !Array.isArray(p.roles)) return errorResponse('Every person needs an email and a list of roles.');
    }
  }
  if (args?.without !== undefined && (!Array.isArray(args.without) || args.without.some((w) => typeof w !== 'string'))) {
    return errorResponse('without is a list of template paths, e.g. "pages/safety-literature".');
  }
  try {
    const input: ProjectDraftInput = {
      ...(str(args?.name) ? { name: str(args.name) } : {}),
      ...(str(args?.template) ? { template: str(args.template) } : {}),
      ...(str(args?.copyFrom) ? { copyFrom: str(args.copyFrom) } : {}),
      ...(str(args?.study) ? { study: str(args.study) } : {}),
      ...(args?.people ? { people: args.people.map((p) => ({ email: p.email.trim(), roles: p.roles.map(String), ...(str(p.name) ? { name: str(p.name) } : {}), ...(str(p.note) ? { note: str(p.note) } : {}) })) } : {}),
      ...(args?.without ? { without: args.without } : {}),
      ...(args?.settings && typeof args.settings === 'object' ? { settings: args.settings } : {}),
    };
    return successResponse(JSON.stringify(await ctx.memwise.projectDraft(input), null, 2));
  } catch (error) {
    return errorResponse(`Could not draft the project: ${toError(error)}`);
  }
}
