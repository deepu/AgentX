// The eTMF example (examples/etmf) through the real loader: its schema applies, calculated and
// followed fields read, and its views' and dashboards' conditions compile.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { loadProject, type ProjectDefs } from '@memwise/defs';
import {
  applyDomainSchema, createTestDatabase, domainCreators, domainUpdaters, PgEntityStore, PgRecordVersions, postgresAvailable,
  withActor, withRecordContext, type TestDatabase,
} from '../src/index.ts';

const EXAMPLE = path.resolve(import.meta.dir, '../../../examples/etmf');

describe.skipIf(!postgresAvailable())('the eTMF example project', () => {
  let db: TestDatabase;
  let project: ProjectDefs;
  const store = new PgEntityStore();

  beforeAll(async () => {
    db = await createTestDatabase('mw_p6_etmf');
    project = (await loadProject(EXAMPLE)).project;
    await applyDomainSchema(db.pool, project.entities, {
      creators: domainCreators(project.entities, project.workflows),
      updaters: domainUpdaters(project.entities, project.workflows),
      domains: project.domains,
    });
  }, 60_000);
  afterAll(() => db?.drop());

  test('every entity has its table and view; US-012 shows its EDC name and start-up pack', async () => {
    const { rows } = await db.pool.query(`select table_name from information_schema.views where table_schema = 'domain_read' order by 1`);
    expect(rows.map((r) => r.table_name)).toEqual(Object.values(project.entities).map((d) => `${d.domain}__${d.entity.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}`).sort());
    const e = project.entities;
    const manager = { kind: 'person' as const, personId: 'person_sm', roles: ['study_manager'] };
    const ids = await withActor(db.pool, manager, async (c) => {
      await withRecordContext(c, { reason: 'seed' });
      const sponsor = await store.create(c, e['etmf.Sponsor']!, firstText(e['etmf.Sponsor']!, 'Aster Bio'));
      const study = await store.create(c, e['etmf.Study']!, { ...firstText(e['etmf.Study']!, 'ONC-1'), ...refTo(e['etmf.Study']!, 'Sponsor', sponsor) });
      const site = await store.create(c, e['etmf.Site']!, { site_number: 'US-012', study });
      for (let i = 0; i < 10; i++) {
        const x = await store.create(c, e['etmf.ExpectedDocument']!, { ...firstText(e['etmf.ExpectedDocument']!, `A${i}`), site, study });
        if (i < 9) await store.transition(c, e['etmf.ExpectedDocument']!, x, { to: 'filed', transition: 'to_filed' });
      }
      const edc = await store.create(c, e['edc.Site']!, { site_number: 'US-012', name: 'Harbor Oncology, Boston' });
      return { site, edc };
    });
    await db.pool.query(
      `insert into mw.identity_links (id, entity, record_id, plugin, source, external_id, method, score) values ('link_1', 'etmf.Site', $1, 'domain:edc', 'Site', $2, 'key', 1)`,
      [ids.site, ids.edc]);
    const site = await withActor(db.pool, manager, (c) => store.get(c, e['etmf.Site']!, ids.site));
    expect(site!.values).toMatchObject({ name: 'Harbor Oncology, Boston', start_up_pack_complete: 90 });
    expect(await new PgRecordVersions().verifyChain(db.pool, 'etmf.Site', ids.site)).toEqual({ ok: true });
  });

  test('the views\' filters and sorts and the TMF health numbers run', async () => {
    let n = 0;
    for (const d of Object.values(project.domains ?? {})) {
      for (const v of Object.values(d.views)) {
        const key = v.entity.includes('.') ? v.entity : d.id === 'domain' ? v.entity : `${d.id}.${v.entity}`;
        const def = project.entities[key]!;
        const r = await store.query(db.pool, def, project.entities, {
          ...(v.filter ? { filter: v.filter } : {}), ...(v.sort ? { sort: v.sort } : {}), ...(v.group ? { group: v.group } : {}),
        });
        expect(r.total).toBeGreaterThanOrEqual(0);
        n++;
      }
    }
    expect(n).toBe(4);
    const e = project.entities;
    const study = (await store.list(db.pool, e['etmf.Study']!))[0]!.id;
    const params = { study };
    expect(await store.aggregate(db.pool, e['etmf.ExpectedDocument']!, e, { kind: 'percent', of: 'study = params.study', where: "status = 'filed'", params })).toBe(90);
    expect(await store.aggregate(db.pool, e['etmf.Document']!, e, { kind: 'count', where: "status = 'in_qc' and study = params.study", params })).toBe(0);
    expect(await store.aggregate(db.pool, e['etmf.Person']!, e, { kind: 'count', where: 'cv_expires <= today + 30d' })).toBe(0);
  });
});

function firstText(def: ProjectDefs['entities'][string], value: string): Record<string, unknown> {
  const name = Object.entries(def.fields).find(([, f]) => f.type.kind === 'scalar' && f.type.name === 'Text')?.[0];
  return name ? { [name]: value } : {};
}

function refTo(def: ProjectDefs['entities'][string], target: string, id: string): Record<string, unknown> {
  const name = Object.entries(def.fields).find(([, f]) => f.type.kind === 'ref' && f.type.entity.endsWith(target))?.[0];
  return name ? { [name]: id } : {};
}
