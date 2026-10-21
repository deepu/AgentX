/**
 * Stage 3 checks (26 §3): apps, projects and entity scopes. The loader reports what it can see
 * while resolving a project (project-unknown-app, project-unknown-version, override-unknown-file,
 * override-not-allowed, without-unknown); these need the whole workspace. Codes are stable.
 */
import { domainOf, keyOf, resolveEntity } from './domains.ts';
import { lineOf } from './source.ts';
import { TREATMENTS, type Diagnostic, type EntityTypeDef, type ProjectDefs, type ValueType } from './types.ts';

/** Entity types a field's type points at (Refs, also inside lists). */
function refTargets(type: ValueType): string[] {
  if (type.kind === 'list') return refTargets(type.of);
  return type.kind === 'ref' ? [type.entity] : [];
}

const isAppScoped = (def: EntityTypeDef) => def.scope === 'app';

export function checkProjects(project: ProjectDefs, roles: string[] | undefined): Diagnostic[] {
  const out: Diagnostic[] = [];
  const add = (severity: Diagnostic['severity'], code: string, message: string, file: string | undefined, def: object, path: (string | number)[]) =>
    out.push({ severity, code, message, ...(file ? { file } : {}), line: lineOf(def, path), ...(path.length ? { path: path.join('.') } : {}) });

  // app-scope-ref: records shared by every project can't point at one project's records.
  for (const def of Object.values(project.entities)) {
    if (!isAppScoped(def)) continue;
    const domain = domainOf(def);
    const target = (name: string) => resolveEntity(project.entities, domain, name);
    const refuse = (name: string, path: (string | number)[]) => {
      const t = target(name);
      if (t && !isAppScoped(t)) {
        add('error', 'app-scope-ref', `${def.entity} is shared by every project of the app (scope: app), so it can't refer to ${keyOf(t)}, which belongs to one project; make ${t.entity} scope: app, or point from ${t.entity} to ${def.entity} instead`, def.file, def, path);
      }
    };
    for (const [name, field] of Object.entries(def.fields)) for (const t of refTargets(field.type)) refuse(t, ['fields', name]);
    for (const [name, rel] of Object.entries(def.relationships)) if (rel.cardinality === 'one') refuse(rel.target, ['relationships', name]);
  }

  const projects = Object.values(project.projects ?? {});
  const roleSet = roles ? new Set(roles) : undefined;
  const studies = new Map<string, string>();
  for (const p of projects) {
    if (p.implicit) continue;
    const app = project.apps?.[p.app];
    if (p.template && app && !app.templates.some((t) => t.id === p.template)) {
      add('warning', 'unknown-template', `template: ${app.title} has no template card \`${p.template}\` (cards: ${app.templates.map((t) => t.id).join(', ') || 'none'})`, p.file, p, ['template']);
    }
    if (p.from && 'project' in p.from && !project.projects?.[p.from.project]) {
      add('warning', 'project-unknown-source', `copied_from: there is no project \`${p.from.project}\``, p.file, p, ['copied_from']);
    }
    if (p.study) {
      const key = `${p.app}\0${p.study}`;
      const seen = studies.get(key);
      if (seen) add('error', 'duplicate-study', `the study ${p.study} already has a project in ${app?.title ?? p.app}: ${seen}`, p.file, p, ['study']);
      else studies.set(key, p.id);
    }
    p.people.forEach((person, i) => {
      person.roles.forEach((role, j) => {
        if (roleSet && !roleSet.has(role)) add('error', 'unknown-role', `people: \`${role}\` is not a role (roles: ${[...roleSet].join(', ') || 'none'})`, p.file, p, ['people', i, 'roles', j]);
      });
      if (!/^[^@\s]+@[^@\s]+$/.test(person.email)) add('error', 'invalid-email', `people: \`${person.email}\` is not an email address`, p.file, p, ['people', i, 'email']);
    });
    for (const c of p.connections) {
      if (c.plugin && project.plugins && !project.plugins[c.plugin]) {
        add('warning', 'unknown-plugin', `connections.${c.id}: the plugin \`${c.plugin}\` is not installed`, p.file, p, ['connections', c.id, 'plugin']);
      }
    }
    // A project's own policy.yaml replaces the app's layer; it may tighten it, never loosen it.
    const appPolicy = project.domains?.[p.app]?.policy;
    if (p.policy && appPolicy && p.overrides.some((o) => /^policy\.ya?ml$/.test(o))) {
      for (const [effect, treatment] of Object.entries(appPolicy.effects ?? {})) {
        const mine = p.policy.effects?.[effect as keyof typeof p.policy.effects];
        if (mine && TREATMENTS.indexOf(mine) >= TREATMENTS.indexOf(treatment)) continue;
        add('error', 'project-policy-loosened', mine
          ? `effects.${effect}: the app says ${treatment}; a project may only tighten it (${mine} is looser)`
          : `effects.${effect}: the app says ${treatment}, and this policy.yaml replaces the app's whole file without it; keep it (or tighten it)`,
        p.policy.file, p.policy, mine ? ['effects', effect] : []);
      }
    }
  }
  return out;
}
