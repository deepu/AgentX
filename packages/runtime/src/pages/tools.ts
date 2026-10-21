// The kernel's `page.*` tools (26 §4): what "Refresh a page" (built in, or an app's own) calls.
// `page.get` reads the page as a refresh needs it (its question, its last body, its kept
// sub-pages); `page.compare` is the system step that decides whether the answer changed and, if
// it did, puts the new body up for review; `page.accept_change` and `page.send_back_change` act
// on the reviewer's answer. Without the pages service (`memwise check`, example cases that stub
// them) they are definitions only.
import type { ToolDefinition } from '@memwise/gateway';
import type { PagesCore } from './service.ts';

export const PAGES_PLUGIN = 'memwise';
export const PAGE_GET_TOOL = 'page.get';
export const PAGE_COMPARE_TOOL = 'page.compare';
export const PAGE_ACCEPT_TOOL = 'page.accept_change';
export const PAGE_SEND_BACK_TOOL = 'page.send_back_change';

const str = { type: 'string' } as const;

export function pageTools(core?: () => PagesCore | undefined): ToolDefinition[] {
  const source = { plugin: PAGES_PLUGIN };
  const need = (): PagesCore => {
    const c = core?.();
    if (!c) throw new Error('page tools need the kernel\'s pages');
    return c;
  };

  const get: ToolDefinition<{ page: string }> = {
    name: PAGE_GET_TOOL,
    description: 'Read a page to refresh it: its question, its body now (markdown with fenced blocks), when it was last refreshed, and, for a page that sums up its sub-pages, the kept sub-pages (drafts are listed apart and left out of the summary).',
    inputSchema: { type: 'object', properties: { page: { ...str, description: 'The page id' } }, required: ['page'], additionalProperties: false },
    effect: 'read',
    source,
    execute: ({ page }) => need().forRefresh(page),
  };

  const compare: ToolDefinition<{
    page: string; body: string; title?: string; label?: string; change_title?: string; plus?: string;
    left_out?: { title: string; href?: string; why: string }[]; reason?: string; asked_by?: string;
  }> = {
    name: PAGE_COMPARE_TOOL,
    description: 'Compare a refreshed body with the page (headline, numbers, sections). A material change is kept for review ("Review an answer change") and the outcome is `material`; otherwise the page gets one "nothing new" history line and the outcome is `nothing_new`.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { ...str, description: 'The page id' },
        body: { ...str, description: 'The rewritten body' },
        title: str,
        label: { ...str, description: 'For the waiting list, e.g. "1 new trial"' },
        change_title: { ...str, description: 'For the page\'s history, e.g. "ATTAIN-MAINTAIN added"' },
        plus: { ...str, description: 'When the headline stays: what the change adds, in one sentence' },
        left_out: { type: 'array', items: { type: 'object', properties: { title: str, href: str, why: str }, required: ['title', 'why'] } },
        reason: { ...str, description: 'What started the refresh: schedule, manual or summary' },
        asked_by: str,
      },
      required: ['page', 'body'],
      additionalProperties: false,
    },
    effect: 'write',
    idempotent: true,
    source,
    async execute(args, ctx) {
      return need().compare({
        page: args.page, body: args.body, ...(args.title ? { title: args.title } : {}), ...(args.label ? { label: args.label } : {}),
        ...(args.change_title ? { changeTitle: args.change_title } : {}), ...(args.plus ? { plus: args.plus } : {}),
        ...(args.left_out?.length ? { leftOut: args.left_out } : {}), ...(args.reason ? { reason: args.reason } : {}),
        ...(args.asked_by ? { by: args.asked_by } : {}), runId: ctx.token.runId, caseId: ctx.token.caseId,
      });
    },
  };

  const accept: ToolDefinition<{ change: string }> = {
    name: PAGE_ACCEPT_TOOL,
    description: 'Make an accepted answer change the page\'s current version, with a history line naming who accepted it.',
    inputSchema: { type: 'object', properties: { change: { ...str, description: 'The page change id' } }, required: ['change'], additionalProperties: false },
    effect: 'write',
    idempotent: true,
    source,
    async execute({ change }, ctx) {
      const reviewer = await need().reviewerOf(ctx.token.runId);
      return need().accept(change, reviewer.by ?? 'system', { ...(reviewer.comment ? { comment: reviewer.comment } : {}), via: `run:${ctx.token.runId}` });
    },
  };

  const sendBack: ToolDefinition<{ change: string }> = {
    name: PAGE_SEND_BACK_TOOL,
    description: 'Record that an answer change was sent back: the page keeps its body.',
    inputSchema: { type: 'object', properties: { change: { ...str, description: 'The page change id' } }, required: ['change'], additionalProperties: false },
    effect: 'write',
    idempotent: true,
    source,
    async execute({ change }, ctx) {
      const reviewer = await need().reviewerOf(ctx.token.runId);
      await need().sendBack(change, reviewer.by ?? 'system', reviewer.comment);
      return { done: true };
    },
  };

  return [get, compare, accept, sendBack];
}

/** The page tools as definitions only, for checks and stubs (like `authoringToolDefinitions`). */
export function pageToolDefinitions(): ToolDefinition[] {
  return pageTools();
}
