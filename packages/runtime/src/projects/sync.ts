/**
 * Index-time sync of projects (26 §3): a row in `mw.projects` per project definition, and the
 * people a project.yaml names as people with grants in that project (source `definitions`,
 * replaced at every index, never touching grants given in the app). Someone named by email who
 * isn't in the workspace yet is added, without a password, as an invited person would be.
 */
import { PgGrantStore, PgProjectStore, withTransaction, type PgPeopleStore } from '@memwise/db';
import type { Grant, MwProjectDef, ProjectDefs } from '@memwise/defs';
import type pg from 'pg';

const projects = new PgProjectStore();
const grants = new PgGrantStore();

/** The fields an app's own project row needs beyond its ids (it has no project.yaml). */
const APP_OWN = { status: 'active', people: [], connections: [], without: [], overrides: [], implicit: true, settings: {} } as unknown as MwProjectDef;

export async function syncProjects(pool: pg.Pool, people: PgPeopleStore, defs: ProjectDefs): Promise<void> {
  const list = Object.values(defs.projects ?? {});
  // Every app's own project has a row too (id = the app id, D107), also once studies exist: it holds
  // the app's own runs (create-project) and what someone with no study makes in the app, so a record
  // made there still starts its playbooks. The 0009 backfill made these rows for existing workspaces.
  const own = Object.values(defs.apps ?? {})
    .filter((a) => !defs.projects?.[a.id])
    .map((a): MwProjectDef => ({ ...APP_OWN, id: a.id, app: a.id, apps: [a.id], name: a.title, version: a.version }));
  await projects.sync(pool, [...list, ...own]);
  const roles = new Set(Object.keys(defs.roles ?? {}));
  const byPerson = new Map<string, Grant[]>();
  for (const p of list) {
    if (p.implicit) continue;
    for (const person of p.people) {
      let found = await people.byEmail(person.email);
      if (!found) {
        try {
          found = await people.create({ name: person.name ?? person.email.split('@')[0]!, email: person.email });
        } catch (e) {
          // Made by another index at the same time.
          found = await people.byEmail(person.email);
          if (!found) throw e;
        }
      }
      const list = byPerson.get(found.id) ?? [];
      for (const role of person.roles) {
        if (roles.size && !roles.has(role)) continue; // `memwise check` reports it (unknown-role)
        // A role in the project holds in every app it runs (a firm's preparer works its GST and income-tax cases).
        for (const app of p.apps ?? [p.app]) list.push({ role, domain: app, project: p.id });
      }
      byPerson.set(found.id, list);
    }
  }
  await withTransaction(pool, async (db) => {
    await grants.clearDefinitions(db);
    for (const [personId, g] of byPerson) await grants.set(db, personId, g, 'definitions');
  });
}
