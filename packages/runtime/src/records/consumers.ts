// The records piece's entity-event consumers (24 §4, §7), run by the flow piece's dispatcher
// before its own: `links` pairs a record with the same thing in a linked domain, and
// `invariants` raises or closes flags. Both are idempotent (a replayed event finds the pair made
// and the flag open), and both act as the system, so a person's row rules don't hide a match.
import {
  evaluateCondition, linkPairing, PgEntityStore, PgFlagStore, PgIdentityStore, tableOf, withActor, type Queryable,
} from '@memwise/db';
import { keyOf, type EntityEvent, type EntityLinkDef, type EntityTypeDef } from '@memwise/defs';
import { domainOfEntity, entityByName, plainValues, recordTitle, type RecordsDeps } from './context.ts';

/** The flow dispatcher's consumer shape (`EventConsumer` in flow/dispatcher.ts). */
export interface RecordEventConsumer {
  name: string;
  handle(event: EntityEvent): Promise<void>;
}

const entityStore = new PgEntityStore();
const flagStore = new PgFlagStore();
const identityStore = new PgIdentityStore();
const SYSTEM = { kind: 'system' } as const;

/** Every link in the project: the entity that declares it, its definition and the other side. */
function allLinks(entities: Record<string, EntityTypeDef>): { from: EntityTypeDef; link: EntityLinkDef; to: EntityTypeDef }[] {
  const out: { from: EntityTypeDef; link: EntityLinkDef; to: EntityTypeDef }[] = [];
  for (const from of Object.values(entities)) {
    for (const [k, link] of Object.entries(from.links ?? {})) {
      const to = entityByName(entities, link.target || k, domainOfEntity(from));
      if (to) out.push({ from, link: { ...link, target: link.target || k }, to });
    }
  }
  return out;
}

const empty = (v: unknown) => v === null || v === undefined || v === '';

/**
 * Pairs one record of a linking entity with the other domain's record of the same key: exactly
 * one match links them (method `key`); several make one identity candidate each, for the owner
 * of the record's domain to decide; none leaves it for when a matching record appears. A record
 * already paired from that domain keeps its pair. Returns what it did.
 */
export async function pairRecord(db: Queryable, entities: Record<string, EntityTypeDef>, from: EntityTypeDef, link: EntityLinkDef, to: EntityTypeDef,
  recordId: string): Promise<'linked' | 'candidates' | 'none' | 'kept'> {
  const { plugin, source } = linkPairing(keyOf(to));
  const entity = keyOf(from);
  if (await identityStore.linkOfRecord(db, plugin, source, entity, recordId)) return 'kept';
  const row = await entityStore.get(db, from, recordId);
  if (!row) return 'none';
  const pairs = Object.entries(link.match);
  if (!pairs.length || pairs.some(([mine]) => empty(row.values[mine]))) return 'none';
  const params: Record<string, unknown> = {};
  const filter = pairs.map(([, theirs], i) => { params[`k${i}`] = row.values[pairs[i]![0]]; return `${theirs} = params.k${i}`; }).join(' and ');
  const matches = await entityStore.query(db, to, entities, { filter, params, limit: 20 });
  const said = pairs.map(([mine]) => `${mine} ${JSON.stringify(row.values[mine])}`).join(', ');
  // The other side's records already paired with another of ours can't pair again (one to one).
  const free: typeof matches.rows = [];
  for (const m of matches.rows) {
    const taken = await identityStore.linkOf(db, plugin, source, m.id);
    if (!taken || taken.recordId === recordId) free.push(m);
  }
  if (free.length === 1) {
    const linked = await identityStore.link(db, {
      entity, recordId, plugin, source, externalId: free[0]!.id, method: 'key', score: 1,
      reasons: [`the same ${said}`], linkedBy: 'system',
    });
    return linked ? 'linked' : 'kept';
  }
  if (free.length > 1) {
    for (const m of free) {
      await identityStore.propose(db, {
        entity, recordId, plugin, source, externalId: m.id, score: 0.5,
        reasons: [`${free.length} ${to.entity} records in ${domainOfEntity(to)} have ${said}; which one is this ${from.entity}?`],
        external: { title: recordTitle(to, m.id, m.values), ...m.values },
      });
    }
    return 'candidates';
  }
  return 'none';
}

/** Pairs every unpaired record of every linking entity (on index). Counts by outcome. */
export async function pairAllLinks(deps: Pick<RecordsDeps, 'pool' | 'entities'>): Promise<Record<string, number>> {
  const entities = deps.entities();
  const counts: Record<string, number> = { linked: 0, candidates: 0, none: 0, kept: 0 };
  await withActor(deps.pool, SYSTEM, async (db) => {
    for (const { from, link, to } of allLinks(entities)) {
      const ids = await db.query<{ id: string }>(`select id from ${tableOf(from)} order by id`);
      for (const { id } of ids.rows) counts[await pairRecord(db, entities, from, link, to, id)]!++;
    }
  });
  return counts;
}

/** A broken invariant's flag text: the condition and the values that broke it. */
export function flagMessage(def: EntityTypeDef, invariant: string, values: Record<string, unknown>): string {
  const shown = plainValues(values);
  return `This ${def.entity} breaks a rule of its domain: ${invariant}${shown ? ` (${shown})` : ''}`;
}

/** Re-checks a record's invariants: raises a flag for each broken one, closes those that hold again. */
export async function checkInvariants(db: Queryable, entities: Record<string, EntityTypeDef>, def: EntityTypeDef, recordId: string)
  : Promise<{ raised: string[]; closed: string[] }> {
  const raised: string[] = [];
  const closed: string[] = [];
  const invariants = def.invariants ?? [];
  if (!invariants.length) return { raised, closed };
  const entity = keyOf(def);
  if (!(await entityStore.get(db, def, recordId))) return { raised, closed };
  for (const invariant of invariants) {
    const r = await evaluateCondition(db, def, entities, recordId, invariant);
    if (r.holds) {
      if (await flagStore.close(db, entity, recordId, invariant)) closed.push(invariant);
    } else {
      const f = await flagStore.raise(db, { entity, recordId, invariant, message: flagMessage(def, invariant, r.values) });
      if (f.raised) raised.push(invariant);
    }
  }
  return { raised, closed };
}

/** The consumers, in the order the dispatcher calls them: pairing first, so invariants see followed fields. */
export function recordConsumers(deps: Pick<RecordsDeps, 'pool' | 'entities' | 'emit'>): RecordEventConsumer[] {
  const links: RecordEventConsumer = {
    name: 'links',
    async handle(event) {
      const entities = deps.entities();
      const def = entityByName(entities, event.entity);
      if (!def) return;
      const key = keyOf(def);
      let changed = false;
      await withActor(deps.pool, SYSTEM, async (db) => {
        for (const { from, link, to } of allLinks(entities)) {
          if (keyOf(from) === key) {
            // A record of the linking side: pair it.
            if (event.kind === 'changed' && event.fields && !event.fields.some((f) => f in link.match)) continue;
            const r = await pairRecord(db, entities, from, link, to, event.recordId);
            changed ||= r === 'linked' || r === 'candidates';
          } else if (keyOf(to) === key) {
            // A record of the linked side: the unpaired records of ours with its key.
            const row = await entityStore.get(db, to, event.recordId);
            if (!row) continue;
            const pairs = Object.entries(link.match);
            if (pairs.some(([, theirs]) => empty(row.values[theirs]))) continue;
            const params: Record<string, unknown> = {};
            const filter = pairs.map(([mine, theirs], i) => { params[`k${i}`] = row.values[theirs]; return `${mine} = params.k${i}`; }).join(' and ');
            const ours = await entityStore.query(db, from, entities, { filter, params, limit: 20 });
            for (const o of ours.rows) {
              const r = await pairRecord(db, entities, from, link, to, o.id);
              changed ||= r === 'linked' || r === 'candidates';
            }
          }
        }
      });
      if (changed) deps.emit({ kind: 'records', entity: key, recordId: event.recordId });
    },
  };

  const invariants: RecordEventConsumer = {
    name: 'invariants',
    async handle(event) {
      const entities = deps.entities();
      const def = entityByName(entities, event.entity);
      if (!def?.invariants?.length) return;
      const r = await withActor(deps.pool, SYSTEM, (db) => checkInvariants(db, entities, def, event.recordId));
      if (r.raised.length || r.closed.length) deps.emit({ kind: 'records', entity: keyOf(def), recordId: event.recordId });
    },
  };

  return [links, invariants];
}
