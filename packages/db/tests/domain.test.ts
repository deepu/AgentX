import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { loadProject, type EntityTypeDef, type ProjectDefs, type StepToken } from '@memwise/defs';
import {
  applyDomainSchema, columnType, compileRls, createTestDatabase, domainCreators, KERNEL_RLS_STAMP, KERNEL_RLS_VERSION, entityColumns, entityTableName, keyIndexName, PgEntityStore,
  postgresAvailable, syncEntityTables, withActor, type Actor, type TestDatabase,
} from '../src/index.ts';

const EXAMPLE = path.resolve(import.meta.dir, '../../../examples/intake');
const at = '2026-10-20T10:00:00.000Z';

function stepActor(caseId: string, stepRunId: string, stepId = 'onboard'): Actor {
  const token: StepToken = {
    runId: `run_${caseId}`, caseId, stepId, stepRunId, workflowId: 'client-intake', workflowVersion: 1,
    agentRole: 'intake.onboard', issuedAt: at, expiresAt: at,
  };
  return { kind: 'step', token };
}
const staff: Actor = { kind: 'person', personId: 'person_staff', roles: ['staff'] };
const finance: Actor = { kind: 'person', personId: 'person_fin', roles: ['finance'] };

test('naming and column types', () => {
  expect(entityTableName('Customer')).toBe('domain__customer');
  expect(entityTableName('ClientEngagement')).toBe('domain__client_engagement');
  expect(columnType({ kind: 'scalar', name: 'Money' })).toBe('jsonb');
  expect(columnType({ kind: 'scalar', name: 'Percentage' })).toBe('numeric');
  expect(columnType({ kind: 'identifier', scheme: 'GSTIN' })).toBe('text');
  expect(columnType({ kind: 'ref', entity: 'Customer' })).toBe('text');
  expect(columnType({ kind: 'list', of: { kind: 'scalar', name: 'Text' } })).toBe('jsonb');
  expect(columnType({ kind: 'scalar', name: 'DateTime' })).toBe('timestamptz');
});

test('key index names: short ones as they are; long ones keep a prefix and end with a hash of the whole', () => {
  expect(keyIndexName('Customer')).toBe('domain__customer__key');
  const a = keyIndexName({ entity: 'ExpectedRegulatoryDocumentSubmissionForInvestigatorSiteA', domain: 'etmf' });
  const b = keyIndexName({ entity: 'ExpectedRegulatoryDocumentSubmissionForInvestigatorSiteB', domain: 'etmf' });
  expect(a.length).toBe(63);
  expect(a).toStartWith('etmf__expected_regulatory_document_submission_for_');
  expect(a).toMatch(/_[0-9a-f]{10}$/);
  // Cut to 63 characters these two would have been the same index.
  expect(a).not.toBe(b);
  expect(keyIndexName({ entity: 'ExpectedRegulatoryDocumentSubmissionForInvestigatorSiteA', domain: 'etmf' })).toBe(a);
});

describe.skipIf(!postgresAvailable())('domain tables and row rules', () => {
  let db: TestDatabase;
  let project: ProjectDefs;
  let customer: EntityTypeDef;
  let engagement: EntityTypeDef;
  const entities = new PgEntityStore();

  beforeAll(async () => {
    db = await createTestDatabase('mw_domain');
    const loaded = await loadProject(EXAMPLE);
    project = loaded.project;
    customer = project.entities.Customer!;
    engagement = project.entities.Engagement!;
    await applyDomainSchema(db.pool, project.entities, { creators: domainCreators(project.entities, project.workflows) });
    // Two cases, each with a run and a step run.
    for (const c of ['case_a', 'case_b']) {
      await db.pool.query(`insert into mw.cases (id, case_type, workflow_id, workflow_hash) values ($1, 'client_intake', 'client-intake', 'h')`, [c]);
      await db.pool.query(
        `insert into mw.runs (id, workflow_id, workflow_version, workflow_hash, case_id, state, status, snapshot, driver_wf_id)
         values ($1, 'client-intake', 1, 'h', $2, 'onboard', 'active', '{}', $1)`, [`run_${c}`, c]);
      await db.pool.query(
        `insert into mw.step_runs (id, run_id, case_id, step_id, workflow_id, workflow_version, workflow_hash, step_hash, performer, status, token, started_at)
         values ($1, $2, $3, 'onboard', 'client-intake', 1, 'h', 'sh', 'system', 'running', '{}', now())`, [`run_${c}/1/onboard`, `run_${c}`, c]);
    }
  }, 60_000);
  afterAll(() => db?.drop());

  test('tables are generated with typed columns, a Ref column per one-relationship', async () => {
    const { rows } = await db.pool.query(
      `select table_name, column_name, data_type from information_schema.columns where table_schema = 'domain' order by table_name, ordinal_position`);
    const cols = (t: string) => Object.fromEntries(rows.filter((r) => r.table_name === t).map((r) => [r.column_name, r.data_type]));
    expect(cols('domain__customer')).toMatchObject({
      id: 'text', lifecycle: 'text', created_by_step: 'text', idempotency_key: 'text',
      name: 'text', email: 'text', gstin: 'text', pan: 'text', credit_limit: 'jsonb', bank_account: 'text',
    });
    expect(cols('domain__engagement')).toMatchObject({ title: 'text', started: 'date', customer: 'text' });
    expect(entityColumns(customer).find((c) => c.field === 'bank_account')?.access).toEqual(['finance']);
  });

  test('sync is additive and idempotent: a new field adds a column, nothing is dropped', async () => {
    const grown: EntityTypeDef = {
      ...customer,
      fields: { ...customer.fields, segment: { type: { kind: 'enum', values: ['sme', 'large'] }, typeSource: 'Enum[sme, large]' } },
    };
    const smaller: EntityTypeDef = { ...customer, fields: { name: customer.fields.name! } };
    expect(await syncEntityTables(db.pool, { Customer: grown })).toEqual([]);
    expect(await syncEntityTables(db.pool, { Customer: smaller })).toEqual([]);
    const { rows } = await db.pool.query(`select column_name from information_schema.columns where table_schema = 'domain' and table_name = 'domain__customer'`);
    const names = rows.map((r) => r.column_name);
    expect(names).toContain('segment');
    expect(names).toContain('bank_account');
    // Re-applying the full schema (as at every index) works and keeps everything.
    await applyDomainSchema(db.pool, project.entities, { creators: domainCreators(project.entities, project.workflows) });
    await applyDomainSchema(db.pool, project.entities, { creators: domainCreators(project.entities, project.workflows) });
  });

  test('re-applying the schema leaves the kernel tables alone while runs hold them (no deadlock with a run starting)', async () => {
    const other = await db.pool.connect();
    try {
      // A run mid-transaction: it holds mw.runs and mw.cases (a re-index used to wait for both,
      // holding one of them, and deadlock).
      await other.query('begin');
      await other.query('lock table mw.runs, mw.cases, mw.step_runs in row exclusive mode');
      const applied = applyDomainSchema(db.pool, project.entities, { creators: domainCreators(project.entities, project.workflows) }).then(() => 'applied');
      const waited = new Promise((r) => setTimeout(() => r('waited'), 5000));
      expect(await Promise.race([applied, waited])).toBe('applied');
    } finally {
      await other.query('rollback').catch(() => undefined);
      other.release();
    }
    // The rules are still in place.
    const { rows } = await db.pool.query(`select count(*)::int as n from pg_policies where schemaname = 'mw' and tablename in ('cases', 'runs', 'step_runs')`);
    expect(rows[0].n).toBe(6);
  });

  test('the kernel rules carry a version stamp; a database with another one gets them again at its next index', async () => {
    const stamps = async () => (await db.pool.query<{ t: string; p: string; c: string | null }>(
      `select c.relname as t, pol.polname as p, obj_description(pol.oid, 'pg_policy') as c from pg_policy pol
         join pg_class c on c.oid = pol.polrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'mw' and c.relname in ('cases', 'runs', 'step_runs') order by 1, 2`)).rows;
    expect(KERNEL_RLS_STAMP).toBe(`memwise-kernel-rls v${KERNEL_RLS_VERSION}`);
    expect((await stamps()).map((r) => r.c)).toEqual(Array(6).fill(KERNEL_RLS_STAMP));
    // A database from an earlier build: an older rule on mw.cases (its predicate since changed), with an older stamp.
    await db.pool.query(`drop policy mw_person_all on mw.cases`);
    await db.pool.query(`create policy mw_person_all on mw.cases for all to memwise_app using (mw.actor_kind() = 'person') with check (mw.actor_kind() = 'person')`);
    await db.pool.query(`comment on policy mw_person_all on mw.cases is 'memwise-kernel-rls v0'`);
    await applyDomainSchema(db.pool, project.entities, { creators: domainCreators(project.entities, project.workflows) });
    expect((await stamps()).map((r) => r.c)).toEqual(Array(6).fill(KERNEL_RLS_STAMP));
    const { rows } = await db.pool.query(`select qual from pg_policies where schemaname = 'mw' and tablename = 'cases' and policyname = 'mw_person_all'`);
    expect(rows[0].qual).toContain('project_visible');
  });

  test('a step token sees only its own case in mw.cases, mw.runs and mw.step_runs', async () => {
    const actor = stepActor('case_a', 'run_case_a/1/onboard');
    const seen = await withActor(db.pool, actor, async (c) => ({
      cases: (await c.query('select id from mw.cases order by id')).rows.map((r) => r.id),
      runs: (await c.query('select case_id from mw.runs order by id')).rows.map((r) => r.case_id),
      steps: (await c.query('select case_id from mw.step_runs order by id')).rows.map((r) => r.case_id),
      updated: (await c.query(`update mw.cases set seq = seq where id = 'case_b'`)).rowCount,
    }));
    expect(seen).toEqual({ cases: ['case_a'], runs: ['case_a'], steps: ['case_a'], updated: 0 });
    const person = await withActor(db.pool, staff, async (c) => (await c.query('select id from mw.cases order by id')).rows.map((r) => r.id));
    expect(person).toEqual(['case_a', 'case_b']);
  });

  test('field access: bank_account is null without finance, visible with it', async () => {
    const id = await withActor(db.pool, stepActor('case_a', 'run_case_a/1/onboard'), (c) => entities.create(c, customer, {
      name: 'Asha Traders', email: 'asha@example.com', gstin: '29ABCDE1234F1Z5', pan: 'ABCDE1234F',
      credit_limit: { amount: 50000, currency: 'INR' }, bank_account: 'HDFC 0001234',
    }, { idempotencyKey: 'run_case_a/1/onboard:domain.domain__customer.create', stepRunId: 'run_case_a/1/onboard' }));
    expect(id).toMatch(/^cust_[0-9A-Z]{26}$/);

    const asStaff = await withActor(db.pool, staff, (c) => entities.get(c, customer, id));
    expect(asStaff?.values.bank_account).toBeNull();
    expect(asStaff?.hidden).toEqual(['bank_account']);
    expect(asStaff?.values).toMatchObject({ name: 'Asha Traders', credit_limit: { amount: 50000, currency: 'INR' } });
    expect(asStaff?.lifecycle).toBe('prospect');
    expect(asStaff?.createdByStep).toBe('run_case_a/1/onboard');

    const asFinance = await withActor(db.pool, finance, (c) => entities.list(c, customer));
    expect(asFinance.find((r) => r.id === id)?.values.bank_account).toBe('HDFC 0001234');
    expect(asFinance.find((r) => r.id === id)?.hidden).toEqual([]);

    // The base table itself does not give the restricted column to the app role.
    await expect(withActor(db.pool, staff, (c) => c.query('select bank_account from domain.domain__customer')))
      .rejects.toThrow(/permission denied/);
    await expect(withActor(db.pool, finance, (c) => c.query('select bank_account from domain.domain__customer')))
      .rejects.toThrow(/permission denied/);
    const raw = await withActor(db.pool, staff, (c) => c.query('select bank_account from domain_read.domain__customer where id = $1', [id]));
    expect(raw.rows).toEqual([{ bank_account: null }]);

    // The kernel's own unrestricted read (identity matching) sees every field; never under an app actor.
    const system = await entities.list(db.pool, customer, { unrestricted: true });
    expect(system.find((r) => r.id === id)?.values.bank_account).toBe('HDFC 0001234');
    expect(system.find((r) => r.id === id)?.hidden).toEqual([]);
    await expect(withActor(db.pool, staff, (c) => entities.list(c, customer, { unrestricted: true }))).rejects.toThrow(/permission denied/);
  });

  test('create is idempotent on the key', async () => {
    const actor = stepActor('case_b', 'run_case_b/1/onboard');
    const key = 'run_case_b/1/onboard:domain.domain__customer.create';
    const opts = { idempotencyKey: key, stepRunId: 'run_case_b/1/onboard' };
    const a = await withActor(db.pool, actor, (c) => entities.create(c, customer, { name: 'B Ltd' }, opts));
    const b = await withActor(db.pool, actor, (c) => entities.create(c, customer, { name: 'B Ltd again' }, opts));
    expect(b).toBe(a);
    const { rows } = await db.pool.query('select count(*)::int as n from domain.domain__customer where idempotency_key = $1', [key]);
    expect(rows[0].n).toBe(1);
    await expect(withActor(db.pool, actor, (c) => entities.create(c, customer, { nope: 1 }, opts))).rejects.toThrow(/no field "nope"/);
  });

  test('a step token inserts only rows stamped with its own step run, from a step allowed to create', async () => {
    // Stamped with another step run: refused.
    await expect(withActor(db.pool, stepActor('case_a', 'run_case_a/1/onboard'), (c) =>
      entities.create(c, customer, { name: 'X' }, { stepRunId: 'run_case_b/1/onboard' }))).rejects.toThrow(/row-level security/);
    // A step whose tools don't include domain.domain__customer.create (check): refused.
    await expect(withActor(db.pool, stepActor('case_a', 'run_case_a/1/check', 'check'), (c) =>
      entities.create(c, customer, { name: 'X' }, { stepRunId: 'run_case_a/1/check' }))).rejects.toThrow(/row-level security/);
    // Engagement has no creating step at all.
    await expect(withActor(db.pool, stepActor('case_a', 'run_case_a/1/onboard'), (c) =>
      entities.create(c, engagement, { title: 'Audit' }, { stepRunId: 'run_case_a/1/onboard' }))).rejects.toThrow(/row-level security/);
    // People may insert; dates round-trip as plain dates.
    const custId = (await withActor(db.pool, staff, (c) => entities.list(c, customer)))[0]!.id;
    const eng = await withActor(db.pool, staff, (c) => entities.create(c, engagement, { title: 'Audit', started: '2026-04-01', customer: custId }));
    const got = await withActor(db.pool, staff, (c) => entities.get(c, engagement, eng));
    expect(got?.values).toEqual({ title: 'Audit', started: '2026-04-01', customer: custId });
    expect(eng).toMatch(/^enga_/);
  });

  test('compileRls is plain idempotent SQL', () => {
    const sql = compileRls(project.entities);
    expect(sql.some((s) => s.startsWith('create view domain_read."domain__customer" with (security_barrier = true)'))).toBe(true);
    expect(sql.filter((s) => s.startsWith('create policy')).every((s, i, all) => all.indexOf(s) === i)).toBe(true);
    for (const create of sql.filter((s) => s.startsWith('create policy'))) {
      const [, name, table] = create.match(/^create policy (\S+) on (\S+)/)!;
      expect(sql).toContain(`drop policy if exists ${name} on ${table}`);
    }
  });
});
