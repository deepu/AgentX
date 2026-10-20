import { describe, it, expect } from 'bun:test';
import {
  handlePlaybookVocabulary,
  handlePlaybookRead,
  handlePlaybookWrite,
  handlePlaybookDiff,
  handlePlaybookCheck,
  handlePlaybookFinish,
} from './playbooks.ts';
import type { MemwiseToolCallbacks, SessionToolContext } from '../context.ts';
import {
  PLAYBOOK_TOOL_NAMES,
  SESSION_TOOL_REGISTRY,
  getSessionSafeAllowedToolNames,
  getSessionToolDefs,
  getToolDefsAsJsonSchema,
} from '../tool-defs.ts';

function createCtx(overrides?: Partial<MemwiseToolCallbacks>) {
  const calls: { op: string; args: unknown }[] = [];
  const memwise: MemwiseToolCallbacks = {
    async vocabulary() { calls.push({ op: 'vocabulary', args: undefined }); return { tools: [{ name: 'domain.customer.get', effect: 'read' }] }; },
    async read(input) { calls.push({ op: 'read', args: input }); return { files: ['workflows/x/workflow.yaml'] }; },
    async write(input) { calls.push({ op: 'write', args: input }); return { draftId: 'x-1', editId: 'e1', diagnostics: [] }; },
    async diff() { calls.push({ op: 'diff', args: undefined }); return { files: [] }; },
    async check(input) { calls.push({ op: 'check', args: input }); return { outcome: 'passed' }; },
    async finish(input) { calls.push({ op: 'finish', args: input }); return { applied: true, draftId: 'x-1' }; },
    ...overrides,
  };
  return { ctx: { memwise } as unknown as SessionToolContext, calls };
}

const text = (r: { content: { text?: string }[] }) => r.content[0]?.text ?? '';

describe('playbook tools', () => {
  it('say they are unavailable outside a conversation-step chat', async () => {
    const ctx = {} as SessionToolContext;
    for (const h of [handlePlaybookVocabulary, handlePlaybookDiff]) {
      const r = await h(ctx, {} as never);
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('only available');
    }
    expect((await handlePlaybookWrite(ctx, { files: [{ path: 'a', content: 'b' }], summary: 's' })).isError).toBe(true);
  });

  it('pass reads and writes through, trimmed', async () => {
    const { ctx, calls } = createCtx();
    expect(text(await handlePlaybookVocabulary(ctx, {}))).toContain('domain.customer.get');
    await handlePlaybookRead(ctx, { path: ' workflows/x/workflow.yaml ', live: true });
    const w = await handlePlaybookWrite(ctx, { files: [{ path: 'workflows/x/workflow.yaml', content: 'workflow: x' }], summary: ' Start it ', playbook: 'x', title: 'X' });
    expect(w.isError).toBe(false);
    expect(JSON.parse(text(w))).toEqual({ draftId: 'x-1', editId: 'e1', diagnostics: [] });
    await handlePlaybookCheck(ctx, { pastCases: 0 });
    expect(calls).toEqual([
      { op: 'vocabulary', args: undefined },
      { op: 'read', args: { path: 'workflows/x/workflow.yaml', live: true } },
      { op: 'write', args: { files: [{ path: 'workflows/x/workflow.yaml', content: 'workflow: x' }], summary: 'Start it', playbook: 'x', title: 'X' } },
      { op: 'check', args: { pastCases: 0 } },
    ]);
  });

  it('validate write arguments before calling', async () => {
    const { ctx, calls } = createCtx();
    expect((await handlePlaybookWrite(ctx, { files: [], summary: 's' })).isError).toBe(true);
    expect((await handlePlaybookWrite(ctx, { files: [{ path: 'a', content: 'b' }], summary: ' ' })).isError).toBe(true);
    expect((await handlePlaybookWrite(ctx, { files: [{ path: 'a', content: 3 as never }], summary: 's' })).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('report a refused finish as an error', async () => {
    const { ctx } = createCtx({ async finish() { return { applied: false, message: 'The draft has 2 errors.' }; } });
    const r = await handlePlaybookFinish(ctx, { summary: 'done' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('2 errors');
    expect((await handlePlaybookFinish(ctx, { summary: '' })).isError).toBe(true);
  });

  it('turn thrown errors into error results', async () => {
    const { ctx } = createCtx({ async diff() { throw new Error('no draft yet'); } });
    const r = await handlePlaybookDiff(ctx, {});
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('no draft yet');
  });
});

describe('playbook tool visibility', () => {
  it('are hidden unless includePlaybookTools', () => {
    const names = (opts?: Parameters<typeof getSessionToolDefs>[0]) => new Set(getSessionToolDefs(opts).map((d) => d.name));
    for (const n of PLAYBOOK_TOOL_NAMES) {
      expect(names().has(n)).toBe(false);
      expect(names({ includePlaybookTools: true }).has(n)).toBe(true);
      expect(SESSION_TOOL_REGISTRY.get(n)?.executionMode).toBe('registry');
    }
    expect(getToolDefsAsJsonSchema({ prefix: 'mcp__session__', includePlaybookTools: true }).some((d) => d.name === 'mcp__session__playbook_write')).toBe(true);
    expect(getToolDefsAsJsonSchema({ prefix: 'mcp__session__' }).some((d) => d.name.startsWith('mcp__session__playbook_'))).toBe(false);
  });

  it('allow reads and draft writes in Explore, not finishing', () => {
    const safe = getSessionSafeAllowedToolNames({ includePlaybookTools: true });
    for (const n of ['playbook_vocabulary', 'playbook_read', 'playbook_write', 'playbook_diff', 'playbook_check']) expect(safe.has(n)).toBe(true);
    expect(safe.has('playbook_finish')).toBe(false);
  });
});
