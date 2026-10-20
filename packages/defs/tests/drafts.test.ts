import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyDraft, createDraft, diffDraft, discardDraftEdit, DraftConflictError, draftContentHash, DraftStaleError, listDrafts,
  loadDraft, loadProject, readDraft, setDraftEditStatus, updateDraftMeta, writeDraftFiles, writeDraftReport, type DraftReport,
} from '../src/index.ts';
import { BASE, makeProject } from './fixture.ts';

const WF = 'workflows/demo/workflow.yaml';
const WORK = 'workflows/demo/steps/work.md';
const cli = { by: 'cli', via: 'cli' as const, summary: 'edit' };

async function changeDraft(root = makeProject()) {
  const meta = await createDraft(root, { workflowId: 'demo', title: 'Tweak', kind: 'change', createdBy: 'p1' });
  return { root, meta, dir: join(root, 'drafts', meta.id) };
}

describe('drafts', () => {
  test('a change draft copies domain/ and the playbook, records base hashes and bumps the version', async () => {
    const { root, meta, dir } = await changeDraft();
    expect(meta.id).toMatch(/^demo-[0-9a-z]+$/);
    expect(meta).toMatchObject({ workflowId: 'demo', kind: 'change', status: 'open', baseVersion: 1, createdBy: 'p1', title: 'Tweak' });
    expect(Object.keys(meta.base).sort()).toEqual(Object.keys(BASE).sort());
    expect(readFileSync(join(dir, WORK), 'utf8')).toBe(BASE[WORK]!);
    expect(readFileSync(join(dir, WF), 'utf8')).toBe(BASE[WF]!.replace('version: 1', 'version: 2'));
    expect(readFileSync(join(root, WF), 'utf8')).toBe(BASE[WF]!); // live untouched
    expect(existsSync(join(dir, 'edits.jsonl'))).toBe(true);
    const read = await readDraft(root, meta.id);
    expect(read).toEqual({ meta, edits: [] });
    expect((await listDrafts(root)).map((d) => d.id)).toEqual([meta.id]);
    // The draft folder is a project of its own, and its playbook loads at version 2.
    const loaded = await loadDraft(root, meta.id);
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.workflow?.version).toBe(2);
    expect(loaded.workflow?.dir).toBe('workflows/demo');
  });

  test('two drafts made at once get different ids; a version line is added when missing', async () => {
    const root = makeProject({ [WF]: BASE[WF]!.replace('version: 1\n', '') });
    const a = await createDraft(root, { workflowId: 'demo', title: 'a', createdBy: 'cli' });
    const b = await createDraft(root, { workflowId: 'demo', title: 'b', createdBy: 'cli' });
    expect(a.id).not.toBe(b.id);
    expect(a.kind).toBe('change');
    expect(readFileSync(join(root, 'drafts', a.id, WF), 'utf8')).toStartWith('workflow: demo\nversion: 2\nstart: work\n');
    expect((await listDrafts(root)).length).toBe(2);
  });

  test('create drafts start empty and need a new id; change drafts need an existing one', async () => {
    const root = makeProject();
    const meta = await createDraft(root, { workflowId: 'letters', title: 'Letters', kind: 'create', createdBy: 'cli' });
    const dir = join(root, 'drafts', meta.id);
    expect(meta.kind).toBe('create');
    expect(meta.baseVersion).toBeUndefined();
    expect(existsSync(join(dir, 'workflows/letters'))).toBe(true);
    expect(existsSync(join(dir, 'workflows/demo'))).toBe(false);
    expect(Object.keys(meta.base).every((p) => p.startsWith('domain/'))).toBe(true);
    await expect(createDraft(root, { workflowId: 'demo', title: 'x', kind: 'create', createdBy: 'cli' })).rejects.toThrow(/already exists/);
    await expect(createDraft(root, { workflowId: 'nope', title: 'x', kind: 'change', createdBy: 'cli' })).rejects.toThrow(/no playbook nope/);
    await expect(createDraft(root, { workflowId: '../x', title: 'x', createdBy: 'cli' })).rejects.toThrow(/can't be a playbook id/);
  });

  test('writes: only domain/ and this playbook, no .., no absolute paths, no dotfiles', async () => {
    const { root, meta } = await changeDraft();
    for (const bad of ['workflows/other/workflow.yaml', 'drafts/x', '/etc/passwd', 'workflows/demo/../other/x', 'domain/.secret', 'workflows/demo', 'domain\\x', '']) {
      await expect(writeDraftFiles(root, meta.id, { [bad]: 'x' }, cli)).rejects.toThrow(/can't write/);
    }
    await expect(writeDraftFiles(root, '../../etc', { 'domain/x.yaml': 'x' }, cli)).rejects.toThrow(/not a draft id/);
  });

  test('chat edits are pending until kept; editor and CLI edits are kept at once', async () => {
    const { root, meta, dir } = await changeDraft();
    const newWork = BASE[WORK]!.replace('Look the customer up', 'Look the customer up carefully');
    const e1 = await writeDraftFiles(root, meta.id, [{ path: WORK, content: newWork }, { path: 'workflows/demo/notes.md', content: 'hi\n' }], { by: 'p1', via: 'chat', chatId: 's1', summary: 'Careful lookup' });
    expect(e1.status).toBe('pending');
    expect(e1.chatId).toBe('s1');
    expect(e1.files).toEqual([
      { path: WORK, before: BASE[WORK]!, after: newWork },
      { path: 'workflows/demo/notes.md', before: null, after: 'hi\n' },
    ]);
    expect(readFileSync(join(dir, WORK), 'utf8')).toBe(newWork);
    const e2 = await writeDraftFiles(root, meta.id, { 'workflows/demo/notes.md': null }, cli);
    expect(e2.status).toBe('kept');
    expect(existsSync(join(dir, 'workflows/demo/notes.md'))).toBe(false);
    // Writing what's already there records nothing.
    const e3 = await writeDraftFiles(root, meta.id, { [WORK]: newWork }, cli);
    expect(e3.files).toEqual([]);
    expect((await readDraft(root, meta.id))!.edits.map((e) => e.id)).toEqual([e1.id, e2.id]);
    const kept = await setDraftEditStatus(root, meta.id, e1.id, 'kept');
    expect(kept.status).toBe('kept');
    expect((await readDraft(root, meta.id))!.edits.map((e) => e.status)).toEqual(['kept', 'kept']);
  });

  test('discarding an edit restores its files, unless they changed again since', async () => {
    const { root, meta, dir } = await changeDraft();
    const e1 = await writeDraftFiles(root, meta.id, { [WORK]: 'changed\n', 'workflows/demo/new.md': 'new\n' }, { ...cli, via: 'chat' });
    const e2 = await writeDraftFiles(root, meta.id, { 'domain/policy.yaml': 'effects: { outbound: deny }\n' }, { ...cli, via: 'chat' });
    // e2 touched other files, so e1 can still be undone on its own.
    const r1 = await discardDraftEdit(root, meta.id, e1.id);
    expect(r1.applied).toBe(true);
    expect(readFileSync(join(dir, WORK), 'utf8')).toBe(BASE[WORK]!);
    expect(existsSync(join(dir, 'workflows/demo/new.md'))).toBe(false);
    expect((await discardDraftEdit(root, meta.id, e1.id)).applied).toBe(false);
    // A later edit to the same file blocks discarding e2; nothing is restored.
    await writeDraftFiles(root, meta.id, { 'domain/policy.yaml': 'effects: { outbound: approve, write: approve }\n' }, cli);
    const r2 = await discardDraftEdit(root, meta.id, e2.id);
    expect(r2).toMatchObject({ applied: false, conflicts: ['domain/policy.yaml'] });
    expect(readFileSync(join(dir, 'domain/policy.yaml'), 'utf8')).toContain('write: approve');
    const edits = (await readDraft(root, meta.id))!.edits;
    expect(edits.map((e) => e.status)).toEqual(['discarded', 'pending', 'kept']);
  });

  test('the content hash covers domain/ and workflows/, not the metadata', async () => {
    const { root, meta } = await changeDraft();
    const h1 = await draftContentHash(root, meta.id);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    await updateDraftMeta(root, meta.id, { title: 'Renamed' });
    const report: DraftReport = { draftId: meta.id, workflowId: 'demo', hash: h1, at: 'now', diagnostics: [], errors: 0, warnings: 0, examples: [], pastCases: [], outcome: 'passed', summary: 'ok' };
    await writeDraftReport(root, meta.id, report);
    expect(await draftContentHash(root, meta.id)).toBe(h1);
    expect((await readDraft(root, meta.id))!.report).toEqual(report);
    expect((await readDraft(root, meta.id))!.meta.title).toBe('Renamed');
    await writeDraftFiles(root, meta.id, { 'domain/policy.yaml': 'effects: {}\n' }, cli);
    expect(await draftContentHash(root, meta.id)).not.toBe(h1);
  });

  test('the diff shows only what the draft changed, with hunks, structure and conflicts', async () => {
    const { root, meta } = await changeDraft();
    await writeDraftFiles(root, meta.id, {
      [WORK]: BASE[WORK]!.replace('allowed: [lookup.customer]', 'allowed: [lookup.customer, mail.send]\n  required: [lookup.customer]'),
      'workflows/demo/case.yaml': BASE['workflows/demo/case.yaml']!.replace('  name: Text\n', '  name: Text\n  email: Email\n'),
    }, cli);
    const diff = await diffDraft(root, meta.id);
    expect(diff.files.map((f) => [f.path, f.status])).toEqual([
      ['workflows/demo/case.yaml', 'modified'],
      ['workflows/demo/steps/work.md', 'modified'],
      ['workflows/demo/workflow.yaml', 'modified'],
    ]);
    expect(diff.conflicts).toEqual([]);
    const shape = diff.files.find((f) => f.path === WF)!;
    expect(shape.hunks).toEqual([{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 5, lines: [
      { kind: 'same', text: 'workflow: demo' },
      { kind: 'removed', text: 'version: 1' },
      { kind: 'added', text: 'version: 2' },
      { kind: 'same', text: 'start: work' },
      { kind: 'same', text: 'steps:' },
      { kind: 'same', text: '  work: { on: { done: review } }' },
    ] }]);
    expect(diff.structure).toMatchObject({
      workflowId: 'demo',
      version: { from: 1, to: 2 },
      states: { work: 'changed' },
      steps: { work: { change: 'changed', parts: ['tools'] } },
      caseFields: { added: ['email'], removed: [], changed: [] },
      tools: { added: ['mail.send'], removed: [] },
      requiredTools: [{ step: 'work', tool: 'lookup.customer', change: 'added' }],
    });
    // Now someone edits the live step: the diff flags it.
    writeFileSync(join(root, WORK), `${BASE[WORK]}Live edit.\n`);
    const again = await diffDraft(root, meta.id);
    expect(again.conflicts).toEqual([WORK]);
    expect(again.files.find((f) => f.path === WORK)?.conflict).toBe(true);
  });

  test('a live change to a playbook file the draft did not touch is a conflict too (the draft is out of date)', async () => {
    const { root, meta } = await changeDraft();
    await writeDraftFiles(root, meta.id, { [WORK]: 'draft\n' }, cli);
    writeFileSync(join(root, 'workflows/demo/steps/review.md'), `${BASE['workflows/demo/steps/review.md']}More.\n`);
    const diff = await diffDraft(root, meta.id);
    expect(diff.files.map((f) => f.path)).not.toContain('workflows/demo/steps/review.md');
    expect(diff.conflicts).toEqual(['workflows/demo/steps/review.md']);
    await expect(applyDraft(root, meta.id)).rejects.toBeInstanceOf(DraftConflictError);
  });

  test('of two drafts made from the same version, the second is refused once the first is published', async () => {
    const root = makeProject();
    const a = (await changeDraft(root)).meta;
    const b = (await changeDraft(root)).meta;
    await writeDraftFiles(root, a.id, { [WORK]: 'from a\n' }, cli);
    await writeDraftFiles(root, b.id, { 'workflows/demo/steps/review.md': 'from b\n' }, cli);
    expect((await applyDraft(root, a.id)).version).toBe(2);
    const err = await applyDraft(root, b.id).catch((e) => e);
    expect(err).toBeInstanceOf(DraftConflictError);
    expect((err as DraftConflictError).paths).toEqual([WORK, WF]);
    expect(readFileSync(join(root, 'workflows/demo/steps/review.md'), 'utf8')).toBe(BASE['workflows/demo/steps/review.md']!);
  });

  test('a create draft diffs as added files with no structure until it loads', async () => {
    const root = makeProject();
    const meta = await createDraft(root, { workflowId: 'letters', title: 'Letters', createdBy: 'cli' });
    expect((await diffDraft(root, meta.id)).files).toEqual([]);
    await writeDraftFiles(root, meta.id, { 'workflows/letters/notes.md': 'x\n' }, cli);
    const d1 = await diffDraft(root, meta.id);
    expect(d1.files.map((f) => f.status)).toEqual(['added']);
    expect(d1.structure).toBeUndefined();
    await writeDraftFiles(root, meta.id, {
      'workflows/letters/workflow.yaml': 'workflow: letters\nversion: 1\nstart: write\nsteps:\n  write: { on: { done: end } }\n',
      'workflows/letters/case.yaml': 'case: letter\nfields:\n  body: Text\n',
      'workflows/letters/steps/write.md': '---\ntitle: Write\nperformer: agent\nmodel: worker\noutcomes: [done]\n---\nWrite it.\n',
    }, cli);
    const d2 = await diffDraft(root, meta.id);
    expect(d2.structure).toMatchObject({ version: { to: 1 }, states: { write: 'added' }, steps: { write: { change: 'added' } }, caseFields: { added: ['body'] } });
    expect(d2.structure!.version.from).toBeUndefined();
    const r = await applyDraft(root, meta.id);
    expect(r).toEqual({ workflowId: 'letters', version: 1, files: ['workflows/letters/case.yaml', 'workflows/letters/notes.md', 'workflows/letters/steps/write.md', 'workflows/letters/workflow.yaml'] });
    expect((await loadProject(root)).project.workflows.letters?.version).toBe(1);
  });

  test('publishing copies the changed files over live, deletes deleted ones, and marks the draft', async () => {
    const { root, meta } = await changeDraft();
    await writeDraftFiles(root, meta.id, { [WORK]: BASE[WORK]!.replace('flag anything odd', 'flag anything odd or late'), 'workflows/demo/steps/review.md': null }, cli);
    // Unrelated live change since: kept, not overwritten.
    writeFileSync(join(root, 'domain/entities/customer.yaml'), 'entity: Customer\nfields:\n  name: PersonName\n  phone: Phone\n');
    const before = (await loadProject(root)).project.workflows.demo!.hash;
    await expect(applyDraft(root, meta.id, { hash: 'nope' })).rejects.toBeInstanceOf(DraftStaleError);
    const r = await applyDraft(root, meta.id, { hash: await draftContentHash(root, meta.id) });
    expect(r).toEqual({ workflowId: 'demo', version: 2, files: ['workflows/demo/steps/review.md', WORK, WF] });
    expect(readFileSync(join(root, WORK), 'utf8')).toContain('odd or late');
    expect(existsSync(join(root, 'workflows/demo/steps/review.md'))).toBe(false);
    expect(readFileSync(join(root, 'domain/entities/customer.yaml'), 'utf8')).toContain('phone');
    const live = (await loadProject(root)).project.workflows.demo!;
    expect(live.version).toBe(2);
    expect(live.hash).not.toBe(before);
    const after = (await readDraft(root, meta.id))!.meta;
    expect(after).toMatchObject({ status: 'published', publishedVersion: 2 });
    expect(after.publishedAt).toBeString();
    await expect(applyDraft(root, meta.id)).rejects.toThrow(/published/);
    await expect(writeDraftFiles(root, meta.id, { [WORK]: 'x' }, cli)).rejects.toThrow(/published/);
  });

  test('publishing refuses, changing nothing, when a live file changed since the draft was made', async () => {
    const { root, meta } = await changeDraft();
    await writeDraftFiles(root, meta.id, { [WORK]: 'draft\n', 'workflows/demo/examples/new.yaml': 'case: {}\nexpect: {}\n' }, cli);
    writeFileSync(join(root, WORK), 'live\n');
    const err = await applyDraft(root, meta.id).catch((e) => e);
    expect(err).toBeInstanceOf(DraftConflictError);
    expect((err as DraftConflictError).paths).toEqual([WORK]);
    expect(readFileSync(join(root, WORK), 'utf8')).toBe('live\n');
    expect(readFileSync(join(root, WF), 'utf8')).toBe(BASE[WF]!);
    expect(existsSync(join(root, 'workflows/demo/examples/new.yaml'))).toBe(false);
    expect((await readDraft(root, meta.id))!.meta.status).toBe('open');
  });

  test('a file added live where the draft adds one too is a conflict', async () => {
    const { root, meta } = await changeDraft();
    await writeDraftFiles(root, meta.id, { 'workflows/demo/policy.yaml': 'effects: { write: approve }\n' }, cli);
    writeFileSync(join(root, 'workflows/demo/policy.yaml'), 'effects: { write: deny }\n');
    await expect(applyDraft(root, meta.id)).rejects.toBeInstanceOf(DraftConflictError);
    expect((await diffDraft(root, meta.id)).conflicts).toEqual(['workflows/demo/policy.yaml']);
  });
});
