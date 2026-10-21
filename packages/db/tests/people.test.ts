import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {
  createTestDatabase, PgChatAnchorStore, PgExplanationStore, PgFileStore, PgNotificationStore, PgPeopleStore, PgRateCounter, parseRecordAnchorId, recordAnchorId,
  postgresAvailable, withActor, type TestDatabase,
} from '../src/index.ts';

describe.skipIf(!postgresAvailable())('people and Phase 2 stores', () => {
  let db: TestDatabase;
  let people: PgPeopleStore;

  beforeAll(async () => {
    db = await createTestDatabase('mw_people');
    people = new PgPeopleStore(db.pool);
  }, 60_000);
  afterAll(() => db?.drop());

  test('people: create, roles, duplicate email refused', async () => {
    await people.syncRoles({ staff: { id: 'staff', title: 'Staff' }, manager: { id: 'manager', title: 'Manager', description: 'Approves' } });
    const asha = await people.create({ name: 'Asha Rao', email: ' Asha@Example.com ', roles: ['staff'] });
    expect(asha.id).toMatch(/^person_[0-9A-Z]{26}$/);
    expect(asha.email).toBe('asha@example.com');
    expect(asha.roles).toEqual(['staff']);
    expect((await people.byEmail('ASHA@example.com'))?.id).toBe(asha.id);
    await expect(people.create({ name: 'Other', email: 'asha@example.com' })).rejects.toThrow(/already exists/);

    const updated = await people.setRoles(asha.id, ['manager', 'staff', 'staff']);
    expect(updated.roles).toEqual(['manager', 'staff']);
    expect(await people.actorFor(asha.id)).toEqual({ kind: 'person', personId: asha.id, roles: ['manager', 'staff'] });
    expect((await people.roles()).map((r) => r.id)).toEqual(['manager', 'staff']);

    await people.syncRoles([{ id: 'staff', title: 'Staff team' }]);
    expect(await people.roles()).toEqual([{ id: 'staff', title: 'Staff team' }]);
  });

  test('passwords: scrypt, verified, never readable by the app role', async () => {
    const p = await people.create({ name: 'Ravi', email: 'ravi@example.com', password: 'correct horse' });
    const { rows } = await db.pool.query('select password_hash from mw.people where id = $1', [p.id]);
    expect(rows[0].password_hash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect((await people.verifyPassword('RAVI@example.com', 'correct horse'))?.id).toBe(p.id);
    expect(await people.verifyPassword('ravi@example.com', 'wrong')).toBeUndefined();
    expect(await people.verifyPassword('nobody@example.com', 'x')).toBeUndefined();
    await people.setPassword(p.id, 'new one');
    expect(await people.verifyPassword('ravi@example.com', 'correct horse')).toBeUndefined();
    expect((await people.verifyPassword('ravi@example.com', 'new one'))?.id).toBe(p.id);

    const actor = await people.actorFor(p.id);
    await expect(withActor(db.pool, actor, (c) => c.query('select password_hash from mw.people'))).rejects.toThrow(/permission denied/);
    await expect(withActor(db.pool, actor, (c) => c.query('select * from mw.auth_tokens'))).rejects.toThrow(/permission denied/);
    const names = await withActor(db.pool, actor, (c) => c.query('select name from mw.people where id = $1', [p.id]));
    expect(names.rows).toEqual([{ name: 'Ravi' }]);

    await people.setDisabled(p.id, true);
    expect(await people.verifyPassword('ravi@example.com', 'new one')).toBeUndefined();
    await expect(people.actorFor(p.id)).rejects.toThrow(/disabled/);
  });

  test('tokens: stored hashed, verified, expire, record last use', async () => {
    const p = await people.create({ name: 'Meera', email: 'meera@example.com', roles: ['staff'] });
    const token = await people.issueToken(p.id, 'laptop');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const { rows } = await db.pool.query('select token_hash, last_used_at from mw.auth_tokens where person_id = $1', [p.id]);
    expect(rows[0].token_hash).not.toContain(token);
    expect(rows[0].last_used_at).toBeNull();
    expect((await people.verifyToken(token))?.id).toBe(p.id);
    const after = await db.pool.query('select last_used_at from mw.auth_tokens where person_id = $1', [p.id]);
    expect(after.rows[0].last_used_at).not.toBeNull();
    expect(await people.verifyToken(`${token}x`)).toBeUndefined();
    expect(await people.verifyToken('')).toBeUndefined();

    const short = await people.issueToken(p.id, 'gone', -1000);
    expect(await people.verifyToken(short)).toBeUndefined();
    await people.revokeToken(token);
    expect(await people.verifyToken(token)).toBeUndefined();
  });

  test('withActor: settings are transaction-local and the role switches back', async () => {
    const actor = { kind: 'person' as const, personId: 'person_x', roles: ['staff', 'finance'] };
    const r = await withActor(db.pool, actor, (c) => c.query(
      `select current_user as u, mw.actor_kind() as k, mw.actor_person() as p,
              mw.actor_has_role('finance') as f, mw.actor_has_role('manager') as m, mw.token_case() as tc`));
    expect(r.rows[0]).toEqual({ u: 'memwise_app', k: 'person', p: 'person_x', f: true, m: false, tc: null });
    const after = await db.pool.query(`select current_user as u, mw.actor_kind() as k, mw.actor_has_role('finance') as f`);
    expect(after.rows[0].u).not.toBe('memwise_app');
    expect(after.rows[0].k).toBeNull();
    expect(after.rows[0].f).toBe(false);
    const sys = await withActor(db.pool, { kind: 'system' }, (c) => c.query('select current_user as u, mw.actor_kind() as k'));
    expect(sys.rows[0].u).not.toBe('memwise_app');
    expect(sys.rows[0].k).toBe('system');
  });

  test('notifications: idempotent ids, unread by person or role, mark read', async () => {
    const notes = new PgNotificationStore();
    const n = await notes.add(db.pool, { id: 'remind:r1:1', runId: 'r1', stepRunId: 'r1/1/verify', role: 'manager', kind: 'reminder', text: 'Verify is waiting' });
    await notes.add(db.pool, { id: 'remind:r1:1', runId: 'r1', role: 'manager', kind: 'reminder', text: 'again' });
    await notes.add(db.pool, { runId: 'r1', personId: 'person_a', kind: 'note', text: 'for a' });
    expect(n.text).toBe('Verify is waiting');
    expect((await notes.unread(db.pool, { personId: 'person_b', roles: ['manager'] })).map((x) => x.id)).toEqual(['remind:r1:1']);
    expect((await notes.unread(db.pool, { personId: 'person_a', roles: [] })).map((x) => x.text)).toEqual(['for a']);
    expect(await notes.markReadForStep(db.pool, 'r1/1/verify')).toBe(1);
    expect(await notes.unread(db.pool, { personId: 'person_b', roles: ['manager'] })).toEqual([]);
    expect((await notes.forRun(db.pool, 'r1')).length).toBe(2);
  });

  test('explanations and chat anchors', async () => {
    const ex = new PgExplanationStore();
    const saved = await ex.save(db.pool, {
      stepRunId: 's1', question: 'why flagged?', answer: 'PAN mismatch', grounded: true, by: 'person_a',
      cites: [{ kind: 'journal', ref: 'tool:gst.validate_gstin:1', label: 'GSTIN check' }], model: { provider: 'scripted' },
    });
    expect(saved.id).toMatch(/^expl_/);
    expect((await ex.forStep(db.pool, 's1')).map((e) => e.answer)).toEqual(['PAN mismatch']);
    expect((await ex.get(db.pool, saved.id))?.cites[0]?.ref).toBe('tool:gst.validate_gstin:1');

    const anchors = new PgChatAnchorStore();
    await anchors.set(db.pool, { chatId: 'chat1', anchorKind: 'case', anchorId: 'case_1', personId: 'person_a' });
    const moved = await anchors.set(db.pool, { chatId: 'chat1', anchorKind: 'step', anchorId: 's1', personId: 'person_a' });
    expect(moved).toMatchObject({ chatId: 'chat1', anchorKind: 'step', anchorId: 's1' });
    expect((await anchors.forAnchor(db.pool, 'step', 's1')).map((a) => a.chatId)).toEqual(['chat1']);
    expect(await anchors.forAnchor(db.pool, 'case', 'case_1')).toEqual([]);
    // A chat anchored to a record (doc 25 §6): the entity key and record id in one anchor id.
    const rec = await anchors.set(db.pool, { chatId: 'chat2', anchorKind: 'record', anchorId: recordAnchorId('literature.topic', 'rec_1'), personId: 'person_a' });
    expect(rec).toMatchObject({ anchorKind: 'record', anchorId: 'literature.topic:rec_1' });
    expect(parseRecordAnchorId(rec.anchorId)).toEqual({ entity: 'literature.topic', id: 'rec_1' });
    expect(parseRecordAnchorId('no-colon')).toBeUndefined();
    expect((await anchors.forAnchor(db.pool, 'record', 'literature.topic:rec_1')).map((a) => a.chatId)).toEqual(['chat2']);
    await anchors.remove(db.pool, 'chat2');
    await anchors.remove(db.pool, 'chat1');
    expect(await anchors.get(db.pool, 'chat1')).toBeUndefined();
  });

  test('files: content-addressed bytes, metadata in mw.files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-files-'));
    try {
      const files = new PgFileStore(dir);
      const data = new TextEncoder().encode('PAN: ABCDE1234F');
      const a = await files.save(db.pool, { name: 'pan.txt', mime: 'text/plain', data }, 'person_a');
      const b = await files.save(db.pool, { name: 'copy.txt', mime: 'text/plain', data });
      expect(a.sha256).toBe(b.sha256);
      expect(a.id).not.toBe(b.id);
      expect(fs.readdirSync(dir)).toEqual([a.sha256]);
      const read = await files.read(db.pool, a.id);
      expect(read?.meta).toEqual(a);
      expect(new TextDecoder().decode(read!.data)).toBe('PAN: ABCDE1234F');
      fs.writeFileSync(files.pathOf(a.sha256), 'tampered');
      expect(await files.read(db.pool, a.id)).toBeUndefined();
      expect(await files.read(db.pool, 'file_nope')).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rate counter: allows up to the limit in the window, concurrently too', async () => {
    const rates = new PgRateCounter(db.pool);
    const limit = { count: 3, perMs: 60_000 };
    const results = await Promise.all([0, 1, 2, 3, 4].map(() => rates.take('gst.validate_gstin', 'domain', limit)));
    expect(results.filter((r) => r.allowed).length).toBe(3);
    expect((await rates.take('gst.validate_gstin', 'other', limit)).allowed).toBe(true);
    expect((await rates.take('gst.validate_gstin', 'domain', { count: 3, perMs: 1 })).allowed).toBe(true);
  });

  test('NOTIFY on mw_changes for runs, step runs, approvals and notifications', async () => {
    const listener = new pg.Client({ connectionString: db.url });
    await listener.connect();
    const got: unknown[] = [];
    listener.on('notification', (m) => { if (m.channel === 'mw_changes') got.push(JSON.parse(m.payload!)); });
    await listener.query('listen mw_changes');
    try {
      await db.pool.query(`insert into mw.cases (id, case_type, workflow_id, workflow_hash) values ('case_n', 't', 'wf', 'h')`);
      await db.pool.query(
        `insert into mw.runs (id, workflow_id, workflow_version, workflow_hash, case_id, state, status, snapshot, driver_wf_id)
         values ('run_n', 'wf', 1, 'h', 'case_n', 'fill', 'active', '{}', 'run:run_n')`);
      await db.pool.query(
        `insert into mw.step_runs (id, run_id, case_id, step_id, workflow_id, workflow_version, workflow_hash, step_hash, performer, status, token, started_at)
         values ('run_n/1/fill', 'run_n', 'case_n', 'fill', 'wf', 1, 'h', 'sh', 'person', 'waiting', '{}', now())`);
      await new PgNotificationStore().add(db.pool, { runId: 'run_n', kind: 'reminder', text: 'x' });
      const deadline = Date.now() + 5000;
      while (got.length < 4 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      const run = { kind: 'run', runId: 'run_n', caseId: 'case_n', workflowId: 'wf' };
      expect(got).toEqual([run, run, { kind: 'inbox' }, { kind: 'inbox' }]);
    } finally {
      await listener.end();
    }
  });
});
