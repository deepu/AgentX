// Flags in the inbox (24 §4, §12): an open flag is an item for the people who hold the domain
// owner's role there. A domain without an owner shows its flags to anyone with a role in it.
import { PgEntityStore, PgFlagStore, withActor } from '@memwise/db';
import { hasRole, rolesIn } from '@memwise/defs';
import type { Actor, InboxItem } from '../types.ts';
import { domainDef, entityByName, recordTitle, type RecordsDeps } from './context.ts';

const flagStore = new PgFlagStore();
const entityStore = new PgEntityStore();

export async function flagInboxItems(deps: Pick<RecordsDeps, 'pool' | 'entities' | 'project'>, actor: Actor): Promise<InboxItem[]> {
  if (actor.kind !== 'person') return [];
  const project = deps.project();
  const domains = Object.keys(project?.domains ?? {});
  const roles = project?.roles ?? {};
  const mine = domains.filter((id) => {
    const owner = domainDef(project, id).owner;
    if (!Object.keys(roles).length) return true;
    return owner ? hasRole(actor, owner, id) : rolesIn(actor, id).length > 0;
  });
  if (!mine.length) return [];
  const out: InboxItem[] = [];
  const entities = deps.entities();
  await withActor(deps.pool, actor, async (db) => {
    for (const domain of mine) {
      for (const f of await flagStore.list(db, { domain, open: true, limit: 200 })) {
        const def = entityByName(entities, f.entity);
        const row = def ? await entityStore.get(db, def, f.recordId) : undefined;
        const name = def ? recordTitle(def, f.recordId, row ? { ...row.values, ...(row.lifecycle ? { status: row.lifecycle } : {}) } : {}) : f.recordId;
        const { domain: _d, project: inProject, ...flag } = f;
        out.push({
          kind: 'flag', id: `flag:${f.id}`, flag, domain, title: `${def?.entity ?? f.entity} ${name}: ${f.invariant}`, since: f.raisedAt,
          ...(inProject ? { project: inProject } : {}),
        });
      }
    }
  });
  return out;
}
