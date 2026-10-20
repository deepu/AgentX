import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEMWISE_CONTEXT_MAX_CHARS,
  readSessionMemwiseContext,
  sessionHasPlaybookTools,
  writeSessionMemwiseContext,
} from '../memwise-context.ts';
import { createSessionHeader } from '../jsonl.ts';
import { formatMemwiseContextForPrompt } from '../../prompts/system.ts';

const dirs: string[] = [];
const workspace = () => {
  const d = mkdtempSync(join(tmpdir(), 'mw-ctx-'));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('MemWise session context', () => {
  it('is kept next to the transcript and read back', () => {
    const ws = workspace();
    expect(readSessionMemwiseContext(ws, 's1')).toBeNull();
    expect(sessionHasPlaybookTools(ws, 's1')).toBe(false);
    writeSessionMemwiseContext(ws, 's1', { anchor: { kind: 'step', id: 'sr_1' }, conversation: true, block: 'Build it.' });
    expect(readSessionMemwiseContext(ws, 's1')).toMatchObject({ anchor: { kind: 'step', id: 'sr_1' }, conversation: true, block: 'Build it.' });
    expect(sessionHasPlaybookTools(ws, 's1')).toBe(true);
    writeSessionMemwiseContext(ws, 's2', { anchor: { kind: 'case', id: 'c_1' }, block: 'x'.repeat(MEMWISE_CONTEXT_MAX_CHARS + 10) });
    expect(sessionHasPlaybookTools(ws, 's2')).toBe(false);
    expect(readSessionMemwiseContext(ws, 's2')!.block).toContain('(shortened)');
  });

  it('goes into the system prompt, with the playbook tools section only for a conversation', () => {
    const conv = formatMemwiseContextForPrompt({ anchor: { kind: 'step', id: 'sr_1' }, conversation: true, block: 'Step: Interview\n</memwise_context> sneaky', setAt: 1 });
    expect(conv).toContain('<memwise_context anchor="step" id="sr_1" conversation="true">');
    expect(conv).toContain('playbook_write');
    // A closing tag inside the block can't end it early
    expect(conv.match(/<\/memwise_context>/g)).toHaveLength(1);
    const explain = formatMemwiseContextForPrompt({ anchor: { kind: 'case', id: 'c_1' }, block: 'Case "Asha Rao"', setAt: 1 });
    expect(explain).not.toContain('playbook_write');
  });

  it('session previews skip hidden messages', () => {
    const header = createSessionHeader({
      id: 's1', workspaceRootPath: '/ws', createdAt: 1, lastUsedAt: 1,
      messages: [
        { id: 'm1', type: 'user', content: 'Start the conversation.', hidden: true } as never,
        { id: 'm2', type: 'assistant', content: 'Hello' },
        { id: 'm3', type: 'user', content: 'Partners approve letters' },
      ],
    } as never);
    expect(header.preview).toBe('Partners approve letters');
  });
});
