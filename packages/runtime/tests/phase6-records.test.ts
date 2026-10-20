// Phase 6, the records piece (docs/memwise/24-phase-6-interfaces.md §2–§6, §9, §11, §12): a
// two-domain project (`qa`, regulated, and `lab`) against a real Postgres. Records written by
// people and steps with reasons and versions, roles per domain, link pairing and invariant flags
// (the consumers the flow dispatcher runs, driven here by hand), record pages, review mode and
// signed steps, signed transitions, the page tree, dashboards, views, notes and mentions, the
// audit trail and its export. Example cases that start from records: phase6-cli.test.ts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PgIdentityStore, type TestDatabase } from '@memwise/db';
import { loadProject, type EntityEvent, type ProjectDefs } from '@memwise/defs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernel } from '../src/kernel.ts';
import { recordConsumers } from '../src/records/consumers.ts';
import { SIGN_FAILURES_BEFORE_LOCK } from '../src/regulated/signatures.ts';
import type { Kernel, PersonActor } from '../src/types.ts';
import { kernelDatabase, pgAvailable } from './helpers.ts';

const PROJECT = fileURLToPath(new URL('./fixtures/records-project', import.meta.url));
const PASSWORD = 'correct horse battery';

let db: TestDatabase;
let kernel: Kernel;
let project: ProjectDefs;
let lead: PersonActor; // qa_lead everywhere
let lead2: PersonActor; // qa_lead, for the lockout
let analyst: PersonActor; // qa_analyst in qa only (a grant)
let tech: PersonActor; // lab_tech
let seq = 0;

/** Runs every entity event since the last call through the records consumers, as the dispatcher would. */
async function dispatch(): Promise<EntityEvent[]> {
  const consumers = recordConsumers({ pool: kernel.pool, entities: () => project.entities, emit: () => undefined });
  const events = await kernel.records.events({ afterSeq: seq, limit: 1000 });
  for (const e of events) {
    for (const c of consumers) await c.handle(e);
    seq = e.seq;
  }
  return events;
}

const stepRun = async (runId: string, state: string) => {
  const run = await kernel.waitForRun(runId, { until: (r) => r.state === state || r.status !== 'active', timeoutMs: 30_000 });
  expect(run.state).toBe(state);
  const id = `${runId}/${run.enteredSeq}/${state}`;
  const deadline = Date.now() + 30_000;
  while ((await kernel.getStepRecord(id))?.status !== 'waiting') {
    if (Date.now() > deadline) throw new Error(`${id} never waited`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return id;
};

describe.skipIf(!pgAvailable)('Phase 6 records', () => {
  beforeAll(async () => {
    db = await kernelDatabase('mw_rt_p6r');
    project = (await loadProject(PROJECT)).project;
    kernel = await createKernel({
      databaseUrl: db.url, projectDir: PROJECT, tools: [], modelRoles: {}, providers: [],
      filesDir: mkdtempSync(join(tmpdir(), 'mw-p6r-files-')), logLevel: 'error',
    });
    const diagnostics = await kernel.index();
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const person = async (name: string, roles: string[]) => {
      const p = await kernel.people.create({ name, email: `${name.toLowerCase().split(' ')[0]}@example.com`, roles, password: PASSWORD });
      return kernel.people.actorFor(p.id);
    };
    lead = await person('Lena Lead', ['qa_lead']);
    lead2 = await person('Lars Lead', ['qa_lead']);
    analyst = await person('Ana Analyst', []);
    tech = await person('Theo Tech', ['lab_tech']);
  }, 120_000);

  afterAll(async () => {
    await kernel?.shutdown();
    await db?.drop();
  }, 60_000);

  test('the workspace and its domains; a regulated workspace wants long passwords', async () => {
    expect(await kernel.domains.workspace()).toEqual({ name: 'Brightwater Labs', stormLimit: 40, regulated: true });
    const domains = await kernel.domains.list({ kind: 'system' });
    expect(domains.map((d) => [d.id, d.regulated, d.owner])).toEqual([['lab', false, 'lab_tech'], ['qa', true, 'qa_lead']]);
    const qa = domains.find((d) => d.id === 'qa')!;
    expect(qa.entities.map((e) => e.key).sort()).toEqual(['qa.Batch', 'qa.Instrument', 'qa.Report']);
    expect(qa.workflows).toEqual(['review-report']);
    expect(qa.pages).toEqual([{ id: 'batch-health', title: 'Batch health', under: { entity: 'Batch' } }]);
    expect(qa.views).toEqual([{ id: 'open-reports', title: 'Open reports', entity: 'Report' }]);
    expect(qa.retentionMs).toBe(10 * 365 * 86_400_000);
    await expect(kernel.people.create({ name: 'Short', email: 'short@example.com', password: 'short' })).rejects.toThrow(/at least 12 characters/);

    // The policy layers of a qa playbook: the workspace house rules, then the qa domain's policy.
    const { effective } = await kernel.effectivePolicy('review-report', 'review');
    expect(effective.effects.irreversible).toMatchObject({ value: 'deny', origin: { layer: 'workspace' } });
    expect(effective.effects.outbound).toMatchObject({ value: 'approve', origin: { layer: 'domain', name: 'qa-domain' } });
    expect(effective.budgets.modelCalls).toMatchObject({ value: 20 });
  });

  test('roles count per domain: a grant in qa lets a person write qa records, not lab ones', async () => {
    const noRole = await kernel.records.create({ entity: 'qa.Batch', values: { code: 'B-000' }, reason: 'test' }, analyst);
    expect(noRole).toMatchObject({ applied: false, status: 'forbidden' });
    expect(noRole.message).toContain('Quality');

    await expect(kernel.domains.setGrants(analyst.personId, [{ role: 'qa_analyst', domain: 'nowhere' }], { kind: 'system' })).rejects.toThrow(/no domain nowhere/);
    expect(await kernel.domains.setGrants(analyst.personId, [{ role: 'qa_analyst', domain: 'qa' }], { kind: 'system' }))
      .toEqual([{ role: 'qa_analyst', domain: 'qa' }]);
    expect(await kernel.domains.grants(analyst.personId)).toEqual([{ role: 'qa_analyst', domain: 'qa' }]);
    analyst = await kernel.people.actorFor(analyst.personId);
    expect(analyst.grants).toEqual([{ role: 'qa_analyst', domain: 'qa' }]);

    expect(await kernel.records.create({ entity: 'lab.Instrument', values: { serial: 'X' } }, analyst)).toMatchObject({ status: 'forbidden' });
  });

  let batch = '';
  let report = '';
  test('a regulated domain wants a reason for every change of a controlled field; every change is a version', async () => {
    const missing = await kernel.records.create({ entity: 'qa.Batch', values: { code: 'B-001', product: 'Saline' } }, analyst);
    expect(missing).toMatchObject({ applied: false, status: 'reason-required' });
    expect(missing.message).toContain('code');

    const b = await kernel.records.create({ entity: 'qa.Batch', values: { code: 'B-001', product: 'Saline' }, reason: 'New batch from the line' }, analyst);
    expect(b).toMatchObject({ applied: true, status: 'applied', version: 1 });
    batch = b.id!;

    expect(await kernel.records.create({ entity: 'qa.Report', values: { title: 'Sterility', batch, score: 'high' }, reason: 'x' }, analyst))
      .toMatchObject({ applied: false, status: 'invalid', errors: { score: expect.any(Array) } });
    expect(await kernel.records.create({ entity: 'qa.Report', values: { title: 'Sterility' }, reason: 'x' }, analyst))
      .toMatchObject({ applied: false, status: 'invalid', errors: { batch: ['required'], score: ['required'] } });

    const r = await kernel.records.create({ entity: 'qa.Report', values: { title: 'Sterility', batch, score: 97 }, reason: 'Written up' }, analyst);
    expect(r).toMatchObject({ applied: true });
    report = r.id!;

    // `remarks` says `controlled: false`: no reason needed.
    expect(await kernel.records.update({ entity: 'qa.Report', id: report, values: { remarks: 'first pass' } }, analyst)).toMatchObject({ applied: true, version: 2 });
    expect(await kernel.records.update({ entity: 'qa.Report', id: report, values: { score: 98 } }, analyst)).toMatchObject({ status: 'reason-required' });
    expect(await kernel.records.update({ entity: 'qa.Report', id: report, values: { score: 98 }, reason: 'Recounted' }, analyst)).toMatchObject({ applied: true, version: 3 });
    expect(await kernel.records.update({ entity: 'qa.Report', id: report, values: { released_pct: 5 }, reason: 'x' }, analyst)).toMatchObject({ status: 'invalid' });

    const page = (await kernel.records.page('qa.Report', report, analyst))!;
    expect(page).toMatchObject({ entity: 'qa.Report', domain: 'qa', regulated: true, title: 'Sterility', status: 'draft' });
    expect(page.history.map((h) => [h.version, h.reason, h.changed])).toEqual([
      [3, 'Recounted', ['score']], [2, undefined, ['remarks']], [1, 'Written up', expect.arrayContaining(['title', 'batch', 'score'])],
    ]);
    const score = page.fields.find((f) => f.name === 'score')!;
    expect(score).toMatchObject({ value: 98, editable: true, controlled: true, source: { kind: 'person', personId: analyst.personId } });
    expect(page.fields.find((f) => f.name === 'batch')).toMatchObject({ ref: { entity: 'qa.Batch', id: batch, title: 'B-001' } });
    expect(page.parents).toEqual([expect.objectContaining({ entity: 'qa.Batch', id: batch, title: 'B-001' })]);
    expect(await kernel.audit.verifyChain('qa.Report', report)).toEqual({ ok: true });
  });

  test('lifecycle: guards say what failed; roles per domain; a signed transition needs a matching signature', async () => {
    const guard = await kernel.records.transition({ entity: 'qa.Report', id: report, transition: 'submit' }, analyst);
    expect(guard).toMatchObject({ applied: false, status: 'guard' });
    expect(guard.message).toContain('result is set');
    expect(await kernel.records.update({ entity: 'qa.Report', id: report, values: { result: 'pass' }, reason: 'Read the plates' }, analyst)).toMatchObject({ applied: true });
    expect(await kernel.records.transition({ entity: 'qa.Report', id: report, transition: 'release' }, analyst)).toMatchObject({ applied: false });
    expect(await kernel.records.transition({ entity: 'qa.Report', id: report, transition: 'reject' }, analyst)).toMatchObject({ applied: false });
    expect(await kernel.records.transition({ entity: 'qa.Report', id: report, transition: 'submit' }, analyst)).toMatchObject({ applied: true, status: 'applied' });

    const page = (await kernel.records.page('qa.Report', report, lead))!;
    expect(page.lifecycle).toMatchObject({ current: 'in_review', states: ['draft', 'in_review', 'released'] });
    const options = Object.fromEntries(page.lifecycle!.transitions.map((t) => [t.name, t]));
    expect(options.reject).toMatchObject({ to: 'draft', allowed: true });
    expect(options.release).toMatchObject({ to: 'released', allowed: false, signed: true });

    // The list form: any role in the domain may move to any state.
    const inst = await kernel.records.create({ entity: 'lab.Instrument', values: { serial: 'SN-1', model: 'Autoclave 9', location: 'Room 2' } }, tech);
    expect(inst).toMatchObject({ applied: true });
    expect(await kernel.records.transition({ entity: 'lab.Instrument', id: inst.id!, transition: 'to_retired' }, tech)).toMatchObject({ applied: true });
    expect(await kernel.records.transition({ entity: 'lab.Instrument', id: inst.id!, transition: 'to_active' }, analyst)).toMatchObject({ applied: false });
    expect(await kernel.records.transition({ entity: 'lab.Instrument', id: inst.id!, transition: 'to_active' }, tech)).toMatchObject({ applied: true });
  });

  test('links: one match pairs the records and the followed fields read through; several ask the domain owner', async () => {
    const mine = await kernel.records.create({ entity: 'qa.Instrument', values: { serial: 'SN-1' }, reason: 'Used for sterility' }, analyst);
    await dispatch();
    const page = (await kernel.records.page('qa.Instrument', mine.id!, lead))!;
    expect(page.fields.find((f) => f.name === 'model')).toMatchObject({ value: 'Autoclave 9', followed: true, editable: false, source: { kind: 'link', domain: 'lab', entity: 'lab.Instrument' } });

    // Two lab instruments with the same serial: no pairing, a question for the qa owner.
    await kernel.records.create({ entity: 'lab.Instrument', values: { serial: 'SN-2', model: 'Incubator A' } }, tech);
    await kernel.records.create({ entity: 'lab.Instrument', values: { serial: 'SN-2', model: 'Incubator B' } }, tech);
    const twin = await kernel.records.create({ entity: 'qa.Instrument', values: { serial: 'SN-2' }, reason: 'Incubation' }, analyst);
    await dispatch();
    const ids = new PgIdentityStore();
    expect(await ids.links(kernel.pool, 'qa.Instrument', twin.id!)).toEqual([]);
    const candidates = await ids.candidates(kernel.pool, { status: 'pending', plugin: 'domain:lab' });
    expect(candidates.filter((c) => c.recordId === twin.id).length).toBe(2);
    const leadInbox = await kernel.inbox(lead);
    expect(leadInbox.filter((i) => i.kind === 'identity').length).toBe(2);
    expect((await kernel.inbox(tech)).filter((i) => i.kind === 'identity')).toEqual([]);
    expect(await kernel.identity.decide({ candidateId: candidates[0]!.id, decision: 'confirm', by: tech })).toMatchObject({ applied: false });
  });

  test('invariants raise a flag for the domain owner and close it when they hold again', async () => {
    const bad = await kernel.records.create({ entity: 'qa.Report', values: { title: 'Endotoxin', batch, score: 120 }, reason: 'Typed in' }, analyst);
    await dispatch();
    const open = await kernel.records.flags({ entity: 'qa.Report', recordId: bad.id! });
    expect(open).toEqual([expect.objectContaining({ invariant: 'score <= 100', message: expect.stringContaining('score is 120') })]);
    const item = (await kernel.inbox(lead)).find((i) => i.kind === 'flag');
    expect(item).toMatchObject({ kind: 'flag', domain: 'qa', title: expect.stringContaining('Endotoxin') });
    expect((await kernel.inbox(tech)).some((i) => i.kind === 'flag')).toBe(false);
    expect((await kernel.records.page('qa.Report', bad.id!, lead))!.flags.length).toBe(1);
    expect((await kernel.domains.list({ kind: 'system' })).find((d) => d.id === 'qa')!.flags).toBe(1);

    await kernel.records.update({ entity: 'qa.Report', id: bad.id!, values: { score: 92 }, reason: 'Typo' }, analyst);
    await dispatch();
    expect(await kernel.records.flags({ entity: 'qa.Report', recordId: bad.id! })).toEqual([]);
    expect(await kernel.records.flags({ entity: 'qa.Report', recordId: bad.id!, open: false })).toEqual([expect.objectContaining({ closedAt: expect.any(String) })]);
  });

  test('a signed review: review mode on the record page, the password signs, five wrong ones lock signing, the signed transition goes through', async () => {
    const { runId, caseId } = await kernel.startRun({ workflowId: 'review-report', case: { report } });
    const review = await stepRun(runId, 'review');

    // `prepare` changed the report through the entity tool, as the step, with the step's reason.
    const prepared = (await kernel.records.page('qa.Report', report, lead))!;
    expect(prepared.fields.find((f) => f.name === 'remarks')).toMatchObject({ value: 'Ready for review', source: { kind: 'step', stepRunId: `${runId}/0/prepare` } });
    expect(prepared.history[0]).toMatchObject({ reason: `Review a test report: Mark it ready for review, case ${caseId}`, via: `${runId}/0/prepare`, changed: ['remarks'] });

    const items = (await kernel.inbox(lead)).filter((i) => i.kind === 'input' && i.stepRunId === review);
    expect(items[0]).toMatchObject({ domain: 'qa', review: { kind: 'document', entity: 'qa.Report', recordId: report }, sign: { meaning: 'Reviewed and approved for release' } });
    expect((await kernel.getCaseView(caseId, lead))!.domain).toBe('qa');

    const page = (await kernel.records.page('qa.Report', report, lead, { review: { stepRunId: review } }))!;
    expect(page.review).toMatchObject({
      stepRunId: review, caseId, stepId: 'review', outcomes: ['approved', 'rejected'],
      proposed: [expect.objectContaining({ field: 'review_note' })],
      sign: { meaning: 'Reviewed and approved for release', as: { personId: lead.personId, name: 'Lena Lead', roles: ['qa_lead'] } },
    });

    const answer = { stepRunId: review, outcome: 'approved', values: { review_note: 'Fine.' } };
    expect(await kernel.submitStep({ ...answer, by: lead })).toMatchObject({ applied: false, status: 'signature-required' });
    expect(await kernel.submitStep({ ...answer, by: analyst, signature: { password: PASSWORD } })).toMatchObject({ applied: false, status: 'forbidden' });

    // Lars gets his password wrong five times: signing locks for 30 minutes, even with the right one.
    for (let i = 1; i <= SIGN_FAILURES_BEFORE_LOCK; i++) {
      const r = await kernel.submitStep({ ...answer, by: lead2, signature: { password: `wrong ${i}` } });
      expect(r).toMatchObject({ applied: false, status: 'signature-failed' });
      if (i === SIGN_FAILURES_BEFORE_LOCK) expect(r.message).toContain('locked');
    }
    expect(await kernel.submitStep({ ...answer, by: lead2, signature: { password: PASSWORD } })).toMatchObject({ applied: false, status: 'locked' });
    const events = await kernel.pool.query(`select kind from mw.auth_events where person_id = $1 order by at, id`, [lead2.personId]);
    expect(events.rows.map((r) => r.kind)).toEqual([...Array(SIGN_FAILURES_BEFORE_LOCK).fill('signature-failed'), 'locked']);

    expect(await kernel.submitStep({ ...answer, by: lead, signature: { password: PASSWORD } })).toEqual({ applied: true, status: 'applied' });
    const done = await kernel.waitForRun(runId, { until: (r) => r.status !== 'active', timeoutMs: 30_000 });
    expect(done).toMatchObject({ state: 'end', status: 'done' });

    const after = (await kernel.records.page('qa.Report', report, lead))!;
    expect(after.status).toBe('released');
    expect(after.signatures).toEqual([expect.objectContaining({
      personId: lead.personId, name: 'Lena Lead', meaning: 'Reviewed and approved for release', caseId, stepRunId: review, changedSince: false,
    })]);
    const released = after.history[0]!;
    expect(released.changed).toEqual(['status']);
    expect(released.byLabel).toContain('Release the report');
    expect(released.reason).toContain('Review a test report: Release the report');

    // A change after signing shows on the signature.
    await kernel.records.update({ entity: 'qa.Report', id: report, values: { result: 'pass, retested' }, reason: 'Retest' }, lead);
    expect((await kernel.records.page('qa.Report', report, lead))!.signatures[0]!.changedSince).toBe(true);
  }, 90_000);

  test('a signed transition without a signature on the record is refused for the step', async () => {
    const r = await kernel.records.create({ entity: 'qa.Report', values: { title: 'Bioburden', batch, score: 99, result: 'pass' }, status: 'in_review' }, { kind: 'system' });
    const { runId } = await kernel.startRun({ workflowId: 'review-report', case: { report: r.id }, startAt: 'release' });
    const run = await kernel.waitForRun(runId, { until: (x) => x.status !== 'active', timeoutMs: 30_000 });
    expect(run.status).toBe('stopped');
    expect(run.stopReason).toContain('signature');
    expect((await kernel.records.page('qa.Report', r.id!, lead))!.status).toBe('in_review');
  }, 60_000);

  test('the page tree, a dashboard, views, notes and mentions', async () => {
    const top = await kernel.records.tree('qa', lead);
    expect(top).toEqual(expect.arrayContaining([
      { kind: 'record', entity: 'qa.Batch', id: batch, title: 'B-001', hasChildren: true },
      expect.objectContaining({ kind: 'group', entity: 'qa.Instrument', title: 'Instruments', count: 2 }),
    ]));
    const under = await kernel.records.tree('qa', lead, { parent: { entity: 'qa.Batch', id: batch } });
    expect(under[0]).toEqual({ kind: 'page', pageId: 'batch-health', title: 'Batch health', params: { batch } });
    expect(under[1]).toMatchObject({ kind: 'group', entity: 'qa.Report', title: 'Reports', count: 3 });
    expect(under.filter((n) => n.kind === 'record').length).toBe(3);

    const dash = await kernel.records.dashboard('qa', 'batch-health', { batch }, lead);
    expect(dash.blocks[0]).toMatchObject({ kind: 'kpi', label: 'Released', format: 'percent', target: 100 });
    expect((dash.blocks[0] as { value: number }).value).toBeCloseTo(100 / 3, 0);
    expect(dash.blocks[1]).toMatchObject({ kind: 'kpi', label: 'Reports', value: 3, format: 'number' });
    expect(dash.blocks[2]).toMatchObject({ kind: 'table', title: 'Open reports', result: { entity: 'qa.Report', total: 2 } });
    expect(dash.blocks[3]).toMatchObject({ kind: 'heatmap', columns: ['Released', 'Reports'], rows: [{ record: { id: batch, title: 'B-001' }, values: [expect.any(Number), 3] }] });
    expect(dash.blocks[4]).toEqual({ kind: 'text', markdown: 'Reports are released once QA signs them.' });
    await expect(kernel.records.dashboard('qa', 'batch-health', {}, lead)).rejects.toThrow(/needs batch/);

    const q = await kernel.records.query({ entity: 'Report', domain: 'qa', filter: "status != 'released'", sort: [{ field: 'title' }], group: 'status' }, lead);
    expect(q.rows.map((r) => r.title)).toEqual(['Bioburden', 'Endotoxin']);
    expect(q.groups).toEqual([{ key: 'draft', count: 1 }, { key: 'in_review', count: 1 }]);

    const mineView = await kernel.records.saveView('qa', { id: 'my-high', title: 'High scores', entity: 'Report', filter: 'score >= 95', layout: 'table' }, lead);
    const views = await kernel.records.views('qa', lead, { entity: 'Report' });
    expect(views.map((v) => [v.id, v.personal])).toEqual([['open-reports', false], [mineView.id, true]]);
    expect(await kernel.records.views('qa', lead2)).toEqual([expect.objectContaining({ id: 'open-reports' })]);
    await expect(kernel.records.saveView('qa', { id: 'open-reports', title: 'x', entity: 'Report', layout: 'table' }, lead)).rejects.toThrow(/shared view/);

    const instruments = await kernel.records.query({ entity: 'qa.Instrument' }, lead);
    const target = instruments.rows[0]!;
    expect(await kernel.records.saveNote({ entity: 'qa.Report', id: report, body: `Checked on [[qa.Instrument:${target.id}]].` }, lead)).toMatchObject({ applied: true, version: 1 });
    const notePage = (await kernel.records.page('qa.Report', report, lead))!;
    expect(notePage.notes).toMatchObject({ body: expect.stringContaining('Checked on'), version: 1, by: 'Lena Lead' });
    const targetPage = (await kernel.records.page('qa.Instrument', target.id, lead))!;
    expect(targetPage.mentions).toEqual([expect.objectContaining({ sourceKind: 'note', label: 'Notes on Sterility' })]);

    expect(await kernel.records.evaluate('qa.Report', report, 'score >= 95 and status = \'released\'', lead)).toEqual({ holds: true, values: { score: 98, status: 'released' } });
  });

  test('the audit trail: versions with hashes, the chain, signatures, cases and step runs; JSON and PDF', async () => {
    const trail = (await kernel.audit.trail('qa.Report', report, lead))!;
    expect(trail).toMatchObject({ entity: 'qa.Report', id: report, domain: 'qa', regulated: true, chain: { ok: true }, retentionMs: 10 * 365 * 86_400_000 });
    expect(trail.versions.map((v) => v.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(trail.versions[1]!.prevHash).toBe(trail.versions[0]!.hash);
    expect(trail.signatures.length).toBe(1);
    expect(trail.cases.length).toBe(1);
    expect(trail.cases[0]!.stepRuns.map((s) => [s.stepId, s.outcome])).toEqual([['prepare', 'done'], ['review', 'approved'], ['release', 'done']]);

    const json = (await kernel.audit.export('qa.Report', report, 'json', lead))!;
    expect(json).toMatchObject({ mime: 'application/json', name: expect.stringMatching(/\.json$/) });
    expect(JSON.parse(new TextDecoder().decode(json.data)).versions.length).toBe(8);
    const pdf = (await kernel.audit.export('qa.Report', report, 'pdf', lead))!;
    expect(pdf.mime).toBe('application/pdf');
    expect(new TextDecoder().decode(pdf.data.slice(0, 8))).toStartWith('%PDF-1.');
    expect(new TextDecoder('latin1').decode(pdf.data)).toContain('Signature manifest');
    expect(await kernel.audit.trail('qa.Report', 'repo_nothing', lead)).toBeUndefined();
  });

  test('entity tools: update, transition and list, with the step reason', async () => {
    const names = (await kernel.project()).project.entities;
    expect(Object.keys(names).sort()).toEqual(['lab.Instrument', 'qa.Batch', 'qa.Instrument', 'qa.Report']);
    const rows = await kernel.listEntities('qa.Report', { kind: 'system' });
    expect(rows.length).toBe(3);
  });
});
