// Regulated projects (Stage 5, docs/memwise/26-projects-and-pages.md §7, §8) on the eTMF example,
// through a real kernel and Postgres with fake models (fixtures/regulated-fakes.ts):
// - a change request to "File a TMF document" fails validation on past CVs (an unsigned CV the AI
//   checks passed was sent back by QC), is fixed, passes; the raiser sends it to QA; QA signs and
//   it is published as version 2, while a case started on version 1 finishes on version 1;
// - the project's audit log holds record versions, signatures and step records, the AI's naming
//   its model and the words it quoted; the signed export verifies, and a changed one doesn't;
// - an inspector link shows filed documents, signatures and their trail only, logs every view and
//   download, and sends questions to the study manager;
// - the TMF index counts expected, filed, missing and in-QC documents by zone and site.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { TestDatabase } from '@memwise/db';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftDir } from '@memwise/defs';
import { createKernel } from '../src/kernel.ts';
import { createAuditLogService } from '../src/regulated/audit-log.ts';
import { inspectorSees, withoutAiProse } from '../src/regulated/inspectors.ts';
import { holdsRole, reaches } from '../src/regulated/changes.ts';
import { main } from '../src/cli.ts';
import { waitingAppOf } from '../src/projects/service.ts';
import type { AuditExport, ChangeRequestView, Kernel, PersonActor } from '../src/types.ts';
import {
  answerQc, cvFile, FAKE_CLASSIFIER_MODEL, FAKE_VERIFIER_MODEL, fakeModelRoles, fakeRegulatedProvider, fileAtQc, until, type FakeIndex,
} from './fixtures/regulated-fakes.ts';
import { kernelDatabase, pgAvailable } from './helpers.ts';

const REPO = join(import.meta.dir, '..', '..', '..');
const PASSWORD = 'a long enough password';
const SIGNED_RULE = 'A CV is signed and dated by the person it is about.';

let db: TestDatabase;
let kernel: Kernel;
let dir: string;
let projectDir: string;
let anika: PersonActor; // study manager: raises the change, owns the project
let tom: PersonActor; // TMF specialist: QC
let grace: PersonActor; // QA
const index = new Map<string, FakeIndex>();
const ids: Record<string, string> = {};
const v1Cases: string[] = [];
let unsignedCase = '';

const create = async (entity: string, values: Record<string, unknown>) => {
  const r = await kernel.records.create({ entity, values, reason: 'study set-up' }, { kind: 'system' });
  if (!r.applied) throw new Error(`${entity}: ${r.status} ${r.message ?? ''}`);
  return r.id!;
};

/** A CV for a site: its expected document, and the index the fake classifier will give it. */
async function cvFor(site: string, person: string, name: string, signed: boolean, daysOld = 2) {
  const expected = await create('etmf.ExpectedDocument', { site: ids[site], study: ids.study, artifact: 'Investigator CV', phase: 'start_up' });
  index.set(name, { artifact: 'Investigator CV', study: ids.study!, site: ids[site]!, about: ids[person]!, expected_document: expected, document_date: new Date(Date.now() - daysOld * 86_400_000).toISOString().slice(0, 10), version: '1', signed });
  return kernel.saveFile(cvFile(name), { kind: 'system' });
}

describe.skipIf(!pgAvailable)('regulated projects (Stage 5) on the eTMF example', () => {
  beforeAll(async () => {
    db = await kernelDatabase('mw_rt_regulated');
    dir = mkdtempSync(join(tmpdir(), 'mw-regulated-'));
    projectDir = join(dir, 'project');
    cpSync(join(REPO, 'examples', 'etmf'), projectDir, { recursive: true });
    kernel = await createKernel({
      databaseUrl: db.url, projectDir, tools: [], modelRoles: fakeModelRoles(), providers: [fakeRegulatedProvider(index)],
      filesDir: join(dir, 'files'), logLevel: 'error',
    });
    const diagnostics = await kernel.index();
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const person = async (name: string, roles: string[]) =>
      kernel.people.actorFor((await kernel.people.create({ name, email: `${name.split(' ')[0]!.toLowerCase()}@northlight.example`, roles, password: PASSWORD })).id);
    anika = await person('Anika Rao', ['study_manager']);
    tom = await person('Tom Okafor', ['tmf_specialist']);
    grace = await person('Grace Lee', ['qa']);

    ids.sponsor = await create('etmf.Sponsor', { name: 'Aster Bio' });
    ids.study = await create('etmf.Study', { code: 'MW-301', title: 'Aster-1 in advanced solid tumours', sponsor: ids.sponsor });
    for (const n of ['101', '104', '109']) {
      ids[`site${n}`] = await create('etmf.Site', { site_number: n, study: ids.study });
      ids[`pi${n}`] = await create('etmf.Person', { name: `Dr. PI ${n}`, role: 'Principal Investigator', site: ids[`site${n}`] });
    }
    // Last month's CVs: three signed and approved, one unsigned and sent back by QC.
    const files = [
      await cvFor('site101', 'pi101', 'Investigator CV - site 101.pdf', true),
      await cvFor('site104', 'pi104', 'Investigator CV - site 104.pdf', true),
      await cvFor('site109', 'pi109', 'Investigator CV - site 109 unsigned.pdf', false),
    ];
    for (const f of files) {
      const { caseId } = await fileAtQc(kernel, f);
      v1Cases.push(caseId);
      if (f.name.includes('unsigned')) unsignedCase = caseId;
      await answerQc(kernel, tom, PASSWORD, caseId, f.name.includes('unsigned') ? 'sent_back' : 'approved');
    }
    for (const c of v1Cases) await until(`case ${c} to leave QC`, () => kernel.getCaseView(c, { kind: 'system' }), (v) => !!v && v.summary.state !== 'qc' && v.summary.state !== 'file');
  }, 240_000);

  afterAll(async () => {
    await kernel?.shutdown();
    await db?.drop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  // ---------------------------------------------------------------- change requests

  let cr: ChangeRequestView;
  let liveHash = '';
  let oldRun = '';

  test('a change to a regulated playbook is a change request, numbered on from the paper log', async () => {
    liveHash = (await kernel.project()).project.workflows['file-document']!.hash;
    await kernel.changes.setNextNumber('etmf', 14);
    cr = await kernel.changes.open({ workflowId: 'file-document', title: 'Stop the QC step for CVs' }, anika);
    expect(cr).toMatchObject({ number: 14, label: 'CR-014', project: 'etmf', status: 'open', regulated: true, liveVersion: 1, nextVersion: 2, raisedBy: { name: 'Anika Rao' } });
    expect(cr.signoffs.map((s) => [s.role, s.status, s.roleId])).toEqual([['raiser', 'waiting', undefined], ['qa', 'not-yet', 'qa']]);
    // The draft goes nowhere without the request: not through a change run, not published directly.
    const a = kernel.authoring!;
    await expect(a.startBuild({ workflowId: 'file-document' }, anika)).rejects.toThrow(/regulated domain/);
    await expect(a.submitDraft(cr.draftId, anika)).rejects.toThrow(/regulated domain/);
    const hash = (await a.getDraft(cr.draftId))!.contentHash;
    expect(await a.publish(cr.draftId, { hash, source: 'app' })).toMatchObject({ status: 'failed', message: expect.stringContaining('CR-014') });
    // A draft made any other way of a regulated playbook opens its own request.
    const other = await a.createDraft({ workflowId: 'file-document', title: 'Another change' }, anika);
    expect(await kernel.changes.forDraft(other.id)).toMatchObject({ number: 15 });
    await kernel.changes.withdraw((await kernel.changes.forDraft(other.id))!.id, anika, 'opened by mistake');
    // A change draft made by the system or an agent opens no request, and so can't go live either.
    const bySystem = await a.createDraft({ workflowId: 'file-document', title: 'An agent\'s change', kind: 'change' }, { kind: 'system' });
    expect(await kernel.changes.forDraft(bySystem.id)).toBeUndefined();
    const sysHash = (await a.getDraft(bySystem.id))!.contentHash;
    expect(await a.publish(bySystem.id, { hash: sysHash, source: 'app' })).toMatchObject({ status: 'failed', message: expect.stringContaining('no change request') });
    expect(await a.publish(bySystem.id, { hash: sysHash, source: 'app', changeRequest: cr.id })).toMatchObject({ status: 'failed' });
    await a.discardDraft(bySystem.id, anika);
    // Numbers are per project: a change is made to a request by its id, never by a bare number.
    await expect(kernel.changes.update('CR-014', { reason: 'x' }, anika)).rejects.toThrow(/by its id/);
    await expect(kernel.changes.sign('CR-014', { password: PASSWORD }, anika)).rejects.toThrow(/by its id/);
  });

  test('validation: the AI checks alone would have passed the unsigned CV QC sent back (2 of 3), so it fails', async () => {
    const a = kernel.authoring!;
    const qcPath = 'domains/etmf/workflows/file-document/steps/qc.md';
    const qc = (await a.read({ draftId: cr.draftId, path: qcPath })) as { content: string };
    await a.write({ draftId: cr.draftId, via: 'chat', summary: 'QC only for CVs the AI checks don\'t pass',
      files: [{ path: qcPath, content: qc.content.replace('title: QC and sign', 'title: QC by the TMF lead, except CVs that pass every AI check') }] }, anika);
    await kernel.changes.update(cr.id, { reason: 'QC of CVs repeats the AI check and holds up site activation. CVs that fail any AI check still go to QC.' }, anika);
    const v = await kernel.changes.validate(cr.id, anika);
    expect(v).toMatchObject({ total: 3, passed: 2, status: 'failed', checkErrors: 0, current: true });
    const miss = v.results.find((r) => !r.matches)!;
    expect(miss).toMatchObject({ caseId: unsignedCase, ai: 'pass', accepted: false, decided: { stepId: 'qc', outcome: 'sent_back', by: 'Tom Okafor' } });
    // Not sendable to QA yet.
    expect(await kernel.changes.sign(cr.id, { password: PASSWORD }, anika)).toMatchObject({ applied: false, status: 'not-validated' });
  });

  test('fixed (a signed-and-dated rule on the AI check), it passes 3 of 3; the raiser signs it to QA', async () => {
    const a = kernel.authoring!;
    const path = 'domains/etmf/workflows/file-document/steps/classify.md';
    const classify = (await a.read({ draftId: cr.draftId, path })) as { content: string };
    await a.write({ draftId: cr.draftId, via: 'chat', summary: 'The AI check now includes signature and date',
      files: [{ path, content: classify.content.replace('checkpoint:\n', `checkpoint:\n  - ${SIGNED_RULE}\n`) }] }, anika);
    const v = await kernel.changes.validate(cr.id, anika);
    expect(v).toMatchObject({ total: 3, passed: 3, status: 'passed' });
    const view = (await kernel.changes.get(cr.id, anika))!;
    expect(view.validations.map((x) => [x.passed, x.total, x.current])).toEqual([[2, 3, false], [3, 3, true]]);
    // What changes: the QC step's title struck through, the new rule on the AI check.
    const qcRow = view.steps.find((s) => s.stepId === 'qc')!;
    expect(qcRow).toMatchObject({ change: 'changed', who: { performer: 'person', role: 'tmf_specialist' } });
    expect(qcRow.title.filter((t) => t.kind !== 'same').map((t) => t.kind)).toContain('added');
    const classifyRow = view.steps.find((s) => s.stepId === 'classify')!;
    expect(classifyRow.rules.filter((r) => r.kind === 'added').map((r) => r.text)).toEqual([SIGNED_RULE]);
    expect(view.files.map((f) => [f.path.split('/').at(-1), f.kind])).toEqual(expect.arrayContaining([['classify.md', 'step'], ['qc.md', 'step']]));
    expect(view.can).toMatchObject({ send: true, approve: false });
    // QA is waiting on it in the inbox once it is sent; before that, the raiser is.
    expect((await kernel.inbox(anika)).some((i) => i.kind === 'change-request' && i.signoff === 'raiser')).toBe(true);
    expect(await kernel.changes.sign(cr.id, { password: 'wrong password!' }, anika)).toMatchObject({ applied: false, status: 'signature-failed' });
    expect(await kernel.changes.sign(cr.id, { password: PASSWORD }, tom)).toMatchObject({ applied: false, status: 'not-your-turn' });
    const sent = await kernel.changes.sign(cr.id, { password: PASSWORD }, anika);
    expect(sent).toMatchObject({ applied: true, view: { status: 'in_review' } });
    expect(sent.view!.signoffs.map((s) => [s.role, s.status])).toEqual([['raiser', 'signed'], ['qa', 'waiting']]);
    const items = await kernel.inbox(grace);
    expect(items.find((i) => i.kind === 'change-request')).toMatchObject({ signoff: 'qa', changeRequest: { label: 'CR-014' } });
    // Edits wait while QA has it: the request, and its draft's files, edits kept or undone.
    await expect(kernel.changes.update(cr.id, { reason: 'x' }, anika)).rejects.toThrow(/in review/);
    await expect(a.write({ draftId: cr.draftId, via: 'editor', summary: 'x', files: [{ path, content: 'x' }] }, anika)).rejects.toThrow(/in review/);
    const lastEdit = (await a.getDraft(cr.draftId))!.edits.at(-1)!;
    expect(await a.keepEdit(cr.draftId, lastEdit.id, anika)).toMatchObject({ applied: false, message: expect.stringMatching(/in review/) });
    expect(await a.discardEdit(cr.draftId, lastEdit.id, anika)).toMatchObject({ applied: false, message: expect.stringMatching(/in review/) });
  });

  test('changed after it was sent anyway (on disk): QA\'s signature sends it back to the raiser, who validates and signs again', async () => {
    const a = kernel.authoring!;
    const path = 'domains/etmf/workflows/file-document/steps/classify.md';
    const file = join(draftDir(projectDir, cr.draftId), path);
    const before = readFileSync(file, 'utf8');
    writeFileSync(file, `${before}\nChanged after it was sent.\n`);
    const back = await kernel.changes.sign(cr.id, { password: PASSWORD }, grace);
    expect(back).toMatchObject({ applied: false, status: 'stale', message: expect.stringContaining('went back to Anika Rao'), view: { status: 'open' } });
    expect(back.view!.signoffs.map((s) => [s.role, s.status])).toEqual([['raiser', 'waiting'], ['qa', 'not-yet']]);
    const returned = (await kernel.auditLog.list({ project: 'etmf', actions: ['change.returned'] }, anika)).entries;
    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatchObject({ actorKind: 'person', actorLabel: 'Grace Lee', recordId: cr.id, data: { label: 'CR-014' } });
    expect((await kernel.inbox(grace)).some((i) => i.kind === 'change-request')).toBe(false);
    // Open again: the raiser undoes the stray change, validates and signs it to QA again.
    await a.write({ draftId: cr.draftId, via: 'editor', summary: 'Undo the stray change', files: [{ path, content: before }] }, anika);
    expect(await kernel.changes.validate(cr.id, anika)).toMatchObject({ passed: 3, total: 3, status: 'passed' });
    const again = await kernel.changes.sign(cr.id, { password: PASSWORD }, anika);
    expect(again).toMatchObject({ applied: true, view: { status: 'in_review' } });
    expect(again.view!.signoffs.map((s) => [s.role, s.status])).toEqual([['raiser', 'signed'], ['qa', 'waiting']]);
  });

  test('QA signs: version 2 goes live; a case started on version 1 finishes on version 1, new cases run on 2', async () => {
    // A CV arrives before QA signs: its case pins version 1 and waits at QC.
    const late = await cvFor('site101', 'pi101', 'Investigator CV - site 101 renewal.pdf', true, 45);
    const old = await fileAtQc(kernel, late);
    oldRun = old.runId;
    expect((await kernel.getRun(oldRun))!.workflowHash).toBe(liveHash);

    expect(await kernel.changes.sign(cr.id, { password: PASSWORD }, tom)).toMatchObject({ applied: false, status: 'forbidden' });
    // The app stops right after the draft went live: QA's signature was kept before it did.
    const a = kernel.authoring!;
    const publish = a.publish;
    a.publish = async (...args) => { await publish(...args); throw new Error('the app stopped'); };
    await expect(kernel.changes.sign(cr.id, { password: PASSWORD }, grace)).rejects.toThrow(/the app stopped/);
    a.publish = publish;
    const midway = (await kernel.changes.get(cr.id, grace))!;
    expect(midway.status).toBe('in_review');
    expect(midway.signoffs.find((s) => s.role === 'qa')).toMatchObject({ status: 'signed', person: { name: 'Grace Lee' } });
    // Signing again closes the request with the version that was made, without publishing again.
    const signed = await kernel.changes.sign(cr.id, { password: PASSWORD }, grace);
    expect(signed).toMatchObject({ applied: true, published: { workflowId: 'file-document', version: 2 }, view: { status: 'published', toVersion: 2 } });
    const live = (await kernel.project()).project.workflows['file-document']!;
    expect(live.version).toBe(2);
    expect(live.steps.classify!.checkpoint).toContain(SIGNED_RULE);
    const versions = await kernel.versions('file-document');
    expect(versions.find((v) => v.version === 2)).toMatchObject({ publishedBy: grace.personId, source: 'app', live: true });
    expect(versions.filter((v) => v.version > 1)).toHaveLength(1);
    const marks = (await kernel.auditLog.list({ project: 'etmf', actions: ['change.publishing', 'change.published'] }, anika)).entries.map((e) => e.action);
    expect(marks).toEqual(['change.publishing', 'change.published']);
    expect((await kernel.auditLog.list({ project: 'etmf', entity: 'change_request', recordId: cr.id, actions: ['signature.signed'] }, anika)).entries
      .map((e) => e.data.role)).toEqual(['raiser', 'raiser', 'qa']);
    expect(versions.find((v) => v.version === 1)).toMatchObject({ openCases: 1, live: false });

    await answerQc(kernel, tom, PASSWORD, old.caseId, 'approved');
    const done = await kernel.waitForRun(oldRun, { until: (r) => r.status !== 'active', timeoutMs: 60_000 });
    expect(done).toMatchObject({ status: 'done', state: 'end', workflowHash: liveHash, workflowVersion: 1 });

    const fresh = await fileAtQc(kernel, await cvFor('site104', 'pi104', 'Investigator CV - site 104 renewal.pdf', true));
    expect(await kernel.getRun(fresh.runId)).toMatchObject({ workflowVersion: 2, workflowHash: live.hash });
    await answerQc(kernel, tom, PASSWORD, fresh.caseId, 'approved');
  }, 120_000);

  // ---------------------------------------------------------------- the audit log

  test('the audit log: record versions, signatures and step records; the AI names its model and its quote', async () => {
    const { entries, chain } = await kernel.auditLog.list({ project: 'etmf', limit: 5000 }, anika);
    expect(chain.ok).toBe(true);
    const ai = entries.find((e) => e.actorKind === 'ai' && e.data.step === 'classify' && e.caseId === unsignedCase)!;
    expect(ai).toMatchObject({ action: 'step.completed', data: { model: FAKE_CLASSIFIER_MODEL, verifierModel: FAKE_VERIFIER_MODEL, outcome: 'classified', quote: 'Investigator CV', quotedField: 'artifact' }, stepTitle: 'Classify and index it' });
    expect(String(ai.data.rationale)).toContain('not signed');
    const sentBack = entries.find((e) => e.action === 'step.completed' && e.data.step === 'qc' && e.caseId === unsignedCase)!;
    expect(sentBack).toMatchObject({ actorKind: 'person', actorLabel: 'Tom Okafor', data: { outcome: 'sent_back' } });
    expect(entries.filter((e) => e.action === 'signature.signed').map((e) => e.data.meaning)).toEqual(expect.arrayContaining([
      'Reviewed and approved for filing', 'Raised this change and sent it to QA', 'Approved this change for use',
    ]));
    expect(entries.map((e) => e.action)).toEqual(expect.arrayContaining(['change.opened', 'change.validated', 'change.published', 'record.created', 'record.changed']));
    // One record's trail: its versions, its signature, and the steps of the case that filed it.
    const doc = entries.find((e) => e.action === 'signature.signed' && e.entity === 'etmf.Document')!;
    const trail = await kernel.auditLog.list({ project: 'etmf', entity: 'etmf.Document', recordId: doc.recordId! }, anika);
    expect(new Set(trail.entries.map((e) => e.action))).toEqual(new Set(['record.created', 'record.changed', 'signature.signed', 'step.completed']));
    expect(trail.entries.some((e) => e.actorKind === 'ai' && e.data.model === FAKE_CLASSIFIER_MODEL)).toBe(true);
    expect(trail.entries.every((e, i) => i === 0 || e.seq > trail.entries[i - 1]!.seq)).toBe(true);
  });

  test('the export is signed and verifies; a changed entry, a dropped entry or a changed file does not', async () => {
    const exp = await kernel.auditLog.export({ project: 'etmf' }, anika);
    expect(exp).toMatchObject({ format: 'memwise-audit/1', complete: true, exportedBy: 'Anika Rao' });
    expect(await kernel.auditLog.verify({ export: JSON.parse(JSON.stringify(exp)) })).toMatchObject({ ok: true, chain: { ok: true }, signature: { ok: true, trusted: true } });
    expect((await kernel.auditLog.list({ project: 'etmf', actions: ['audit.exported'] }, anika)).entries).toHaveLength(1);

    const changed: AuditExport = structuredClone(exp);
    const ai = changed.entries.find((e) => e.actorKind === 'ai')!;
    ai.data = { ...ai.data, model: 'a better model' };
    expect(await kernel.auditLog.verify({ export: changed })).toMatchObject({ ok: false, chain: { ok: false, brokenAt: { id: ai.id, reason: 'hash' } } });
    const dropped: AuditExport = structuredClone(exp);
    dropped.entries.splice(3, 1);
    expect(await kernel.auditLog.verify({ export: dropped })).toMatchObject({ ok: false, chain: { ok: false, brokenAt: { reason: 'link' } } });
    const resigned: AuditExport = { ...structuredClone(exp), exportedBy: 'Someone else' };
    expect(await kernel.auditLog.verify({ export: resigned })).toMatchObject({ ok: false, chain: { ok: true }, signature: { ok: false } });

    // `memwise audit verify` checks the file with no database.
    const good = join(dir, 'audit.json');
    const bad = join(dir, 'audit-changed.json');
    writeFileSync(good, JSON.stringify(exp));
    writeFileSync(bad, JSON.stringify(changed));
    expect(await main(['audit', 'verify', good, '--key', exp.publicKey])).toBe(0);
    // Without a trusted key a self-signed file proves nothing: unverified.
    expect(await main(['audit', 'verify', good])).toBe(1);
    const { verifyAuditExport } = await import('../src/regulated/audit-log.ts');
    expect(verifyAuditExport(JSON.parse(JSON.stringify(exp)))).toMatchObject({ ok: false, chain: { ok: true }, signature: { ok: true }, message: expect.stringContaining('Unverified') });
    expect(await main(['audit', 'verify', bad])).toBe(1);
    expect(await main(['audit', 'verify', '--project', 'etmf', '--database-url', db.url])).toBe(0);
    expect(JSON.parse(readFileSync(good, 'utf8')).entries.length).toBe(exp.entries.length);
    expect(await kernel.auditLog.verify({ project: 'etmf' })).toMatchObject({ ok: true });

    // An export cut short at its limit says it isn't the complete log.
    const small = createAuditLogService({ pool: db.pool, entities: () => ({}), defs: { latest: async () => undefined, workflow: async () => { throw new Error('none'); } } as never, people: { get: async () => undefined } as never, maxExport: 3 });
    const cut = await small.export({ project: 'etmf' }, { kind: 'system' });
    expect(cut).toMatchObject({ complete: false });
    expect(cut.entries).toHaveLength(3);
  });

  test('an inspector sees record changes of the document asked for only, and no AI prose', () => {
    expect(inspectorSees({ action: 'record.changed', entity: 'etmf.Document', recordId: 'd1' }, 'etmf.Document', 'd1')).toBe(true);
    expect(inspectorSees({ action: 'record.changed', entity: 'etmf.Site', recordId: 's1' }, 'etmf.Document', 'd1')).toBe(false);
    expect(inspectorSees({ action: 'step.completed', entity: null, recordId: null }, 'etmf.Document', 'd1')).toBe(true);
    expect(inspectorSees({ action: 'change.published', entity: 'change_request', recordId: 'cr_1' }, 'etmf.Document', 'd1')).toBe(false);
    expect(withoutAiProse({ actorKind: 'ai', data: { rationale: 'I think', quote: 'Investigator CV' } as Record<string, unknown> }).data).toEqual({ quote: 'Investigator CV' });
    expect(withoutAiProse({ actorKind: 'person', data: { rationale: 'Not signed' } }).data).toEqual({ rationale: 'Not signed' });
  });

  // ---------------------------------------------------------------- inspectors

  test('an inspector link: filed documents, signatures and their trail only; every view and download logged; questions go to people', async () => {
    const ends = new Date(Date.now() + 14 * 86_400_000).toISOString();
    await expect(kernel.inspectors.create({ project: 'etmf', name: 'MHRA inspection', inspectors: [{ name: 'Inspector' }], expiresAt: ends }, tom)).rejects.toThrow(/gives inspectors access/);
    const { link, token } = await kernel.inspectors.create({
      project: 'etmf', name: 'MHRA inspection', inspectors: [{ name: 'Inspector', organisation: 'MHRA' }], expiresAt: ends,
    }, anika);
    expect(token).toMatch(/^mwi_/);
    expect(link).toMatchObject({ status: 'active', name: 'MHRA inspection', views: 0 });

    const opened = await kernel.inspectors.open(token, { ip: '203.0.113.9' });
    if ('refused' in opened) throw new Error('refused');
    expect(opened.session).toMatchObject({ inspector: 'Inspector, MHRA', projectName: 'eTMF' });
    expect(opened.zones.find((z) => z.number === '05')!.filed).toBe(4);

    const list = await kernel.inspectors.documents(token, { zone: '05' });
    if ('refused' in list) throw new Error('refused');
    // Filed CVs only: not the one sent back, nothing in QC.
    expect(list.documents).toHaveLength(4);
    expect(list.documents.every((d) => d.status === 'filed' && d.signatures.some((s) => s.meaning === 'Reviewed and approved for filing'))).toBe(true);
    const first = list.documents[0]!;
    const doc = await kernel.inspectors.document(token, first.entity, first.id);
    if (!doc || 'refused' in doc) throw new Error('no document');
    expect(doc.values.map((v) => v.field)).not.toContain('reviewer_note');
    expect(JSON.stringify(doc)).not.toMatch(/notes|mentions|proposal|chat/i);

    const trail = await kernel.inspectors.trail(token, first.entity, first.id);
    if (!trail || 'refused' in trail) throw new Error('no trail');
    expect(trail.entries.length).toBeGreaterThan(3);
    expect(trail.entries.some((e) => /^(change|inspector|audit)\./.test(e.action))).toBe(false);
    const file = await kernel.inspectors.download(token, first.entity, first.id);
    expect(file && !('refused' in file) && file.name).toMatch(/Investigator CV/);
    // A record sent back isn't shown, by id either.
    const rejected = (await kernel.getCaseView(unsignedCase, { kind: 'system' }))!.values.document!.value as string;
    expect(await kernel.inspectors.document(token, 'etmf.Document', rejected)).toBeUndefined();

    const q = await kernel.inspectors.ask(token, { question: 'Why was the site 109 CV sent back?', entity: first.entity, recordId: first.id });
    if ('refused' in q) throw new Error('refused');
    const item = (await kernel.inbox(anika)).find((i) => i.kind === 'inspector-question');
    expect(item).toMatchObject({ question: { question: 'Why was the site 109 CV sent back?', linkName: 'MHRA inspection', askedBy: 'Inspector, MHRA' } });
    expect((await kernel.inbox(tom)).some((i) => i.kind === 'inspector-question')).toBe(false);
    await kernel.inspectors.answer(q.id, 'It was not signed; the site sent a signed one on 3 Oct.', anika);
    const requests = await kernel.inspectors.requests(token);
    expect(!('refused' in requests) && requests[0]).toMatchObject({ answer: expect.stringContaining('not signed'), answeredBy: { name: 'Anika Rao' } });

    // Every view and download is in the log, as the inspector.
    const views = (await kernel.auditLog.list({ project: 'etmf', actorKinds: ['inspector'] }, anika)).entries.map((e) => e.action);
    expect(views).toEqual(['inspector.opened', 'inspector.listed', 'inspector.viewed', 'inspector.viewed', 'inspector.downloaded', 'inspector.asked']);
    expect((await kernel.inspectors.list('etmf', anika))[0]).toMatchObject({ views: 4, downloads: 1, questions: { open: 0, answered: 1 } });

    // Past its end date, or revoked, the link opens nothing.
    await db.pool.query(`update mw.inspector_links set expires_at = now() - interval '1 minute' where id = $1`, [link.id]);
    expect(await kernel.inspectors.open(token)).toEqual({ refused: 'expired' });
    await kernel.inspectors.revoke(link.id, anika);
    expect(await kernel.inspectors.documents(token, {})).toEqual({ refused: 'revoked' });
    expect(await kernel.inspectors.open('mwi_' + 'x'.repeat(43))).toEqual({ refused: 'unknown' });
  });

  // ---------------------------------------------------------------- the TMF index

  test('a record type added after 0010 ran (a new app\'s table, as EDC\'s are) is in the trail too', async () => {
    // Typed tables are made by the domain DDL at index, after the migrations: each gets the row
    // trigger that writes mw.record_versions, which the audit trigger watches. So a table made
    // later needs nothing of its own.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(projectDir, 'domains', 'edc', 'entities'), { recursive: true });
    writeFileSync(join(projectDir, 'domains', 'edc', 'domain.yaml'), 'domain: edc\nname: EDC\nowner: study_manager\nregulated: true\n');
    writeFileSync(join(projectDir, 'domains', 'edc', 'entities', 'subject.yaml'), 'entity: Subject\ntitle: "{code}"\nfields:\n  code: { type: Text, required: true }\n');
    expect((await kernel.index()).filter((d) => d.severity === 'error')).toEqual([]);
    const subject = await create('edc.Subject', { code: 'MW-301-101-001' });
    const trail = (await kernel.auditLog.list({ project: 'edc', entity: 'edc.Subject', recordId: subject }, anika)).entries;
    expect(trail.map((e) => e.action)).toEqual(['record.created']);
    expect(await kernel.auditLog.verify({ project: 'edc' })).toMatchObject({ ok: true });
  });

  test('the TMF index: expected, filed, missing and in QC by zone, and by site within a zone', async () => {
    await create('etmf.ExpectedDocument', { site: ids.site101, study: ids.study, artifact: 'IRB approval letter', phase: 'start_up' });
    await create('etmf.ExpectedDocument', { site: ids.site109, study: ids.study, artifact: 'Lab normal ranges', phase: 'start_up' });
    await create('etmf.ExpectedDocument', { site: ids.site109, study: ids.study, artifact: 'Site activation checklist', phase: 'start_up' });
    const tmf = await kernel.tmf.index({ project: 'etmf' }, anika);
    expect(tmf.zones).toHaveLength(11);
    const zone = (n: string) => tmf.zones.find((z) => z.number === n)!;
    expect(zone('05')).toMatchObject({ name: 'Site Management', expected: 5, filed: 4, missing: 1, inQc: 0 });
    expect(zone('04')).toMatchObject({ expected: 1, missing: 1 });
    expect(zone('08')).toMatchObject({ expected: 1, missing: 1 });
    expect(tmf.unplaced).toEqual(['Site activation checklist']);
    expect(tmf.kpis).toMatchObject({ expected: 7, filed: 4, missing: 3, inQc: 0, oldestInQcDays: null, filedLate: 1, lateAfterDays: 30 });
    expect(zone('05').filedLate).toBe(1);
    const site = await kernel.tmf.index({ project: 'etmf', zone: '05' }, anika);
    expect(site.zone!.sites.map((s) => [s.label, s.expected, s.filed, s.missing])).toEqual([['101', 2, 2, 0], ['104', 2, 2, 0], ['109', 1, 0, 1]]);
    expect(site.zone!.missing).toEqual([expect.objectContaining({ artifact: 'Investigator CV', site: '109' })]);
    expect(site.zone!.documents).toHaveLength(4);
  });
});

describe('Stage 5 on Stage 3', () => {
  test('a change request or an inspector question waits under its app; a step under its own project', () => {
    const cr = { kind: 'change-request', id: 'x', signoff: 'raiser', since: '', changeRequest: { project: 'etmf' } } as never;
    const question = { kind: 'inspector-question', id: 'q', since: '', question: { project: 'etmf' } } as never;
    expect([waitingAppOf(cr), waitingAppOf(question)]).toEqual(['etmf', 'etmf']);
    expect(waitingAppOf({ ...(cr as object), project: 'mw301' } as never)).toBeUndefined();
    expect(waitingAppOf({ kind: 'input', id: 's', project: 'mw301' } as never)).toBeUndefined();
  });
});

describe('roles and reach on Stage 3 studies (change requests are the app\'s)', () => {
  const person = (grants: { role: string; domain: string; project?: string }[], roles: string[] = []): PersonActor => ({ kind: 'person', personId: 'p', roles, grants });
  const inMw207 = person([{ role: 'qa', domain: 'etmf', project: 'mw207' }, { role: 'study_manager', domain: 'etmf', project: 'mw207' }]);
  const acrossApp = person([{ role: 'qa', domain: 'etmf' }]);

  test('a grant in one study holds its role in that study only, never for the app as a whole', () => {
    expect(holdsRole(inMw207, 'study_manager', 'etmf', 'mw207')).toBe(true);
    expect(holdsRole(inMw207, 'study_manager', 'etmf', 'mw301')).toBe(false);
    // QA's signature on a change request (the app's): no study is named, so a study's grant doesn't count.
    expect(holdsRole(inMw207, 'qa', 'etmf')).toBe(false);
    expect(holdsRole(acrossApp, 'qa', 'etmf')).toBe(true);
    expect(holdsRole(acrossApp, 'qa', 'etmf', 'mw301')).toBe(true);
    expect(holdsRole(person([], ['qa']), 'qa', 'etmf')).toBe(true);
    expect(holdsRole({ kind: 'system' }, 'qa', 'etmf')).toBe(false);
  });

  test('a person sees a study through a grant in it or across the app; the app as a whole only across it', () => {
    expect(reaches(inMw207, 'etmf', 'mw207')).toBe(true);
    expect(reaches(inMw207, 'etmf', 'mw301')).toBe(false);
    expect(reaches(inMw207, 'etmf')).toBe(false);
    expect(reaches(acrossApp, 'etmf')).toBe(true);
    // No grant in the app: workspace-wide roles see all of it (as mw.domain_project_visible).
    expect(reaches(person([{ role: 'cra', domain: 'edc', project: 'edc-mw301' }]), 'etmf', 'mw301')).toBe(true);
  });
});
