/**
 * Turns a loaded project into definition rows and the references between them, for the
 * run snapshot (D36) and impact analysis ("what uses `client_intake.gstin`?", 08 §3).
 */
import type { DefinitionRef, DefinitionStore, IndexedDefinition } from './contracts.ts';
import { DEFAULT_DOMAIN } from './domain-types.ts';
import { domainOf, keyOf, resolveEntity } from './domains.ts';
import { sha256 } from './source.ts';
import type { PolicyDoc, ProjectDefs, ValueType, WorkflowDef } from './types.ts';

/** Policy rows: the default domain's layer is `domain`; a workflow's layer has the workflow's id. */
export const DOMAIN_POLICY_ID = 'domain';
/** Phase 6: the workspace layer's policy row. */
export const WORKSPACE_POLICY_ID = 'workspace';
/** Phase 6: another domain's policy row, `domain:<id>` (the default domain keeps `domain`). */
export const domainPolicyId = (domain: string): string => (domain === DEFAULT_DOMAIN ? DOMAIN_POLICY_ID : `domain:${domain}`);
/** Stage 3: a project's own app policy layer (its `overrides/policy.yaml`), `project:<id>`. */
export const projectPolicyId = (projectId: string): string => `project:${projectId}`;

/** Stable JSON (sorted keys), so the same policy always hashes the same. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const policyHash = (doc: PolicyDoc) => sha256(stableJson(doc));

/**
 * Entity types a value type points at, by entity key: `Ref<Customer>`, `Ref<Site>` in the etmf
 * domain (`etmf.Site`), or a named type that is an entity. A name that resolves to nothing keeps
 * the name as written.
 */
function entityTargets(type: ValueType, entities: ProjectDefs['entities'], domain: string): string[] {
  if (type.kind === 'list') return entityTargets(type.of, entities, domain);
  const key = (name: string) => { const def = resolveEntity(entities, domain, name); return def ? keyOf(def) : name; };
  if (type.kind === 'ref') return [key(type.entity)];
  if (type.kind === 'named' && resolveEntity(entities, domain, type.name)) return [key(type.name)];
  return [];
}

export async function indexProject(project: ProjectDefs, store: DefinitionStore): Promise<{ definitions: number; refs: number }> {
  const defs = new Map<string, IndexedDefinition>();
  const refs = new Map<string, DefinitionRef>();
  const addDef = (def: IndexedDefinition) => defs.set(`${def.kind}\0${def.id}\0${def.hash}`, def);
  const addRef = (ref: DefinitionRef) => refs.set([ref.fromKind, ref.fromId, ref.fromHash, ref.toKind, ref.toId].join('\0'), ref);

  if (project.domainPolicy) {
    const p = project.domainPolicy;
    addDef({ kind: 'policy', id: DOMAIN_POLICY_ID, hash: policyHash(p), path: p.file ?? 'domain/policy.yaml', body: p });
  }
  // Phase 6: the workspace layer, and every other domain's layer as `domain:<id>`.
  const workspacePolicy = project.workspace?.policy;
  if (workspacePolicy) addDef({ kind: 'policy', id: WORKSPACE_POLICY_ID, hash: policyHash(workspacePolicy), path: workspacePolicy.file ?? 'workspace.yaml', body: workspacePolicy });
  for (const domain of Object.values(project.domains ?? {})) {
    if (domain.id !== DEFAULT_DOMAIN && domain.policy) {
      addDef({ kind: 'policy', id: domainPolicyId(domain.id), hash: policyHash(domain.policy), path: domain.policy.file ?? `${domain.dir}/policy.yaml`, body: domain.policy });
    }
    // A domain with a domain.yaml, its free pages and its shared views (each `<domain>/<id>`).
    const { pages, views, ...rest } = domain;
    if (domain.file) {
      const hash = sha256(stableJson(rest));
      addDef({ kind: 'domain', id: domain.id, hash, path: domain.file, body: rest });
      for (const key of domain.entities) addRef({ fromKind: 'domain', fromId: domain.id, fromHash: hash, toKind: 'entity_type', toId: key });
    }
    for (const [kind, defs] of [['page', pages], ['view', views]] as const) {
      for (const def of Object.values(defs)) {
        const id = `${domain.id}/${def.id}`;
        const hash = sha256(stableJson(def));
        addDef({ kind, id, hash, path: def.file ?? domain.dir, body: def });
        const named = kind === 'view' ? [(def as typeof views[string]).entity] : pageEntities(def as typeof pages[string]);
        for (const name of named) {
          const target = resolveEntity(project.entities, domain.id, name);
          addRef({ fromKind: kind, fromId: id, fromHash: hash, toKind: 'entity_type', toId: target ? keyOf(target) : name });
        }
      }
    }
  }

  for (const entity of Object.values(project.entities)) {
    const id = keyOf(entity);
    const domain = domainOf(entity);
    addDef({ kind: 'entity_type', id, hash: entity.hash, path: entity.file, body: entity });
    const from = { fromKind: 'entity_type', fromId: id, fromHash: entity.hash } as const;
    for (const field of Object.values(entity.fields)) {
      for (const target of entityTargets(field.type, project.entities, domain)) addRef({ ...from, toKind: 'entity_type', toId: target });
    }
    for (const rel of Object.values(entity.relationships)) {
      const target = resolveEntity(project.entities, domain, rel.target);
      addRef({ ...from, toKind: 'entity_type', toId: target ? keyOf(target) : rel.target });
    }
    for (const key of Object.keys(entity.links ?? {})) addRef({ ...from, toKind: 'entity_type', toId: key });
  }

  /** A workflow, its case type, policy and steps; `kind` is `project_workflow` for a project's own copy. */
  const indexWorkflow = (wf: WorkflowDef, kind: 'workflow' | 'project_workflow') => {
    const fromWf = { fromKind: kind, fromId: wf.id, fromHash: wf.hash } as const;
    const domain = domainOf(wf);
    const entityKey = (name: string) => { const def = resolveEntity(project.entities, domain, name); return def ? keyOf(def) : name; };
    addDef({ kind, id: wf.id, version: wf.version, hash: wf.hash, path: wf.dir, body: wf });

    const ct = wf.caseType;
    if (ct.id) {
      addDef({ kind: 'case_type', id: ct.id, hash: ct.hash, path: ct.file, body: ct });
      addRef({ ...fromWf, toKind: 'case_type', toId: ct.id });
      const fromCase = { fromKind: 'case_type', fromId: ct.id, fromHash: ct.hash } as const;
      for (const field of [...Object.values(ct.fields), ...Object.values(ct.types).flatMap((r) => Object.values(r.fields))]) {
        for (const target of entityTargets(field.type, project.entities, domain)) addRef({ ...fromCase, toKind: 'entity_type', toId: target });
      }
    }

    if (wf.policy) {
      addDef({ kind: 'policy', id: wf.id, version: wf.version, hash: policyHash(wf.policy), path: wf.policy.file ?? `${wf.dir}/policy.yaml`, body: wf.policy });
      addRef({ ...fromWf, toKind: 'policy', toId: wf.id });
    }
    // Every workflow runs under its domain's layer (and the workspace's), so a change there affects all of them.
    const domainPolicy = domain === DEFAULT_DOMAIN ? project.domainPolicy : project.domains?.[domain]?.policy;
    if (domainPolicy) addRef({ ...fromWf, toKind: 'policy', toId: domainPolicyId(domain) });
    if (workspacePolicy) addRef({ ...fromWf, toKind: 'policy', toId: WORKSPACE_POLICY_ID });
    // Phase 6: what starts it, and the workflows its block states hand work to.
    for (const t of wf.startsOn ?? []) if ('entity' in t) addRef({ ...fromWf, toKind: 'entity_type', toId: entityKey(t.entity) });
    for (const state of Object.values(wf.states)) {
      const b = state.block;
      if (b && b.kind !== 'wait_until') addRef({ ...fromWf, toKind: 'workflow', toId: b.workflow });
    }

    for (const [state, step] of Object.entries(wf.steps)) {
      const id = `${wf.id}/${state}`;
      addDef({ kind: 'step', id, version: wf.version, hash: step.hash, path: step.file, body: step });
      addRef({ ...fromWf, toKind: 'step', toId: id });

      const fromStep = { fromKind: 'step', fromId: id, fromHash: step.hash } as const;
      const tools = new Set([...step.tools.allowed, ...step.tools.required]);
      for (const w of Object.values(step.writes)) if (w.from.kind === 'tool') tools.add(w.from.tool);
      for (const tool of tools) addRef({ ...fromStep, toKind: 'tool', toId: tool });
      if (step.model) addRef({ ...fromStep, toKind: 'model_role', toId: step.model });

      // Case fields as `<case type>.<field>`; a read of `case.customer.name` uses the field `customer`.
      const fields = new Set([...step.reads.filter((r) => r.startsWith('case.')).map((r) => r.split('.')[1]!), ...Object.keys(step.writes)]);
      for (const f of fields) addRef({ ...fromStep, toKind: 'case_field', toId: `${ct.id}.${f}` });
    }
  };
  for (const wf of Object.values(project.workflows)) indexWorkflow(wf, 'workflow');

  // Stage 3 (26 §3): apps, projects, each project's own playbooks and its own policy layer.
  for (const app of Object.values(project.apps ?? {})) {
    addDef({ kind: 'app', id: app.id, version: app.version, hash: sha256(stableJson(app)), path: app.file ?? project.domains?.[app.id]?.dir ?? app.id, body: app });
  }
  for (const p of Object.values(project.projects ?? {})) {
    const { workflows, policy, pages, views, ...rest } = p;
    const body = {
      ...rest,
      workflows: Object.fromEntries(Object.values(workflows).map((w) => [w.id, w.hash])),
      ...(policy ? { policyHash: policyHash(policy) } : {}),
      pages: Object.keys(pages).sort(),
      views: Object.keys(views).sort(),
    };
    const hash = sha256(stableJson(body));
    addDef({ kind: 'project', id: p.id, version: p.version, hash, path: p.file ?? p.app, body });
    if (p.implicit) continue;
    for (const wf of Object.values(workflows)) {
      indexWorkflow(wf, 'project_workflow');
      addRef({ fromKind: 'project', fromId: p.id, fromHash: hash, toKind: 'project_workflow', toId: wf.id });
    }
    if (policy && p.overrides.some((o) => /^policy\.ya?ml$/.test(o))) {
      addDef({ kind: 'policy', id: projectPolicyId(p.id), hash: policyHash(policy), path: policy.file ?? `${p.dir}/policy.yaml`, body: policy });
      addRef({ fromKind: 'project', fromId: p.id, fromHash: hash, toKind: 'policy', toId: projectPolicyId(p.id) });
    }
  }

  await store.upsert([...defs.values()], [...refs.values()]);
  return { definitions: defs.size, refs: refs.size };
}

/** Entity names a dashboard reads (as written). */
function pageEntities(page: import('./domain-types.ts').FreePageDef): string[] {
  const out = new Set<string>();
  if (page.under) out.add(page.under.entity);
  for (const b of page.blocks) {
    if (b.kind === 'kpi') { const v = b.value; out.add('count' in v ? v.count : 'percent' in v ? v.percent : 'sum' in v ? v.sum : v.avg); }
    else if (b.kind === 'heatmap') out.add(b.rows.entity);
    else if ((b.kind === 'table' || b.kind === 'list') && typeof b.view !== 'string') out.add(b.view.entity);
  }
  return [...out];
}
