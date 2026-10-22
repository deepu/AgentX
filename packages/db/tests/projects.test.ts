// Stage 3 (docs/memwise/26-projects-and-pages.md §3, D92): projects in the database. App tables
// carry `project`; a person granted only Study MW-301 never sees MW-207's records, pages, runs or
// chats, checked in SQL as that person. Records every project shares (`scope: app`) stay visible.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { EntityTypeDef, MwProjectDef } from '@memwise/defs';
import {
  applyDomainSchema, createTestDatabase, PgEntityStore, PgGrantStore, PgPeopleStore, PgProjectStore, postgresAvailable, withActor,
  withRecordContext, type Actor, type TestDatabase,
} from '../src/index.ts';
import { fixtureDomains, fixtureEntities, person, stepActor } from './phase6-fixtures.ts';

const project = (id: string, extra: Partial<MwProjectDef> = {}): MwProjectDef => ({
  id, app: 'etmf', apps: [extra.app ?? 'etmf'], name: `Study ${id.toUpperCase()}`, version: 4, status: 'active', people: [], connections: [], without: [], overrides: [],
  hash: id, workflows: {}, pages: {}, views: {}, ...extra,
});

describe.skipIf(!postgresAvailable())('projects in the database (D92)', () => {
  let db: TestDatabase;
  let e: Record<string, EntityTypeDef>;
  const store = new PgEntityStore();
  const projects = new PgProjectStore();
  const ids = {} as Record<string, string>;
  const priya = person('person_priya', [], [{ role: 'cra', domain: 'etmf', project: 'mw301' }]);

  /** A run (case, run, waiting step run) of `file-document` in a project, and a chat anchored to its case. */
  async function runIn(projectId: string, caseId: string) {
    await db.pool.query(`insert into mw.cases (id, case_type, workflow_id, workflow_hash, project) values ($1, 'filing', 'file-document', 'h', $2)`, [caseId, projectId]);
    await db.pool.query(
      `insert into mw.runs (id, workflow_id, workflow_version, workflow_hash, case_id, state, status, snapshot, driver_wf_id, project)
       values ($1, 'file-document', 1, 'h', $2, 'qc', 'active', '{}', $1, $3)`, [`run_${caseId}`, caseId, projectId]);
    // No project given: a step run takes its run's.
    await db.pool.query(
      `insert into mw.step_runs (id, run_id, case_id, step_id, workflow_id, workflow_version, workflow_hash, step_hash, performer, status, token, started_at)
       values ($1, $2, $3, 'qc', 'file-document', 1, 'h', 'h', 'person', 'waiting', '{}', now())`, [`run_${caseId}/1/qc`, `run_${caseId}`, caseId]);
    await db.pool.query(`insert into mw.chat_anchors (chat_id, anchor_kind, anchor_id) values ($1, 'case', $2)`, [`chat_${caseId}`, caseId]);
  }

  beforeAll(async () => {
    db = await createTestDatabase('mw_projects');
    e = fixtureEntities();
    e['etmf.Sponsor']!.scope = 'app';
    await applyDomainSchema(db.pool, e, { domains: fixtureDomains() });
    await projects.sync(db.pool, [project('mw301', { study: 'MW-301' }), project('mw207', { study: 'MW-207' }), project('mw310', { status: 'draft' })]);
    // The owner sees everything (no grants in etmf): the seed.
    const admin = person('person_admin', ['study_manager']);
    await withActor(db.pool, admin, async (c) => {
      await withRecordContext(c, { reason: 'seed' });
      ids.aster = await store.create(c, e['etmf.Sponsor']!, { name: 'Aster Bio' });
      for (const p of ['mw301', 'mw207']) {
        await withRecordContext(c, { project: p });
        ids[`study_${p}`] = await store.create(c, e['etmf.Study']!, { title: p, sponsor: ids.aster });
        ids[`site_${p}`] = await store.create(c, e['etmf.Site']!, { site_number: `${p}-101`, study: ids[`study_${p}`], sponsor: ids.aster });
        ids[`site2_${p}`] = await store.create(c, e['etmf.Site']!, { site_number: `${p}-104`, study: ids[`study_${p}`], sponsor: ids.aster });
        ids[`doc_${p}`] = await store.create(c, e['etmf.Document']!, { title: `CV ${p}`, site: ids[`site_${p}`], sponsor: ids.aster });
        ids[`doc2_${p}`] = await store.create(c, e['etmf.Document']!, { title: `IRB ${p}`, site: ids[`site2_${p}`], sponsor: ids.aster });
      }
    });
    for (const p of ['mw301', 'mw207']) {
      await db.pool.query(`insert into mw.pages (id, domain, project, title, body) values ($1, 'etmf', $2, $3, 'x')`, [`page_${p}`, p, `TMF by site ${p}`]);
      await runIn(p, `case_${p}`);
    }
  }, 60_000);
  afterAll(() => db?.drop());

  const as = <T,>(actor: Actor, fn: (c: import('pg').PoolClient) => Promise<T>) => withActor(db.pool, actor, fn);
  const col = async (actor: Actor, sql: string) => as(actor, async (c) => (await c.query(sql)).rows.map((r) => Object.values(r)[0]).sort());

  test('the migration made one project per domain and the store keeps the projects', async () => {
    const rows = await projects.list(db.pool);
    expect(rows.map((r) => `${r.id}:${r.app}:${r.status}`)).toEqual(expect.arrayContaining(['mw301:etmf:active', 'mw207:etmf:active', 'mw310:etmf:draft']));
    // Indexing again never changes a status it didn't set.
    await projects.setStatus(db.pool, 'mw310', 'active');
    await projects.sync(db.pool, [project('mw310', { status: 'draft', name: 'Study MW-310 (renamed)' })]);
    expect(await projects.get(db.pool, 'mw310')).toMatchObject({ status: 'active', name: 'Study MW-310 (renamed)', templateVersion: 4 });
  });

  test('app tables have a project column, filled from the write context; shared records have none', async () => {
    const { rows } = await db.pool.query(`select id, project from domain.etmf__site order by site_number`);
    expect(rows.map((r) => r.project)).toEqual(['mw207', 'mw207', 'mw301', 'mw301']);
    const sponsorCols = await db.pool.query(`select column_name from information_schema.columns where table_schema = 'domain' and table_name = 'etmf__sponsor'`);
    expect(sponsorCols.rows.map((r) => r.column_name)).not.toContain('project');
    // Versions carry it too.
    const v = await db.pool.query(`select project from mw.record_versions where record_id = $1`, [ids.doc_mw207]);
    expect(v.rows[0]!.project).toBe('mw207');
    expect((await store.get(db.pool, e['etmf.Site']!, ids.site_mw301!))!.project).toBe('mw301');
  });

  test('a person granted only MW-301 never sees MW-207: records, pages, runs, step runs, chats, history', async () => {
    const mine = (p: string) => [ids[`site_${p}`], ids[`site2_${p}`]].sort();
    expect(await col(priya, 'select id from domain_read.etmf__site')).toEqual(mine('mw301'));
    expect(await col(priya, 'select id from domain.etmf__site')).toEqual(mine('mw301'));
    expect(await col(priya, 'select id from domain_read.etmf__document')).toEqual([ids.doc_mw301, ids.doc2_mw301].sort());
    expect(await col(priya, 'select id from domain_read.etmf__study')).toEqual([ids.study_mw301]);
    // The shared Sponsor is everyone's.
    expect(await col(priya, 'select id from domain_read.etmf__sponsor')).toEqual([ids.aster]);
    expect(await col(priya, 'select id from mw.pages')).toEqual(['page_mw301']);
    expect(await col(priya, 'select id from mw.cases')).toEqual(['case_mw301']);
    expect(await col(priya, 'select id from mw.runs')).toEqual(['run_case_mw301']);
    expect(await col(priya, 'select id from mw.step_runs')).toEqual(['run_case_mw301/1/qc']);
    expect(await col(priya, 'select chat_id from mw.chat_anchors')).toEqual(['chat_case_mw301']);
    const history = await col(priya, `select distinct coalesce(project, '-') from mw.record_versions`);
    expect(history).toEqual(['-', 'mw301']);
    // Rollups in the view count only what the person may see (MW-301's two sites).
    const s = await as(priya, (c) => store.get(c, e['etmf.Study']!, ids.study_mw301!));
    expect(s!.values.sites_total).toBe(2);
    // Nor can they write into MW-207, or move a record there.
    await expect(as(priya, async (c) => {
      await withRecordContext(c, { project: 'mw207' });
      return store.create(c, e['etmf.Site']!, { site_number: 'X', study: ids.study_mw207 });
    })).rejects.toThrow(/row-level security/);
    await expect(as(priya, (c) => c.query(`update domain.etmf__site set project = 'mw207' where id = $1`, [ids.site_mw301])))
      .rejects.toThrow(/row-level security/);
    await expect(as(priya, (c) => c.query(`insert into mw.pages (id, domain, project, title) values ('page_x', 'etmf', 'mw207', 'x')`)))
      .rejects.toThrow(/row-level security/);
    // Inside MW-301 they write as before; the project comes from the write context.
    const created = await as(priya, async (c) => {
      await withRecordContext(c, { project: 'mw301' });
      return store.create(c, e['etmf.Site']!, { site_number: 'mw301-109', study: ids.study_mw301 });
    });
    expect((await store.get(db.pool, e['etmf.Site']!, created))!.project).toBe('mw301');
  });

  test('a grant in every project, or none in the domain, sees both; record scope still narrows inside a project', async () => {
    const lead = person('person_tom', [], [{ role: 'tmf_specialist', domain: 'etmf' }]);
    expect((await col(lead, 'select id from mw.runs')).length).toBe(2);
    expect((await col(lead, 'select id from domain_read.etmf__document')).length).toBe(4);
    const outsider = person('person_eve', [], [{ role: 'cra', domain: 'edc' }]);
    expect((await col(outsider, 'select id from mw.pages')).length).toBe(2);
    // Scoped to one site of MW-301: that site's documents, and nothing of MW-207.
    const scoped = person('person_sam', [], [{ role: 'cra', domain: 'etmf', project: 'mw301', scope: { site: [ids.site_mw301!] } }]);
    expect(await col(scoped, 'select id from domain_read.etmf__document')).toEqual([ids.doc_mw301]);
    // Two projects: both.
    const both = person('person_ana', [], [{ role: 'cra', domain: 'etmf', project: 'mw301' }, { role: 'study_manager', domain: 'etmf', project: 'mw207' }]);
    expect(await col(both, 'select id from mw.cases')).toEqual(['case_mw207', 'case_mw301']);
    // Roles hold per project.
    const roleIn = (p: string) => as(priya, async (c) => (await c.query(`select mw.actor_has_role_in_project('cra', 'etmf', $1) as ok`, [p])).rows[0].ok);
    expect([await roleIn('mw301'), await roleIn('mw207')]).toEqual([true, false]);
    // The app's own project (id = the app id: what came before projects, app playbooks' runs) is
    // shared: any grant in the app sees it and holds its roles there.
    expect(await roleIn('etmf')).toBe(true);
    expect(await as(priya, async (c) => (await c.query(`select mw.project_visible('etmf') as a, mw.project_visible('mw207') as b`)).rows[0]))
      .toEqual({ a: true, b: false });
  });

  test("a step writes in its run's project", async () => {
    const step = stepActor('case_mw207', 'run_case_mw207/1/qc');
    const id = await as(step, (c) => store.create(c, e['etmf.Document']!, { title: 'From the step', site: ids.site_mw207 }, { stepRunId: 'run_case_mw207/1/qc' }));
    expect((await store.get(db.pool, e['etmf.Document']!, id))!.project).toBe('mw207');
  });

  test('grants per project are stored with their source; project files replace only their own', async () => {
    const people = new PgPeopleStore(db.pool);
    const p = await people.create({ name: 'Anika Rao', email: 'anika@example.com' });
    const grants = new PgGrantStore();
    await grants.set(db.pool, p.id, [{ role: 'study_manager', domain: 'etmf', project: 'mw301' }, { role: 'study_manager', domain: 'etmf', project: 'mw207' }], 'definitions');
    await grants.set(db.pool, p.id, [{ role: 'cra', domain: 'edc' }]);
    expect(await grants.list(db.pool, p.id)).toEqual([
      { role: 'cra', domain: 'edc' },
      { role: 'study_manager', domain: 'etmf', project: 'mw207' },
      { role: 'study_manager', domain: 'etmf', project: 'mw301' },
    ]);
    await grants.clearDefinitions(db.pool);
    expect(await grants.list(db.pool, p.id)).toEqual([{ role: 'cra', domain: 'edc' }]);
    expect((await people.actorFor(p.id)).grants).toEqual([{ role: 'cra', domain: 'edc' }]);
  });

  test('a project may run several apps (a firm: one project, many apps on the same records, D105)', async () => {
    // "firm" is a copy of the Main app that also runs EDC; "other" runs EDC alone.
    await projects.sync(db.pool, [
      project('firm', { app: 'domain', apps: ['domain', 'edc'] }),
      project('other', { app: 'edc' }),
    ]);
    expect((await projects.get(db.pool, 'firm'))!.apps).toEqual(['domain', 'edc']);
    expect(await as(priya, async (c) => (await c.query(`select mw.project_apps('firm') as a, mw.project_apps('mw301') as b`)).rows[0]))
      .toEqual({ a: ['domain', 'edc'], b: ['etmf'] });
    // Two cases of an EDC playbook in the firm, both about the same customer (many cases per record).
    for (const k of ['q1', 'q2']) {
      await db.pool.query(`insert into mw.cases (id, case_type, workflow_id, workflow_hash, project) values ($1, 'filing', 'edc-filing', 'h', 'firm')`, [`case_${k}`]);
      await db.pool.query(
        `insert into mw.runs (id, workflow_id, workflow_version, workflow_hash, case_id, state, status, snapshot, driver_wf_id, project)
         values ($1, 'edc-filing', 1, 'h', $2, 'file', 'active', '{}', $1, 'firm')`, [`run_case_${k}`, `case_${k}`]);
      await db.pool.query(
        `insert into mw.step_runs (id, run_id, case_id, step_id, workflow_id, workflow_version, workflow_hash, step_hash, performer, status, token, started_at)
         values ($1, $2, $3, 'file', 'edc-filing', 1, 'h', 'h', 'agent', 'waiting', '{}', now())`, [`run_case_${k}/1/file`, `run_case_${k}`, `case_${k}`]);
    }
    // A step of an EDC case writes a Main record: it lands in the firm, which runs both apps.
    const customer = await as(stepActor('case_q1', 'run_case_q1/1/file'), (c) => store.create(c, e.Customer!, { name: 'Acme Traders' }, { stepRunId: 'run_case_q1/1/file' }));
    expect((await store.get(db.pool, e.Customer!, customer))!.project).toBe('firm');
    const again = await as(stepActor('case_q2', 'run_case_q2/1/file'), (c) => store.get(c, e.Customer!, customer));
    expect(again?.id).toBe(customer);
    // A grant in either app of the firm reaches its runs; a grant in another EDC project doesn't.
    const preparer = person('person_raj', [], [{ role: 'preparer', domain: 'edc', project: 'firm' }]);
    const elsewhere = person('person_ivy', [], [{ role: 'preparer', domain: 'edc', project: 'other' }]);
    const partner = person('person_ana2', [], [{ role: 'partner', domain: 'domain', project: 'firm' }]);
    expect(await col(preparer, `select id from mw.runs where project = 'firm'`)).toEqual(['run_case_q1', 'run_case_q2']);
    expect(await col(partner, `select id from mw.runs where project = 'firm'`)).toEqual(['run_case_q1', 'run_case_q2']);
    expect(await col(elsewhere, `select id from mw.runs where project = 'firm'`)).toEqual([]);
    expect(await col(partner, 'select id from domain_read.domain__customer')).toContain(customer);
  });

  test('queries can be narrowed to projects (an app home reads across them)', async () => {
    const q = await store.query(db.pool, e['etmf.Site']!, e, { projects: ['mw207'] });
    expect(q.total).toBe(2);
    expect(await store.aggregate(db.pool, e['etmf.Document']!, e, { kind: 'count', projects: ['mw301', 'mw207'] })).toBeGreaterThanOrEqual(4);
    expect(await store.aggregate(db.pool, e['etmf.Document']!, e, { kind: 'count', projects: ['mw310'] })).toBe(0);
  });
});
