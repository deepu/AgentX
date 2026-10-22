/**
 * MemWise playbook tool handlers (docs/memwise/20-phase-3-interfaces.md §4):
 * playbook_vocabulary / playbook_read / playbook_write / playbook_diff /
 * playbook_check / playbook_finish.
 *
 * The chat that builds or changes a playbook is a conversation step of a meta
 * playbook; these tools act as the person in that chat. Everything they change
 * goes into a draft, never the live playbook. All logic lives behind the
 * injected ctx.memwise callbacks (server-core memwise/chat-tools.ts) — this
 * package must stay dependency-free of @memwise/* (same rule as pages).
 */

import type {
  SessionToolContext,
  PlaybookTestRunInput,
  PlaybookCheckInput,
  PlaybookFinishInput,
  PlaybookReadInput,
  PlaybookWriteInput,
} from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

const MEMWISE_UNAVAILABLE =
  'Playbook tools are only available in a chat that builds or changes a playbook (opened from "New playbook" or "Change with chat").';

function toError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

function json(value: unknown): ToolResult {
  return successResponse(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

export type PlaybookVocabularyArgs = Record<string, never>;

export async function handlePlaybookVocabulary(ctx: SessionToolContext, _args: PlaybookVocabularyArgs): Promise<ToolResult> {
  if (!ctx.memwise) return errorResponse(MEMWISE_UNAVAILABLE);
  try {
    return json(await ctx.memwise.vocabulary());
  } catch (error) {
    return errorResponse(`Could not list what playbooks may use: ${toError(error)}`);
  }
}

export type PlaybookReadArgs = PlaybookReadInput;

export async function handlePlaybookRead(ctx: SessionToolContext, args: PlaybookReadArgs): Promise<ToolResult> {
  if (!ctx.memwise) return errorResponse(MEMWISE_UNAVAILABLE);
  try {
    return json(await ctx.memwise.read({
      ...(args?.path?.trim() ? { path: args.path.trim() } : {}),
      ...(args?.live ? { live: true } : {}),
      ...(args?.playbook?.trim() ? { playbook: args.playbook.trim() } : {}),
    }));
  } catch (error) {
    return errorResponse(`Could not read: ${toError(error)}`);
  }
}

export type PlaybookWriteArgs = PlaybookWriteInput;

export async function handlePlaybookWrite(ctx: SessionToolContext, args: PlaybookWriteArgs): Promise<ToolResult> {
  if (!ctx.memwise) return errorResponse(MEMWISE_UNAVAILABLE);
  if (!Array.isArray(args?.files) || args.files.length === 0) return errorResponse('files is required: at least one { path, content }.');
  if (!args.summary?.trim()) return errorResponse('summary is required: one line saying what this edit does.');
  for (const f of args.files) {
    if (!f || typeof f.path !== 'string' || !f.path.trim()) return errorResponse('Every file needs a path.');
    if (f.content !== null && typeof f.content !== 'string') return errorResponse(`${f.path}: content must be the whole file as text, or null to delete it.`);
  }
  try {
    const result = await ctx.memwise.write({
      files: args.files.map((f) => ({ path: f.path.trim(), content: f.content })),
      summary: args.summary.trim(),
      ...(args.playbook?.trim() ? { playbook: args.playbook.trim() } : {}),
      ...(args.title?.trim() ? { title: args.title.trim() } : {}),
    });
    return json(result);
  } catch (error) {
    return errorResponse(`Could not write: ${toError(error)}`);
  }
}

export type PlaybookDiffArgs = Record<string, never>;

export async function handlePlaybookDiff(ctx: SessionToolContext, _args: PlaybookDiffArgs): Promise<ToolResult> {
  if (!ctx.memwise) return errorResponse(MEMWISE_UNAVAILABLE);
  try {
    return json(await ctx.memwise.diff());
  } catch (error) {
    return errorResponse(`Could not compare the draft: ${toError(error)}`);
  }
}

export type PlaybookCheckArgs = PlaybookCheckInput;

export async function handlePlaybookCheck(ctx: SessionToolContext, args: PlaybookCheckArgs): Promise<ToolResult> {
  if (!ctx.memwise) return errorResponse(MEMWISE_UNAVAILABLE);
  try {
    return json(await ctx.memwise.check({ ...(typeof args?.pastCases === 'number' ? { pastCases: args.pastCases } : {}) }));
  } catch (error) {
    return errorResponse(`Could not check the draft: ${toError(error)}`);
  }
}

export type PlaybookFinishArgs = PlaybookFinishInput;

export async function handlePlaybookFinish(ctx: SessionToolContext, args: PlaybookFinishArgs): Promise<ToolResult> {
  if (!ctx.memwise) return errorResponse(MEMWISE_UNAVAILABLE);
  if (!args?.summary?.trim()) return errorResponse('summary is required: what the change does, in a few plain sentences.');
  try {
    const result = await ctx.memwise.finish({
      summary: args.summary.trim(),
      ...(args.title?.trim() ? { title: args.title.trim() } : {}),
      ...(args.outcome?.trim() ? { outcome: args.outcome.trim() } : {}),
      ...(args.rationale?.trim() ? { rationale: args.rationale.trim() } : {}),
    });
    if (!result.applied) return errorResponse(result.message ?? 'The step could not be finished.');
    return json(result);
  } catch (error) {
    return errorResponse(`Could not finish: ${toError(error)}`);
  }
}

export type PlaybookTestRunArgs = PlaybookTestRunInput;

/** Stage 4 (26 §5): the draft run on one record in a throwaway database; nothing is sent. */
export async function handlePlaybookTestRun(ctx: SessionToolContext, args: PlaybookTestRunArgs): Promise<ToolResult> {
  if (!ctx.memwise) return errorResponse(MEMWISE_UNAVAILABLE);
  if (!ctx.memwise.testRun) return errorResponse('Test runs are not available in this version.');
  if (!args?.record?.trim()) return errorResponse('record is required: the record to run the draft on (its id, or words of its title such as "site 104").');
  try {
    return json(await ctx.memwise.testRun({ record: args.record.trim(), ...(args.entity?.trim() ? { entity: args.entity.trim() } : {}) }));
  } catch (error) {
    return errorResponse(`Could not run the draft: ${toError(error)}`);
  }
}
