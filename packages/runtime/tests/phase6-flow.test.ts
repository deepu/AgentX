// Phase 6 flow (docs/memwise/24-phase-6-interfaces.md §7, §8, §10, §4): entity events through
// the dispatcher, triggers of every kind with the storm guard, incoming messages (directly and
// through a signed webhook), the four hand-off blocks with the cancel cascade and the cross-domain
// rule, and entity state timers, through a real kernel on a two-domain project and Postgres.
// Records are seeded through the storage as the system; runs are driven with events.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PgEntityStore, withActor, type TestDatabase } from '@memwise/db';
import type { EntityTypeDef } from '@memwise/defs';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import type { Kernel, PersonActor, RunRecord } from '../src/types.ts';
import { flowProject } from './fixtures/flow-project.ts';
import { kernelDatabase, pgAvailable } from './helpers.ts';

let db: TestDatabase;
let kernel: Kernel;
let manager: PersonActor; // study_manager
let specialist: PersonActor; // tmf_specialist
let dataManager: PersonActor; // data_manager
const store = new PgEntityStore();
const DAY = 86_400_000;
let startedAt = 0;

const def = async (key: string): Promise<EntityTypeDef> => (await kernel.project()).project.entities[key]!;
const seed = async (key: string, values: Record<string, unknown>, lifecycle?: string) => {
  const d = await def(key);
  return withActor(db.pool, { kind: 'system' }, (c) => store.create(c, d, values, lifecycle ? { lifecycle } : {}));
};
const move = async (key: string, id: string, to: string, transition: string) => {
  const d = await def(key);
  return withActor(db.pool, { kind: 'system' }, (c) => store.transition(c, d, id, { to, transition }));
};
const change = async (key: string, id: string, values: Record<string, unknown>) => {
  const d = await def(key);
  return withActor(db.pool, { kind: 'system' }, (c) => store.update(c, d, id, values));
};
const rows = async (sql: string, params: unknown[] = []) => (await db.pool.query(sql, params)).rows;
const one = async (sql: string, params: unknown[] = []) => (await rows(sql, params))[0];
const settle = () => kernel.triggers.settle(30_000);
const runIn = (runId: string, state: string, status: RunRecord['status'] = 'active') =>
  kernel.waitForRun(runId, { until: (r) => (r.state === state && r.status === status) || (r.status !== 'active' && r.status !== status), timeoutMs: 30_000 });
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
async function until<T>(what: string, get: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const runsOf = (workflowId: string) => rows(`select id, case_id, state, status, stop_reason, acts_for from mw.runs where workflow_id = $1 order by created_at, id`, [workflowId]);
const childrenOf = (runId: string) => rows(`select * from mw.case_links where parent_run_id = $1 order by item_index`, [runId]);

describe.skipIf(!pgAvailable)('Phase 6 flow', () => {
  beforeAll(async () => {
    db = await kernelDatabase('mw_rt_p6_flow');
    startedAt = Date.now();
    kernel = await createKernel({
      databaseUrl: db.url, projectDir: flowProject(), tools: [], modelRoles: {}, providers: [],
      filesDir: mkdtempSync(join(tmpdir(), 'mw-flow-files-')), logLevel: 'error',
    });
    const diagnostics = await kernel.index();
    expect(diagnostics.filter((d) => d.severity === 'error' && d.code !== 'cross-domain-not-allowed')).toEqual([]);
    const person = async (name: string, roles: string[]) =>
      kernel.people.actorFor((await kernel.people.create({ name, email: `${name.split(' ')[0]!.toLowerCase()}@example.com`, roles })).id);
    manager = await person('Mira Study', ['study_manager']);
    specialist = await person('Tess Filer', ['tmf_specialist']);
    dataManager = await person('Dan Data', ['data_manager']);
  }, 120_000);

  afterAll(async () => {
    await kernel?.shutdown();
    await db?.drop();
  }, 60_000);

  // ---------------------------------------------------------------- triggers on entity events, wait_until, timers

  let siteId = '';
  let activation = '';

  test('entered: a Site moving to activating starts one Activate a site case, acting for the owner', async () => {
    siteId = await seed('etmf.Site', { site_number: 'US-012', name: 'Harbor Oncology' });
    await move('etmf.Site', siteId, 'activating', 'picked');
    await settle();
    const firings = await kernel.triggers.firings({ triggerId: 'activate-site#0' });
    expect(firings).toHaveLength(1);
    expect(firings[0]).toMatchObject({ kind: 'entered', record: siteId, status: 'started' });
    expect(firings[0]!.key).toMatch(/^entered:activate-site#0:evt_/);
    const runs = await runsOf('activate-site');
    expect(runs).toHaveLength(1);
    activation = runs[0].id;
    expect(runs[0]).toMatchObject({ state: 'collect_pack', status: 'active', acts_for: 'study_manager' });
    expect(firings[0]!.runId).toBe(activation);
    const c = await kernel.getCase(runs[0].case_id);
    expect(c!.values.site).toMatchObject({ value: siteId, provenance: { kind: 'input', by: 'trigger:activate-site#0' } });
  });

  test('the same event delivered again (ledger and cursor lost) starts nothing new', async () => {
    await db.pool.query(`delete from mw.event_deliveries where consumer = 'triggers'`);
    await db.pool.query(`update mw.trigger_state set cursor = '{"seq":0}' where trigger_id = 'dispatcher'`);
    await settle();
    expect(await kernel.triggers.firings({ triggerId: 'activate-site#0' })).toHaveLength(1);
    expect(await runsOf('activate-site')).toHaveLength(1);
    const delivered = await one(`select count(*)::int as n from mw.event_deliveries where consumer = 'triggers'`);
    expect(delivered.n).toBeGreaterThan(0);
  });

  test('wait_until waits on the record and the case view shows it', async () => {
    const run = await kernel.getRun(activation);
    const view = await kernel.getCaseView(run!.caseId, manager);
    expect(view!.waiting).toMatchObject({
      record: { entity: 'etmf.Site', id: siteId, title: 'US-012 · Harbor Oncology', status: 'activating' },
      condition: 'start_up_pack_complete = 100%', holds: false,
    });
  });

  let docs: string[] = [];
  test('wait_until moves on exactly once when the rollup reaches 100%', async () => {
    docs = [await seed('etmf.ExpectedDocument', { name: 'CV', site: siteId }), await seed('etmf.ExpectedDocument', { name: 'Protocol', site: siteId })];
    await move('etmf.ExpectedDocument', docs[0]!, 'filed', 'to_filed');
    await settle();
    expect((await kernel.getRun(activation))!.state).toBe('collect_pack');
    const run = await kernel.getRun(activation);
    expect((await kernel.getCaseView(run!.caseId, manager))!.waiting).toMatchObject({ holds: false, values: { start_up_pack_complete: 50 } });

    await move('etmf.ExpectedDocument', docs[1]!, 'filed', 'to_filed');
    await settle();
    await runIn(activation, 'approve');
    // More changes to the record send nothing more.
    await change('etmf.Site', siteId, { name: 'Harbor Oncology, Boston' });
    await settle();
    const met = (await kernel.getTransitions(activation)).filter((t) => t.event.type === 'met');
    expect(met).toHaveLength(1);
    expect(met[0]).toMatchObject({ from: 'collect_pack', to: 'approve', accepted: true });
    expect((await kernel.getCaseView(run!.caseId, manager))!.waiting).toBeUndefined();
  });

  test('wait_until honours its timeout and stops watching', async () => {
    const other = await seed('etmf.Site', { site_number: 'US-013', name: 'Bay Clinic' });
    const { runId } = await kernel.startRun({ workflowId: 'quick-wait', case: { site: other }, startAt: 'collect_pack' });
    await settle();
    expect(await one(`select status from mw.run_outbox where run_id = $1 and kind = 'wait_until'`, [runId])).toEqual({ status: 'waiting' });
    await runIn(runId, 'needs_person');
    expect(await one(`select status from mw.run_outbox where run_id = $1 and kind = 'wait_until'`, [runId])).toEqual({ status: 'left' });
    const d = await seed('etmf.ExpectedDocument', { name: 'CV', site: other }, 'filed');
    await settle();
    expect(d).toBeTruthy();
    expect((await kernel.getRun(runId))!.state).toBe('needs_person');
    expect((await kernel.getTransitions(runId)).some((t) => t.event.type === 'met')).toBe(false);
  });

  test('state timers: remind the role after the time in a state', async () => {
    // US-012 entered activating above; its 1 s reminder is due by now.
    await new Promise((r) => setTimeout(r, 1100));
    await settle();
    const notes = await rows(`select role, kind, text, entity, record_id, run_id from mw.notifications where entity = 'etmf.Site' and record_id = $1`, [siteId]);
    expect(notes).toEqual([{
      role: 'study_manager', kind: 'reminder', text: 'Reminder: US-012 · Harbor Oncology, Boston has been activating for 1 second',
      entity: 'etmf.Site', record_id: siteId, run_id: null,
    }]);
    expect(await one(`select status from mw.entity_timers where record_id = $1 and state = 'activating'`, [siteId])).toEqual({ status: 'fired' });
  });

  test('state timers: a transition timer moves the record as the system; leaving a state cancels its timers', async () => {
    const quick = await seed('etmf.Site', { site_number: 'US-014', name: 'Quick Site' });
    await move('etmf.Site', quick, 'activating', 'picked');
    await settle();
    await move('etmf.Site', quick, 'open', 'approved'); // before its reminder: cancelled
    await settle();
    expect(await rows(`select state, status from mw.entity_timers where record_id = $1 order by state`, [quick]))
      .toEqual([{ state: 'activating', status: 'cancelled' }, { state: 'open', status: 'pending' }]);
    await new Promise((r) => setTimeout(r, 1100));
    await settle();
    expect(await one(`select status, message from mw.entity_timers where record_id = $1 and state = 'open'`, [quick])).toEqual({ status: 'fired', message: null });
    const row = await withActor(db.pool, { kind: 'system' }, async (c) => store.get(c, await def('etmf.Site'), quick));
    expect(row!.lifecycle).toBe('closed');
    const v = await rows(`select by, reason from mw.record_versions where entity = 'etmf.Site' and record_id = $1 order by version desc limit 1`, [quick]);
    expect(v[0].by).toBe('system');
  });

  // ---------------------------------------------------------------- date triggers and schedules

  test('schedule: first slot two weeks from the start, then a closed desktop catches up once', async () => {
    const now = new Date();
    expect((await kernel.triggers.sweep(now)).filter((f) => f.triggerId === 'fortnightly#0')).toEqual([]);
    // The kernel's sweep on start put the first slot one period after it started.
    const state = await one(`select next_due from mw.trigger_state where trigger_id = 'fortnightly#0'`);
    expect(Math.abs(new Date(state.next_due).getTime() - (startedAt + 14 * DAY))).toBeLessThan(5 * 60_000);
    const away = new Date(now.getTime() + 7 * 7 * DAY); // three slots missed
    const fired = await kernel.triggers.sweep(away);
    expect(fired.filter((f) => f.triggerId === 'fortnightly#0')).toHaveLength(1);
    expect((await kernel.triggers.sweep(away)).filter((f) => f.triggerId === 'fortnightly#0')).toEqual([]);
    const next = await one(`select next_due from mw.trigger_state where trigger_id = 'fortnightly#0'`);
    expect(new Date(next.next_due).getTime()).toBeGreaterThan(away.getTime());
    const runs = await runsOf('fortnightly');
    expect(runs).toHaveLength(1);
    expect((await kernel.getCase(runs[0].case_id))!.values.note!.value).toBe('scheduled review');
  });

  test('date trigger: one case per record per date, and again when the date changes', async () => {
    const now = new Date();
    const soon = await seed('etmf.Person', { name: 'Dr. Lena Vogel', cv_expires: isoDate(Date.now() + 10 * DAY) });
    const later = await seed('etmf.Person', { name: 'Dr. Omar Haddad', cv_expires: isoDate(Date.now() + 60 * DAY) });
    const first = (await kernel.triggers.sweep(now)).filter((f) => f.triggerId === 'watch-expiries#0');
    expect(first.map((f) => f.record)).toEqual([soon]);
    expect(first[0]!.key).toBe(`date:watch-expiries#0:${soon}:${isoDate(Date.now() + 10 * DAY)}`);
    expect((await kernel.triggers.sweep(now)).filter((f) => f.triggerId === 'watch-expiries#0')).toEqual([]);

    const summary = (await kernel.triggers.list()).find((t) => t.id === 'watch-expiries#0')!;
    expect(summary).toMatchObject({ description: "30 days before a Person's CV expires", firings: 1, held: 0 });
    expect(summary.nextDue?.record).toMatchObject({ entity: 'etmf.Person', id: later, title: 'Dr. Omar Haddad' });
    expect(summary.nextDue!.at.slice(0, 10)).toBe(isoDate(new Date(`${isoDate(Date.now() + 30 * DAY)}T00:00:00`).getTime()));

    await change('etmf.Person', soon, { cv_expires: isoDate(Date.now() + 20 * DAY) });
    const moved = (await kernel.triggers.sweep(now)).filter((f) => f.triggerId === 'watch-expiries#0');
    expect(moved.map((f) => f.record)).toEqual([soon]);
    expect((await kernel.triggers.sweep(new Date(Date.now() + 40 * DAY))).filter((f) => f.triggerId === 'watch-expiries#0').map((f) => f.record)).toEqual([later]);
    expect(await runsOf('watch-expiries')).toHaveLength(3);
  });

  test('the Automations list says what each trigger does', async () => {
    const list = await kernel.triggers.list();
    const words = Object.fromEntries(list.map((t) => [t.id, t.description]));
    expect(words).toMatchObject({
      'activate-site#0': 'When a Site enters Activating',
      'watch-expiries#0': "30 days before a Person's CV expires",
      'fortnightly#0': 'Every 2 weeks',
      'route-message#0': 'When an email arrives at etmf',
      'welcome-contact#0': 'When a Contact is created',
    });
    expect(list.find((t) => t.id === 'fortnightly#0')!.nextDue).toBeDefined();
    expect(list.find((t) => t.id === 'activate-site#0')).toMatchObject({ domain: 'etmf', firings: 2 }); // US-012 and US-014
  });

  // ---------------------------------------------------------------- incoming messages

  const pdf = Buffer.from('%PDF-1.4 a tiny CV').toString('base64');
  const email = (messageId: string) => ({
    messageId, from: 'lena.vogel@harbor.example', to: ['etmf@cro.example'], subject: 'My CV',
    text: 'Please find my CV attached.', attachments: [{ filename: 'vogel-cv.pdf', contentType: 'application/pdf', contentBase64: pdf }],
  });

  test('receiveMessage stores the message once and starts the router, acting for its `as` role', async () => {
    const r = await kernel.triggers.receiveMessage('etmf', email('<m1@harbor.example>'));
    expect(r.duplicate).toBe(false);
    expect(r.firings).toHaveLength(1);
    expect(r.firings[0]).toMatchObject({ kind: 'message', status: 'started', record: r.messageId });
    const run = (await runsOf('route-message'))[0];
    expect(run.acts_for).toBe('tmf_specialist');
    const c = await kernel.getCase(run.case_id);
    expect(c!.values.sender!.value).toBe('lena.vogel@harbor.example');
    expect(c!.values.subject!.value).toBe('My CV');
    const docsValue = c!.values.documents!.value as { name: string; mime: string; id: string }[];
    expect(docsValue).toHaveLength(1);
    expect(docsValue[0]).toMatchObject({ name: 'vogel-cv.pdf', mime: 'application/pdf' });
    const file = await kernel.readFile(docsValue[0]!.id, { kind: 'system' });
    expect(Buffer.from(file!.data).toString()).toBe('%PDF-1.4 a tiny CV');

    const again = await kernel.triggers.receiveMessage('etmf', email('<m1@harbor.example>'));
    expect(again).toMatchObject({ duplicate: true, messageId: r.messageId });
    expect(again.firings.map((f) => f.key)).toEqual(r.firings.map((f) => f.key));
    expect(await runsOf('route-message')).toHaveLength(1);
    expect((await one(`select count(*)::int as n from mw.inbound_messages`)).n).toBe(1);
  });

  test('email through a signed webhook (email-inbound:etmf); a duplicate delivery starts nothing', async () => {
    const { hook, secret } = await kernel.channels.createWebhook({ purpose: 'email-inbound:etmf', scheme: 'hmac-sha256' }, manager);
    const post = (body: unknown) => {
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      const sig = `sha256=${crypto.createHmac('sha256', secret).update(bytes).digest('hex')}`;
      return kernel.channels.receiveWebhook(hook.id, { method: 'POST', query: {}, headers: { 'X-MemWise-Signature': sig }, body: bytes });
    };
    expect((await post(email('<m2@harbor.example>'))).status).toBe(200);
    await until('the router case', () => runsOf('route-message'), (r) => r.length === 2);
    expect((await post(email('<m2@harbor.example>'))).status).toBe(200);
    await until('both deliveries handled', () => rows(`select * from mw.event_deliveries where consumer = 'email-inbound'`), (r) => r.length === 2);
    await settle();
    expect(await runsOf('route-message')).toHaveLength(2);
    expect((await one(`select count(*)::int as n from mw.inbound_messages`)).n).toBe(2);
  });

  // ---------------------------------------------------------------- the storm guard

  test('storm guard: above the limit firings are held for the owner, who starts or discards them', async () => {
    for (let i = 0; i < 8; i++) await seed('etmf.Contact', { name: `Contact ${i}` });
    await settle();
    expect((await kernel.triggers.firings({ triggerId: 'welcome-contact#0', status: 'started' })).length).toBe(5);
    expect((await kernel.triggers.firings({ triggerId: 'welcome-contact#0', status: 'held' })).length).toBe(3);
    expect(await runsOf('welcome-contact')).toHaveLength(5);
    const item = (await kernel.inbox(manager)).find((i) => i.kind === 'trigger-hold');
    expect(item).toMatchObject({ kind: 'trigger-hold', triggerId: 'welcome-contact#0', workflowId: 'welcome-contact', held: 3, description: '3 cases would start from Welcome a contact' });
    expect((await kernel.inbox(dataManager)).some((i) => i.kind === 'trigger-hold')).toBe(false);
    expect((await kernel.triggers.list()).find((t) => t.id === 'welcome-contact#0')).toMatchObject({ held: 3, firings: 8 });

    expect(await kernel.triggers.release('welcome-contact#0', 'start', dataManager)).toMatchObject({ applied: false, started: 0 });
    expect(await kernel.triggers.release('welcome-contact#0', 'start', manager)).toEqual({ applied: true, started: 3 });
    expect(await runsOf('welcome-contact')).toHaveLength(8);
    expect((await kernel.inbox(manager)).some((i) => i.kind === 'trigger-hold')).toBe(false);
    expect(await kernel.triggers.release('welcome-contact#0', 'start', manager)).toMatchObject({ applied: false, started: 0 });

    // Still within the minute: more are held, and discarded.
    for (let i = 0; i < 2; i++) await seed('etmf.Contact', { name: `Late ${i}` });
    await settle();
    expect((await kernel.triggers.firings({ triggerId: 'welcome-contact#0', status: 'held' })).length).toBe(2);
    expect(await kernel.triggers.release('welcome-contact#0', 'discard', manager)).toMatchObject({ applied: true, started: 0 });
    expect((await kernel.triggers.firings({ triggerId: 'welcome-contact#0', status: 'discarded' })).length).toBe(2);
    expect(await runsOf('welcome-contact')).toHaveLength(8);
  });

  // ---------------------------------------------------------------- hand-offs

  const child = async (parentRunId: string, i = 0) => {
    const links = await until('the child case', () => childrenOf(parentRunId), (l) => l.length > i && !!l[i].child_case_id);
    return links[i];
  };

  test('call: the child runs, its last event comes back with `returns` mapped into the parent case', async () => {
    const { runId, caseId } = await kernel.startRun({ workflowId: 'send-for-filing', case: { document: 'doc-1' } });
    await settle();
    const link = await child(runId);
    expect(link).toMatchObject({ kind: 'called', parent_state: 'file_it', child_workflow: 'file-document' });
    const kid = await kernel.getCase(link.child_case_id);
    expect(kid!.values.document!.value).toBe('doc-1');
    expect(kid!.values.note!.value).toBe('please file');
    expect(kid!.values.document!.provenance).toMatchObject({ kind: 'input', by: `case:${caseId}` });
    expect((await kernel.getRun(runId))!.state).toBe('file_it');

    expect((await kernel.sendEvent(link.child_run_id, 'filed', { idemKey: 'f1', by: specialist })).sent).toBe(true);
    await runIn(link.child_run_id, 'end', 'done');
    await settle();
    await runIn(runId, 'filed');
    const parent = await kernel.getCase(caseId);
    expect(parent!.values.filed_id).toMatchObject({ value: 'please file', provenance: { kind: 'system', note: `from File a document case ${link.child_case_id}` } });
    const view = await kernel.getCaseView(caseId, manager);
    expect(view!.links).toEqual([expect.objectContaining({ kind: 'called', caseId: link.child_case_id, workflowId: 'file-document', title: 'File a document', status: 'done' })]);
    const kidView = await kernel.getCaseView(link.child_case_id, manager);
    expect(kidView!.links).toEqual([expect.objectContaining({ kind: 'called_by', caseId, workflowId: 'send-for-filing', state: 'filed' })]);
    expect(view!.domain).toBe('etmf');
  });

  test('call: a child that stops sends `failed`', async () => {
    const { runId } = await kernel.startRun({ workflowId: 'send-for-filing', case: { document: 'doc-2' } });
    await settle();
    const link = await child(runId);
    await kernel.sendEvent(link.child_run_id, 'give_up', { idemKey: 'g', by: specialist });
    await runIn(link.child_run_id, 'stuck');
    await kernel.sendEvent(link.child_run_id, { type: 'stop', reason: 'not a TMF document' }, { idemKey: 's', by: specialist });
    const stopped = await runIn(link.child_run_id, 'stuck', 'stopped');
    expect(stopped.stopReason).toBe('not a TMF document');
    await settle();
    await runIn(runId, 'needs_person');
    expect((await kernel.getTransitions(runId)).at(-1)!.event.type).toBe('failed');
  });

  test('start: the child starts, the parent moves on with `started` and stays independent', async () => {
    const { runId, caseId } = await kernel.startRun({ workflowId: 'hand-on', case: { document: 'doc-3' } });
    await settle();
    await runIn(runId, 'after');
    const link = await child(runId);
    expect(link.kind).toBe('started');
    expect((await kernel.getCaseView(caseId, manager))!.links).toEqual([expect.objectContaining({ kind: 'started', caseId: link.child_case_id })]);
    expect((await kernel.getCaseView(link.child_case_id, manager))!.links).toEqual([expect.objectContaining({ kind: 'started_by', caseId })]);
    // Stopping the parent leaves a started child alone.
    await kernel.sendEvent(runId, { type: 'stop' }, { idemKey: 'stop', by: manager });
    expect((await runIn(runId, 'after', 'stopped')).stopReason).toBe(`stopped by ${manager.personId}`);
    await settle();
    expect((await kernel.getRun(link.child_run_id))!.status).toBe('active');
  });

  const fan = async (workflowId: string, n = 3) => {
    const { runId } = await kernel.startRun({ workflowId, case: { documents: Array.from({ length: n }, (_, i) => `d${i}`) } });
    await settle();
    const links = await until('all children', () => childrenOf(runId), (l) => l.length === n && l.every((x) => x.child_case_id));
    return { runId, links };
  };
  const end = async (runId: string, event: string, key: string) => {
    if (event === 'stop') await kernel.sendEvent(runId, { type: 'stop', reason: 'test' }, { idemKey: key, by: specialist });
    else await kernel.sendEvent(runId, event, { idemKey: key, by: specialist });
    await kernel.waitForRun(runId, { until: (r) => r.status !== 'active', timeoutMs: 30_000 });
  };

  test('for_each call, join all: done once every child ended', async () => {
    const { runId, links } = await fan('fan-all');
    expect(links.map((l) => l.kind)).toEqual(['called', 'called', 'called']);
    const docsOf = await Promise.all(links.map(async (l) => (await kernel.getCase(l.child_case_id))!.values.document!.value));
    expect(docsOf).toEqual(['d0', 'd1', 'd2']);
    await end(links[0].child_run_id, 'filed', 'a');
    await end(links[1].child_run_id, 'rejected', 'b');
    await settle();
    expect((await kernel.getRun(runId))!.state).toBe('fan_out');
    await end(links[2].child_run_id, 'filed', 'c');
    await settle();
    await runIn(runId, 'review');
    expect((await kernel.getTransitions(runId)).filter((t) => t.event.type === 'done')).toHaveLength(1);
  });

  test('for_each call, join all: a failed child fails the join at once', async () => {
    const { runId, links } = await fan('fan-all');
    await end(links[1].child_run_id, 'stop', 'x');
    await settle();
    await runIn(runId, 'needs_person');
  });

  test('for_each call, join any: the first to end is enough', async () => {
    const { runId, links } = await fan('fan-any');
    await end(links[2].child_run_id, 'filed', 'a');
    await settle();
    await runIn(runId, 'review');
    // The others carry on; their ends later send nothing more.
    await end(links[0].child_run_id, 'filed', 'b');
    await settle();
    expect((await kernel.getTransitions(runId)).filter((t) => t.event.type === 'done')).toHaveLength(1);
  });

  test('for_each call, join 2: fails once two can no longer end well', async () => {
    const { runId, links } = await fan('fan-two');
    await end(links[0].child_run_id, 'stop', 'a');
    await settle();
    expect((await kernel.getRun(runId))!.state).toBe('fan_out');
    await end(links[1].child_run_id, 'stop', 'b');
    await settle();
    await runIn(runId, 'needs_person');

    const ok = await fan('fan-two');
    await end(ok.links[0].child_run_id, 'filed', 'a');
    await end(ok.links[2].child_run_id, 'rejected', 'b');
    await settle();
    await runIn(ok.runId, 'review');
  });

  test('for_each start: `started` once every child started', async () => {
    const { runId, links } = await fan('fan-start');
    expect(links.map((l) => l.kind)).toEqual(['started', 'started', 'started']);
    await runIn(runId, 'review');
  });

  test('cancel cascade: stopping a parent stops what it called and fanned out', async () => {
    const called = await kernel.startRun({ workflowId: 'send-for-filing', case: { document: 'doc-9' } });
    await settle();
    const link = await child(called.runId);
    const fanned = await fan('fan-all');
    await kernel.sendEvent(called.runId, { type: 'stop', reason: 'withdrawn' }, { idemKey: 'stop', by: manager });
    await kernel.sendEvent(fanned.runId, { type: 'stop', reason: 'withdrawn' }, { idemKey: 'stop', by: manager });
    await settle();
    for (const id of [link.child_run_id, ...fanned.links.map((l) => l.child_run_id)]) {
      const r = await kernel.waitForRun(id, { until: (x) => x.status !== 'active', timeoutMs: 30_000 });
      expect(r).toMatchObject({ status: 'stopped', stopReason: 'the case that called it was stopped' });
    }
  });

  test('across domains: refused unless the target domain accepts the source', async () => {
    const refused = await kernel.startRun({ workflowId: 'ask-edc', case: {} });
    await settle();
    const r = await kernel.waitForRun(refused.runId, { until: (x) => x.status !== 'active', timeoutMs: 30_000 });
    expect(r.status).toBe('stopped');
    expect(r.stopReason).toBe("Check the data belongs to EDC, which doesn't take work from eTMF");
    expect(await childrenOf(refused.runId)).toEqual([]);

    const allowed = await kernel.startRun({ workflowId: 'edc-files', case: { document: 'from edc' } });
    await settle();
    const link = await child(allowed.runId);
    expect(link.child_workflow).toBe('file-document');
  });
});
