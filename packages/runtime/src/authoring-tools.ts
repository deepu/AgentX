// The kernel's `playbooks.*` tools (20 §3): what the meta playbooks' steps call. The system
// steps call `playbooks.check_draft` and `playbooks.publish_draft`; the chat tools'
// definitions (`playbooks.vocabulary` ... `playbooks.check`) are what a conversation step lists
// under `tools.allowed`, so its checks know their names and effect classes. They execute too,
// through the same Authoring the app uses.
import type { Diagnostic } from '@memwise/defs';
import type { ToolDefinition } from '@memwise/gateway';
import type pg from 'pg';
import type { Actor, Authoring } from './types.ts';

export const AUTHORING_PLUGIN = 'memwise';
export const CHECK_DRAFT_TOOL = 'playbooks.check_draft';
export const PUBLISH_DRAFT_TOOL = 'playbooks.publish_draft';
/** Tools a chat may be offered; `playbooks.publish_draft` never is (only the publish step calls it). */
export const CHAT_TOOLS = ['playbooks.vocabulary', 'playbooks.read', 'playbooks.write', 'playbooks.diff', 'playbooks.check'] as const;

/** What `playbooks.check_draft` returns; the check step writes these into the case. */
export interface CheckDraftResult {
  outcome: 'passed' | 'failed';
  hash: string;
  errors: number;
  warnings: number;
  examples_failed: number;
  summary: string;
}

const str = { type: 'string' } as const;
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });

/** Who acts in a tool call: the person the step acts for, else the kernel itself. */
const actorOf = (onBehalfOf?: string): Actor => (onBehalfOf ? { kind: 'person', personId: onBehalfOf, roles: [] } : { kind: 'system' });
const errorsOf = (ds: Diagnostic[]) => ds.filter((d) => d.severity === 'error').length;

/**
 * The `playbooks.*` tools. Without an Authoring (`memwise check`, example cases that stub them)
 * they are definitions only: names, classes and schemas, and executing one says why it can't.
 */
export function authoringTools(authoring?: () => Authoring | undefined, pool?: () => pg.Pool): ToolDefinition[] {
  const source = { plugin: AUTHORING_PLUGIN };
  const need = (): Authoring => {
    const a = authoring?.();
    if (!a) throw new Error('playbooks tools need a kernel with a project folder');
    return a;
  };

  const checkDraft: ToolDefinition<{ draft: string }, CheckDraftResult> = {
    name: CHECK_DRAFT_TOOL,
    description: 'Check a draft playbook: structure and policy checks, its example cases, past cases replayed, and what publishing would change. Writes report.json.',
    inputSchema: object({ draft: { ...str, description: 'The draft id' } }, ['draft']),
    effect: 'read',
    source,
    async execute({ draft }) {
      const report = await need().check(draft);
      return {
        outcome: report.outcome, hash: report.hash, errors: report.errors, warnings: report.warnings,
        examples_failed: report.examples.filter((e) => e.status === 'fail').length, summary: report.summary,
      };
    },
  };

  const publishDraft: ToolDefinition<{ draft: string; hash: string }> = {
    name: PUBLISH_DRAFT_TOOL,
    description: 'Publish a checked draft as the next version of its playbook, if it has not changed since it was checked.',
    inputSchema: object({ draft: { ...str, description: 'The draft id' }, hash: { ...str, description: 'The content hash the check approved' } }, ['draft', 'hash']),
    effect: 'write',
    idempotent: true,
    source,
    async execute({ draft, hash }, ctx) {
      // The approver is whoever approved this change run's review; recorded as published_by.
      const runId = ctx.token.runId;
      const p = pool?.();
      const approved = p ? await p.query(
        `select decided_by from mw.step_runs where run_id = $1 and outcome = 'approved' and decided_by is not null
          order by finished_at desc nulls last, started_at desc limit 1`, [runId]) : undefined;
      const by = approved?.rows[0]?.decided_by as string | undefined;
      const r = await need().publish(draft, { hash, source: 'app', runId, ...(by ? { by } : {}) });
      if (r.status === 'published') return { outcome: 'published', version: r.version, workflow: r.workflowId, hash: r.hash };
      if (r.status === 'stale') return { outcome: 'stale', message: r.message };
      // A conflict or a failure is not an outcome the shape routes: the step goes to a person.
      throw new Error(r.message);
    },
  };

  const vocabulary: ToolDefinition<Record<string, never>> = {
    name: 'playbooks.vocabulary',
    description: 'What a playbook may use: bound tools with their effect classes, entity types, roles, model roles, value types and the playbooks there are.',
    inputSchema: object({}, []),
    effect: 'read',
    source,
    execute: () => need().vocabulary(),
  };

  const read: ToolDefinition<{ draft?: string; workflow?: string; path?: string }> = {
    name: 'playbooks.read',
    description: 'List or read the files of a live playbook (and domain/), or of a draft.',
    inputSchema: object({ draft: str, workflow: str, path: { ...str, description: 'Project-relative, e.g. workflows/client-intake/steps/check.md' } }, []),
    effect: 'read',
    source,
    execute: ({ draft, workflow, path }) => need().read({ ...(draft ? { draftId: draft } : {}), ...(workflow ? { workflowId: workflow } : {}), ...(path ? { path } : {}) }),
  };

  const write: ToolDefinition<{ draft: string; files: { path: string; content: string | null }[]; summary: string }> = {
    name: 'playbooks.write',
    description: 'Write (or delete, content null) whole files in a draft, as one edit; returns the checks after the edit.',
    inputSchema: object({
      draft: str,
      files: { type: 'array', items: object({ path: str, content: { type: ['string', 'null'] } }, ['path', 'content']) },
      summary: { ...str, description: 'One line, plain words: what this edit does' },
    }, ['draft', 'files', 'summary']),
    effect: 'draft',
    source,
    async execute({ draft, files, summary }, ctx) {
      const r = await need().write({ draftId: draft, files, summary, via: 'chat' }, actorOf(ctx.token.onBehalfOf));
      return { edit: r.edit.id, errors: errorsOf(r.diagnostics), diagnostics: r.diagnostics };
    },
  };

  const diff: ToolDefinition<{ draft: string }> = {
    name: 'playbooks.diff',
    description: 'What a draft changes compared with the live playbook: file diffs and the structural change.',
    inputSchema: object({ draft: str }, ['draft']),
    effect: 'read',
    source,
    execute: ({ draft }) => need().diff(draft),
  };

  const check: ToolDefinition<{ draft: string }> = {
    name: 'playbooks.check',
    description: 'Check a draft: structure and policy checks, example cases, past cases replayed, impact.',
    inputSchema: object({ draft: str }, ['draft']),
    effect: 'read',
    source,
    execute: ({ draft }) => need().check(draft),
  };

  return [checkDraft, publishDraft, vocabulary, read, write, diff, check];
}

/** The `playbooks.*` definitions alone, for checks (`memwise check`) and for stubbing in example cases. */
export function authoringToolDefinitions(): ToolDefinition[] {
  return authoringTools();
}
