import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEMWISE_CONTEXT_MAX_CHARS,
  memwiseSessionToolOptions,
  readSessionMemwiseContext,
  sessionHasPlaybookTools,
  sessionHasRecordTools,
  writeSessionMemwiseContext,
} from '../memwise-context.ts';
import { getSessionToolNames } from '@memwise/session-tools-core';
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

  // docs/memwise/25-literature-poc.md §6
  it('a record chat keeps its entity, offers the record tools, and record_keep only with something to keep', () => {
    const ws = workspace();
    writeSessionMemwiseContext(ws, 'r1', {
      anchor: { kind: 'record', entity: 'literature.topic', id: 'topic_1' },
      keep: [{ entity: 'literature.evidence', name: 'Evidence' }],
      block: 'Topic "Oral GLP-1s"',
    });
    expect(readSessionMemwiseContext(ws, 'r1')).toMatchObject({
      anchor: { kind: 'record', entity: 'literature.topic', id: 'topic_1' }, keep: [{ entity: 'literature.evidence', name: 'Evidence' }],
    });
    expect(sessionHasRecordTools(ws, 'r1')).toBe(true);
    expect(sessionHasPlaybookTools(ws, 'r1')).toBe(false);
    expect(memwiseSessionToolOptions(ws, 'r1')).toEqual({ includePlaybookTools: false, includeRecordTools: true, includeRecordKeep: true, includeRecordUpdate: false, includeRecordsFilter: false });
    const names = getSessionToolNames(memwiseSessionToolOptions(ws, 'r1'));
    expect(['record_get', 'record_query', 'record_keep'].every((n) => names.has(n))).toBe(true);

    writeSessionMemwiseContext(ws, 'r2', { anchor: { kind: 'record', entity: 'etmf.Site', id: 's1' }, block: 'Site' });
    expect(memwiseSessionToolOptions(ws, 'r2')).toEqual({ includePlaybookTools: false, includeRecordTools: true, includeRecordKeep: false, includeRecordUpdate: false, includeRecordsFilter: false });
    expect(getSessionToolNames(memwiseSessionToolOptions(ws, 'r2')).has('record_keep')).toBe(false);

    // Neither elsewhere: a case chat, a conversation, an ordinary chat
    writeSessionMemwiseContext(ws, 'c1', { anchor: { kind: 'case', id: 'c_1' }, keep: [{ entity: 'x.y', name: 'Y' }], block: 'x' } as never);
    expect(readSessionMemwiseContext(ws, 'c1')!.keep).toBeUndefined();
    expect(memwiseSessionToolOptions(ws, 'c1')).toEqual({ includePlaybookTools: false, includeRecordTools: false, includeRecordKeep: false, includeRecordUpdate: false, includeRecordsFilter: false });
    expect(memwiseSessionToolOptions(ws, 'none')).toEqual({ includePlaybookTools: false, includeRecordTools: false, includeRecordKeep: false, includeRecordUpdate: false, includeRecordsFilter: false });
    const plain = getSessionToolNames({});
    expect(['record_get', 'record_query', 'record_keep'].some((n) => plain.has(n))).toBe(false);
  });

  // docs/memwise/26-projects-and-pages.md §5 and §2 (Stage 4)
  it('a playbook chat gets the playbook tools with the test run, and a list chat records_filter', () => {
    const ws = workspace();
    writeSessionMemwiseContext(ws, 'p1', { anchor: { kind: 'workflow', id: 'chase-missing' }, block: 'Playbook' });
    expect(sessionHasPlaybookTools(ws, 'p1')).toBe(true);
    const playbook = getSessionToolNames(memwiseSessionToolOptions(ws, 'p1'));
    expect(['playbook_read', 'playbook_write', 'playbook_test_run'].every((n) => playbook.has(n))).toBe(true);
    expect(playbook.has('records_filter')).toBe(false);
    const prompt = formatMemwiseContextForPrompt({ anchor: { kind: 'workflow', id: 'chase-missing' }, block: 'x', setAt: 1 });
    expect(prompt).toContain('playbook_test_run');
    expect(prompt).toContain('Send for review');

    writeSessionMemwiseContext(ws, 'l1', { anchor: { kind: 'records', id: 'etmf.Site' }, block: 'Sites' });
    expect(memwiseSessionToolOptions(ws, 'l1')).toEqual({ includePlaybookTools: false, includeRecordTools: true, includeRecordKeep: false, includeRecordUpdate: false, includeRecordsFilter: true });
    const list = getSessionToolNames(memwiseSessionToolOptions(ws, 'l1'));
    expect(['record_query', 'records_filter'].every((n) => list.has(n))).toBe(true);
    expect(list.has('playbook_write')).toBe(false);
    expect(formatMemwiseContextForPrompt({ anchor: { kind: 'records', id: 'etmf.Site' }, block: 'x', setAt: 1 })).toContain('records_filter');
  });

  it('a record chat\'s prompt names the record tools, and record_keep only when it can keep', () => {
    const keep = formatMemwiseContextForPrompt({
      anchor: { kind: 'record', entity: 'literature.topic', id: 'topic_1' }, keep: [{ entity: 'literature.evidence', name: 'Evidence' }],
      block: 'Topic', personName: 'Dr. Lena Ortiz', setAt: 1,
    });
    expect(keep).toContain('<memwise_context anchor="record" entity="literature.topic" id="topic_1">');
    expect(keep).toContain('These tools act as Dr. Lena Ortiz');
    expect(keep).toContain('record_query');
    expect(keep).toContain('record_keep { entity, rows }`: keep rows as Evidence (`literature.evidence`)');
    expect(keep).toContain('copied exactly');
    expect(keep).toContain('DOI');
    const readOnly = formatMemwiseContextForPrompt({ anchor: { kind: 'record', entity: 'etmf.Site', id: 's1' }, block: 'Site', setAt: 1 });
    expect(readOnly).toContain('record_get');
    expect(readOnly).not.toContain('record_keep');
    expect(formatMemwiseContextForPrompt({ anchor: { kind: 'case', id: 'c_1' }, block: 'x', setAt: 1 })).not.toContain('record_get');
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
