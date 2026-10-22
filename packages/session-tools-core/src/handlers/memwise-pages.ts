/**
 * MemWise page tool handlers (docs/memwise/26-projects-and-pages.md §4): page_get / page_update /
 * page_create, for a chat anchored to a page.
 *
 * They act as the person in the chat. Every write is a new version of the page that says it came
 * from this chat, with Undo on the page; a draft changes freely, a kept page too (in a regulated
 * project a kept page is refused: it changes through a change request). The page's body is page
 * data other people and refreshes wrote, so reads are wrapped as untrusted content. All logic
 * lives behind the injected ctx.memwisePages callbacks (server-core memwise/chat-tools.ts).
 */

import type { PageCreateInput, PageGetInput, PageUpdateInput, SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';
import { untrustedRecordData } from './records.ts';

const PAGES_UNAVAILABLE = 'Page tools are only available in a chat opened on a MemWise page.';
const BODY_MAX = 200_000;

function toError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

export async function handlePageGet(ctx: SessionToolContext, args: PageGetInput): Promise<ToolResult> {
  if (!ctx.memwisePages) return errorResponse(PAGES_UNAVAILABLE);
  try {
    return successResponse(untrustedRecordData(await ctx.memwisePages.get({ ...(args?.page?.trim() ? { page: args.page.trim() } : {}) })));
  } catch (error) {
    return errorResponse(`Could not read the page: ${toError(error)}`);
  }
}

export async function handlePageUpdate(ctx: SessionToolContext, args: PageUpdateInput): Promise<ToolResult> {
  if (!ctx.memwisePages) return errorResponse(PAGES_UNAVAILABLE);
  const body = typeof args?.body === 'string' ? args.body : undefined;
  const title = typeof args?.title === 'string' && args.title.trim() ? args.title.trim() : undefined;
  if (body === undefined && !title) return errorResponse('body or title is required: the whole new body (markdown), or a new title.');
  if (body !== undefined && body.length > BODY_MAX) return errorResponse(`The body is too long (${body.length} characters; at most ${BODY_MAX}).`);
  try {
    const result = await ctx.memwisePages.update({
      ...(args?.page?.trim() ? { page: args.page.trim() } : {}),
      ...(title ? { title } : {}), ...(body !== undefined ? { body } : {}),
      ...(args?.reason?.trim() ? { reason: args.reason.trim() } : {}),
    });
    if (!result.applied) return errorResponse(`Not saved: ${result.message ?? 'the page refused it'}`);
    return successResponse(JSON.stringify({ ...result, summary: 'Saved as a new version of the page; the person can Undo it on the page.' }, null, 2));
  } catch (error) {
    return errorResponse(`Could not change the page: ${toError(error)}`);
  }
}

export async function handlePageCreate(ctx: SessionToolContext, args: PageCreateInput): Promise<ToolResult> {
  if (!ctx.memwisePages) return errorResponse(PAGES_UNAVAILABLE);
  const title = typeof args?.title === 'string' ? args.title.trim() : '';
  if (!title) return errorResponse('title is required.');
  if (typeof args.body === 'string' && args.body.length > BODY_MAX) return errorResponse(`The body is too long (at most ${BODY_MAX} characters).`);
  try {
    const result = await ctx.memwisePages.create({
      title,
      ...(typeof args.body === 'string' ? { body: args.body } : {}),
      ...(args.question?.trim() ? { question: args.question.trim() } : {}),
      ...(args.parent?.trim() ? { parent: args.parent.trim() } : {}),
    });
    if (!result.applied) return errorResponse(`Not made: ${result.message ?? 'the project refused it'}`);
    return successResponse(JSON.stringify({ ...result, summary: `Made the draft page "${title}". It stays a draft until the person keeps it.` }, null, 2));
  } catch (error) {
    return errorResponse(`Could not make the page: ${toError(error)}`);
  }
}
