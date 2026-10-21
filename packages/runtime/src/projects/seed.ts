/**
 * Walkthrough records (26 §3, the Stage 3 seed): `projects/<id>/seed.yaml` lists records to make
 * in that project, once, when it has none yet. Each entry has a key the others refer to as
 * `"@key"`; a Document's `file` is `{ name, text }`, saved as a file. An app-scoped record
 * (`scope: app`, a Sponsor) is shared: with `match: [field]` an existing one is reused.
 *
 *   records:
 *     sponsor: { entity: Sponsor, match: [name], values: { name: Aster Bio } }
 *     study:   { entity: Study, values: { code: MW-301, sponsor: "@sponsor" } }
 *     de104:   { entity: Site, status: open, values: { site_number: DE-104, study: "@study" } }
 */
import { PgEntityStore, projectScoped, withActor } from '@memwise/db';
import { domainOf, keyOf, resolveEntity, type EntityTypeDef } from '@memwise/defs';
import { checkInvariants } from '../records/consumers.ts';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import { parse as parseYaml } from 'yaml';
import type { Actor, DocumentValue, RecordWriteResult } from '../types.ts';

export const SEED_FILE = 'seed.yaml';

interface SeedEntry { key: string; entity: string; status?: string; match?: string[]; values: Record<string, unknown> }

export interface SeedDeps {
  pool: pg.Pool;
  root: string;
  entities(): Record<string, EntityTypeDef>;
  create(input: { entity: string; values: Record<string, unknown>; status?: string; project?: string }, actor: Actor): Promise<RecordWriteResult>;
  saveFile(input: { name: string; mime: string; data: Uint8Array }, actor: Actor): Promise<DocumentValue>;
}

const store = new PgEntityStore();
const SYSTEM: Actor = { kind: 'system' };

export function parseSeed(text: string): SeedEntry[] {
  const data = parseYaml(text) as { records?: Record<string, unknown> } | null;
  const records = data?.records;
  if (!records || typeof records !== 'object') throw new Error('seed.yaml: expected `records:`, by key');
  return Object.entries(records).map(([key, raw]) => {
    const r = raw as Record<string, unknown>;
    if (typeof r?.entity !== 'string') throw new Error(`seed.yaml: ${key} needs an entity`);
    return {
      key, entity: r.entity, values: (r.values ?? {}) as Record<string, unknown>,
      ...(typeof r.status === 'string' ? { status: r.status } : {}),
      ...(Array.isArray(r.match) ? { match: r.match.map(String) } : {}),
    };
  });
}

/**
 * Makes a project's seed records, unless it already has records of a seeded project-scoped type.
 * Returns how many were made (0: no seed file, or seeded before).
 */
export async function seedProjectRecords(deps: SeedDeps, project: { id: string; app: string; apps?: string[]; dir?: string }): Promise<{ created: number; skipped?: string }> {
  if (!project.dir) return { created: 0, skipped: 'no project folder' };
  const file = join(deps.root, project.dir, SEED_FILE);
  if (!existsSync(file)) return { created: 0, skipped: 'no seed.yaml' };
  const entries = parseSeed(await readFile(file, 'utf8'));
  const apps = project.apps ?? [project.app];
  const entities = deps.entities();
  const defOf = (name: string) => {
    const def = resolveEntity(entities, project.app, name);
    if (!def) throw new Error(`seed.yaml: there is no entity type ${name} in ${project.app}`);
    return def;
  };
  // Seeded once: any record of a seeded project-scoped type in this project means it was.
  for (const e of entries) {
    const def = defOf(e.entity);
    if (!projectScoped(def) || !apps.includes(domainOf(def))) continue;
    const n = await withActor(deps.pool, SYSTEM, (db) => store.aggregate(db, def, entities, { kind: 'count', projects: [project.id] }));
    if (n) return { created: 0, skipped: 'it has records' };
  }
  const ids = new Map<string, string>();
  const made: { def: EntityTypeDef; id: string }[] = [];
  let created = 0;
  const resolve = async (v: unknown): Promise<unknown> => {
    if (typeof v === 'string' && v.startsWith('@')) {
      const id = ids.get(v.slice(1));
      if (!id) throw new Error(`seed.yaml: ${v} is not a key made above it`);
      return id;
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { name?: unknown }).name === 'string' && typeof (v as { text?: unknown }).text === 'string') {
      const f = v as { name: string; text: string; mime?: string };
      return deps.saveFile({ name: f.name, mime: f.mime ?? 'text/plain', data: new TextEncoder().encode(f.text) }, SYSTEM);
    }
    if (Array.isArray(v)) return Promise.all(v.map(resolve));
    return v;
  };
  for (const e of entries) {
    const def = defOf(e.entity);
    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e.values)) values[k] = await resolve(v);
    if (e.match?.length && !projectScoped(def)) {
      const found = await withActor(deps.pool, SYSTEM, (db) => store.list(db, def));
      const same = found.find((r) => e.match!.every((m) => r.values[m] === values[m]));
      if (same) { ids.set(e.key, same.id); continue; }
    }
    // Records of an app the project runs are its own (D105); of another app (an EDC site), that app's own project.
    const inApp = apps.includes(domainOf(def));
    const r = await deps.create({ entity: keyOf(def), values, ...(e.status ? { status: e.status } : {}), ...(inApp ? { project: project.id } : {}) }, SYSTEM);
    if (!r.applied || !r.id) throw new Error(`seed.yaml: ${e.key} (${e.entity}) was not made: ${r.message ?? r.status}${r.errors ? ` ${JSON.stringify(r.errors)}` : ''}`);
    ids.set(e.key, r.id);
    made.push({ def, id: r.id });
    created++;
  }
  // Made in their states, parents before children: rules that hold once everything is there
  // ("an open site has its whole start-up pack") are checked again at the end.
  await withActor(deps.pool, SYSTEM, async (db) => {
    for (const m of made) if (m.def.invariants?.length) await checkInvariants(db, entities, m.def, m.id);
  });
  return { created };
}
