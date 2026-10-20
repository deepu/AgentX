/**
 * Turns a loaded project into definition rows and the references between them, for the
 * run snapshot (D36) and impact analysis ("what uses `client_intake.gstin`?", 08 §3).
 */
import type { DefinitionRef, DefinitionStore, IndexedDefinition } from './contracts.ts';
import { sha256 } from './source.ts';
import type { PolicyDoc, ProjectDefs, ValueType } from './types.ts';

/** Policy rows: the domain layer is `domain`; a workflow's layer has the workflow's id. */
export const DOMAIN_POLICY_ID = 'domain';

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

/** Entity types a value type points at: `Ref<Customer>`, or a named type that is an entity. */
function entityTargets(type: ValueType, entities: ProjectDefs['entities']): string[] {
  if (type.kind === 'list') return entityTargets(type.of, entities);
  if (type.kind === 'ref') return [type.entity];
  if (type.kind === 'named' && entities[type.name]) return [type.name];
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

  for (const entity of Object.values(project.entities)) {
    addDef({ kind: 'entity_type', id: entity.entity, hash: entity.hash, path: entity.file, body: entity });
    const from = { fromKind: 'entity_type', fromId: entity.entity, fromHash: entity.hash } as const;
    for (const field of Object.values(entity.fields)) {
      for (const target of entityTargets(field.type, project.entities)) addRef({ ...from, toKind: 'entity_type', toId: target });
    }
    for (const rel of Object.values(entity.relationships)) addRef({ ...from, toKind: 'entity_type', toId: rel.target });
  }

  for (const wf of Object.values(project.workflows)) {
    const fromWf = { fromKind: 'workflow', fromId: wf.id, fromHash: wf.hash } as const;
    addDef({ kind: 'workflow', id: wf.id, version: wf.version, hash: wf.hash, path: wf.dir, body: wf });

    const ct = wf.caseType;
    if (ct.id) {
      addDef({ kind: 'case_type', id: ct.id, hash: ct.hash, path: ct.file, body: ct });
      addRef({ ...fromWf, toKind: 'case_type', toId: ct.id });
      const fromCase = { fromKind: 'case_type', fromId: ct.id, fromHash: ct.hash } as const;
      for (const field of [...Object.values(ct.fields), ...Object.values(ct.types).flatMap((r) => Object.values(r.fields))]) {
        for (const target of entityTargets(field.type, project.entities)) addRef({ ...fromCase, toKind: 'entity_type', toId: target });
      }
    }

    if (wf.policy) {
      addDef({ kind: 'policy', id: wf.id, version: wf.version, hash: policyHash(wf.policy), path: wf.policy.file ?? `${wf.dir}/policy.yaml`, body: wf.policy });
      addRef({ ...fromWf, toKind: 'policy', toId: wf.id });
    }
    // Every workflow runs under the domain layer, so a domain policy change affects all of them.
    if (project.domainPolicy) addRef({ ...fromWf, toKind: 'policy', toId: DOMAIN_POLICY_ID });

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
  }

  await store.upsert([...defs.values()], [...refs.values()]);
  return { definitions: defs.size, refs: refs.size };
}
