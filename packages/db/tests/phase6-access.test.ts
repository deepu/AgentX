import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { EntityTypeDef } from '@memwise/defs';
import {
  applyDomainSchema, createTestDatabase, PgEntityStore, PgGrantStore, PgPeopleStore, postgresAvailable, withActor,
  withRecordContext, type TestDatabase,
} from '../src/index.ts';
import { fixtureDomains, fixtureEntities, person } from './phase6-fixtures.ts';

describe.skipIf(!postgresAvailable())('grants and record scope (24 §2)', () => {
  let db: TestDatabase;
  let e: Record<string, EntityTypeDef>;
  const store = new PgEntityStore();
  let people: PgPeopleStore;
  const ids = {} as Record<'aster' | 'borealis' | 'siteA' | 'siteB' | 'docA' | 'docB' | 'edc', string>;

  beforeAll(async () => {
    db = await createTestDatabase('mw_p6_access');
    e = fixtureEntities();
    await applyDomainSchema(db.pool, e, { domains: fixtureDomains() });
    people = new PgPeopleStore(db.pool);
    const seed = person('person_admin', ['study_manager']);
    await withActor(db.pool, seed, async (c) => {
      await withRecordContext(c, { reason: 'seed' });
      ids.aster = await store.create(c, e['etmf.Sponsor']!, { name: 'Aster Bio' });
      ids.borealis = await store.create(c, e['etmf.Sponsor']!, { name: 'Borealis Pharma' });
      ids.siteA = await store.create(c, e['etmf.Site']!, { site_number: 'A-1', sponsor: ids.aster });
      ids.siteB = await store.create(c, e['etmf.Site']!, { site_number: 'B-1', sponsor: ids.borealis });
      ids.docA = await store.create(c, e['etmf.Document']!, { title: 'Aster CV', sponsor: ids.aster, site: ids.siteA, reviewer_note: 'ok' });
      ids.docB = await store.create(c, e['etmf.Document']!, { title: 'Borealis CV', sponsor: ids.borealis, site: ids.siteB });
      ids.edc = await store.create(c, e['edc.Site']!, { site_number: 'A-1', name: 'Clinic' });
    });
  }, 60_000);
  afterAll(() => db?.drop());

  test('grants are stored per person and come with the actor', async () => {
    const p = await people.create({ name: 'Tess', email: 'tess@example.com', roles: [] });
    const grants = new PgGrantStore();
    const stored = await grants.set(db.pool, p.id, [
      { role: 'tmf_specialist', domain: 'etmf', scope: { sponsor: [ids.aster!] } },
      { role: 'tmf_specialist', domain: 'etmf', scope: { sponsor: [ids.aster!] } },
      { role: 'cra', domain: 'edc' },
    ]);
    expect(stored).toEqual([{ role: 'cra', domain: 'edc' }, { role: 'tmf_specialist', domain: 'etmf', scope: { sponsor: [ids.aster!] } }]);
    expect((await people.get(p.id))!.grants).toEqual(stored);
    expect(await people.actorFor(p.id)).toEqual({ kind: 'person', personId: p.id, roles: [], grants: stored });
    expect(await people.setGrants(p.id, [])).toEqual([]);
    expect((await people.get(p.id))!.grants).toBeUndefined();
  });

  test('two sponsors: a scoped specialist sees only their sponsor\'s records, everywhere it applies', async () => {
    const tess = person('person_tess', [], [{ role: 'tmf_specialist', domain: 'etmf', scope: { sponsor: [ids.aster!] } }]);
    const bob = person('person_bob', [], [{ role: 'tmf_specialist', domain: 'etmf', scope: { sponsor: [ids.borealis!] } }]);
    const seen = (actor: typeof tess, entity: string) => withActor(db.pool, actor, async (c) =>
      (await store.list(c, e[entity]!)).map((r) => r.id).sort());
    expect(await seen(tess, 'etmf.Document')).toEqual([ids.docA]);
    expect(await seen(bob, 'etmf.Document')).toEqual([ids.docB]);
    expect(await seen(tess, 'etmf.Site')).toEqual([ids.siteA]);
    // The Sponsor table is filtered by its own id.
    expect(await seen(tess, 'etmf.Sponsor')).toEqual([ids.aster]);
    // Tables without a sponsor column are not filtered; other domains neither.
    expect(await seen(tess, 'etmf.ExpectedDocument')).toEqual([]);
    expect(await seen(tess, 'edc.Site')).toEqual([ids.edc]);
    // The base table follows the same rule (RLS), and writes outside the scope do nothing.
    const raw = await withActor(db.pool, tess, (c) => c.query('select id from domain.etmf__document order by id'));
    expect(raw.rows.map((r) => r.id)).toEqual([ids.docA]);
    const upd = await withActor(db.pool, tess, (c) => c.query(`update domain.etmf__document set tag = 'x' where id = $1`, [ids.docB]));
    expect(upd.rowCount).toBe(0);
    await expect(withActor(db.pool, tess, (c) => store.create(c, e['etmf.Document']!, { title: 'Sneaky', sponsor: ids.borealis }, { reason: 'r' })))
      .rejects.toThrow(/row-level security/);
    // Someone with a workspace-wide role and no grants in etmf sees both.
    const both = person('person_sm', ['study_manager']);
    expect(await seen(both, 'etmf.Document')).toEqual([ids.docA, ids.docB].sort());
  });

  test('an unscoped grant, or a workspace-wide role alone, sees everything', async () => {
    const wide = person('person_w', [], [
      { role: 'tmf_specialist', domain: 'etmf', scope: { sponsor: [ids.aster!] } },
      { role: 'study_manager', domain: 'etmf' },
    ]);
    const n = await withActor(db.pool, wide, async (c) => (await store.list(c, e['etmf.Document']!)).length);
    expect(n).toBe(2);
  });

  test('field access accepts a grant in the entity\'s domain (mw.actor_has_role_in)', async () => {
    const granted = person('person_g', [], [{ role: 'tmf_specialist', domain: 'etmf' }]);
    const elsewhere = person('person_x', [], [{ role: 'tmf_specialist', domain: 'edc' }]);
    const wide = person('person_y', ['tmf_specialist']);
    const note = (a: typeof granted) => withActor(db.pool, a, async (c) => (await store.get(c, e['etmf.Document']!, ids.docA!))!.values.reviewer_note);
    expect(await note(granted)).toBe('ok');
    expect(await note(wide)).toBe('ok');
    expect(await note(elsewhere)).toBeNull();
    const fn = await withActor(db.pool, granted, (c) => c.query(
      `select mw.actor_has_role_in('tmf_specialist', 'etmf') as a, mw.actor_has_role_in('tmf_specialist', 'edc') as b`));
    expect(fn.rows[0]).toEqual({ a: true, b: false });
  });
});
