// kernel.domains (24 §2, §12): the workspace's domains for the sidebar (entity types with record
// counts under the viewer's row rules, playbooks, pages, views, open flags), the workspace itself,
// and people's grants (a role in one domain, optionally limited to records).
import { PgFlagStore, PgGrantStore, PgPageStore, viewOf, withActor } from '@memwise/db';
import { DEFAULT_DOMAIN, META_PLAYBOOKS, hasRole, keyOf, type Grant } from '@memwise/defs';
import type { Actor, DomainsService, DomainSummary } from '../types.ts';
import { domainDef, domainOfEntity, type RecordsDeps } from './context.ts';

/** Firings of one trigger within a minute above this are held, unless the workspace says otherwise (24 §7). */
export const WORKSPACE_STORM_LIMIT = 25;

const grantStore = new PgGrantStore();
const flagStore = new PgFlagStore();
const pageStore = new PgPageStore();

export function createDomainsService(deps: RecordsDeps): DomainsService {
  /** The domains of the project; a project without `domains/` has the default one. */
  const domainIds = (): string[] => {
    const project = deps.project();
    const ids = Object.keys(project?.domains ?? {});
    if (ids.length) return ids;
    return Object.keys(deps.entities()).length || Object.keys(project?.workflows ?? {}).length ? [DEFAULT_DOMAIN] : [];
  };

  return {
    async list(actor: Actor): Promise<DomainSummary[]> {
      const project = deps.project();
      const entities = Object.values(deps.entities());
      const out: DomainSummary[] = [];
      await withActor(deps.pool, actor, async (db) => {
        for (const id of domainIds()) {
          const d = domainDef(project, id);
          const mine = entities.filter((e) => domainOfEntity(e) === id);
          const counted: DomainSummary['entities'] = [];
          for (const def of mine) {
            const n = await db.query<{ n: number }>(`select count(*)::int as n from ${viewOf(def)}`).then((r) => r.rows[0]!.n).catch(() => 0);
            counted.push({
              key: keyOf(def), entity: def.entity, count: n,
              ...(def.parent ? { parent: def.parent } : {}), ...(def.lifecycle?.length ? { lifecycle: def.lifecycle } : {}),
            });
          }
          const written = await pageStore.list(db, id);
          const flags = await flagStore.list(db, { domain: id, open: true, limit: 1000 });
          const workflows = d.workflows.length ? d.workflows
            : Object.values(project?.workflows ?? {}).filter((w) => (w.domain ?? DEFAULT_DOMAIN) === id).map((w) => w.id);
          // A project of named domains has no default one of its own: the meta playbooks the app adds
          // (building and changing playbooks, binding plugins) don't make one appear in the sidebar.
          const onlyMeta = workflows.every((w) => (META_PLAYBOOKS as readonly string[]).includes(w));
          if (id === DEFAULT_DOMAIN && domainIds().length > 1 && !mine.length && !Object.keys(d.pages).length && !Object.keys(d.views).length && !written.length && onlyMeta) continue;
          out.push({
            id, name: d.name, ...(d.description ? { description: d.description } : {}), regulated: !!d.regulated,
            ...(d.owner ? { owner: d.owner } : {}), ...(d.retentionMs !== undefined ? { retentionMs: d.retentionMs } : {}),
            entities: counted,
            workflows,
            pages: [
              ...Object.values(d.pages).map((p) => ({ id: p.id, title: p.title, ...(p.under ? { under: { entity: p.under.entity } } : {}) })),
              ...written.map((p) => ({ id: p.id, title: p.title, ...(p.under ? { under: { entity: p.under.entity } } : {}) })),
            ],
            views: Object.values(d.views).map((v) => ({ id: v.id, title: v.title, entity: v.entity })),
            flags: flags.length,
          });
        }
      });
      return out;
    },

    async workspace() {
      const project = deps.project();
      return {
        name: project?.workspace?.name ?? 'Workspace',
        stormLimit: project?.workspace?.stormLimit ?? WORKSPACE_STORM_LIMIT,
        regulated: Object.values(project?.domains ?? {}).some((d) => d.regulated),
      };
    },

    grants: (personId) => grantStore.list(deps.pool, personId),

    async setGrants(personId: string, grants: Grant[], by: Actor) {
      if (by.kind !== 'person' && by.kind !== 'system') throw new Error('only a person changes who has which role');
      const project = deps.project();
      if (!(await deps.people.get(personId))) throw new Error(`there is no person ${personId}`);
      const domains = new Set(domainIds());
      const roles = project?.roles ?? {};
      for (const g of grants) {
        if (domains.size && !domains.has(g.domain)) throw new Error(`there is no domain ${g.domain}`);
        if (Object.keys(roles).length && !roles[g.role]) throw new Error(`there is no role ${g.role}`);
      }
      // A person changes grants only in domains they own (the domain's owner role), both the
      // grants they give and the ones they take away.
      if (by.kind === 'person') {
        const before = await grantStore.list(deps.pool, personId);
        for (const domain of new Set([...grants, ...before].map((g) => g.domain))) {
          const owner = project?.domains?.[domain]?.owner;
          if (!owner || !hasRole(by, owner, domain)) {
            throw new Error(`only the owner of ${project?.domains?.[domain]?.name ?? domain}${owner ? ` (${owner})` : ''} changes who has which role there`);
          }
        }
      }
      const saved = await grantStore.set(deps.pool, personId, grants);
      deps.emit({ kind: 'inbox' });
      return saved;
    },
  };
}
