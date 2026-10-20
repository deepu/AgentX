/**
 * Grants (24 §2): a role in one domain, optionally limited to records (`scope`). Workspace-wide
 * roles stay in `mw.person_roles` (PgPeopleStore). `setActor` passes a person's grants to
 * Postgres as `mw.grants`, which `mw.actor_has_role_in` and the record-scope rules read.
 */
import type { Grant } from '@memwise/defs';
import type { Queryable } from '../pool.ts';
import { json } from '../rows.ts';

type GrantDbRow = { person_id: string; role_id: string; domain: string; scope: Record<string, string[] | string> | null };

/** Scope values as lists, empty scopes dropped. */
function normalScope(scope: Grant['scope'] | Record<string, string[] | string> | null | undefined): Grant['scope'] | undefined {
  if (!scope || typeof scope !== 'object') return undefined;
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(scope)) {
    const ids = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && !!x);
    if (ids.length) out[k] = [...new Set(ids)].sort();
  }
  return Object.keys(out).length ? out : undefined;
}

const toGrant = (r: GrantDbRow): Grant => {
  const scope = normalScope(r.scope);
  return { role: r.role_id, domain: r.domain, ...(scope ? { scope } : {}) };
};

export class PgGrantStore {
  /** A person's grants, by domain then role. */
  async list(db: Queryable, personId: string): Promise<Grant[]> {
    const { rows } = await db.query<GrantDbRow>(
      'select person_id, role_id, domain, scope from mw.grants where person_id = $1 order by domain, role_id, id', [personId]);
    return rows.map(toGrant);
  }

  /** Grants of everyone, by person (the people screen). */
  async all(db: Queryable): Promise<Map<string, Grant[]>> {
    const { rows } = await db.query<GrantDbRow>('select person_id, role_id, domain, scope from mw.grants order by person_id, domain, role_id, id');
    const out = new Map<string, Grant[]>();
    for (const r of rows) out.set(r.person_id, [...(out.get(r.person_id) ?? []), toGrant(r)]);
    return out;
  }

  /** Replaces a person's grants (duplicates folded). Returns them as stored. */
  async set(db: Queryable, personId: string, grants: Grant[]): Promise<Grant[]> {
    const seen = new Set<string>();
    const clean: Grant[] = [];
    for (const g of grants) {
      const role = g.role?.trim();
      const domain = g.domain?.trim();
      if (!role || !domain) throw new Error('A grant needs a role and a domain');
      if (role.includes(',')) throw new Error('A role id cannot contain a comma');
      const scope = normalScope(g.scope);
      const key = JSON.stringify([role, domain, scope ?? null]);
      if (seen.has(key)) continue;
      seen.add(key);
      clean.push({ role, domain, ...(scope ? { scope } : {}) });
    }
    await db.query('delete from mw.grants where person_id = $1', [personId]);
    for (const g of clean) {
      await db.query('insert into mw.grants (person_id, role_id, domain, scope) values ($1, $2, $3, $4)',
        [personId, g.role, g.domain, g.scope ? json(g.scope) : null]);
    }
    return this.list(db, personId);
  }
}
