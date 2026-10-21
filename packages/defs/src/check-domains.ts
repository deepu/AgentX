/**
 * Phase 6 checks (24 §2-§11): domains, entity types (relationships, calculated fields, links,
 * lifecycles, page layouts), views and dashboards, and in workflows what starts them, their
 * block states, signatures and review screens. Called from `checkProject` and `checkWorkflow`.
 *
 * Codes are stable; tools and editors key on them.
 */
import { checkCondition, entityConditionScope, toName, type ConditionCheckOptions, type ConditionScope } from './condition-check.ts';
import { BLOCK_EVENTS, DEFAULT_DOMAIN, type BlockDef, type ChartBlockDef, type DashboardValue, type DomainDef, type HandoffArg, type ViewDef } from './domain-types.ts';
import { domainOf, resolveEntity, scopedEntities, splitEntityKey } from './domains.ts';
import { shapeFileOf } from './load.ts';
import { lineOf, type PathKey } from './source.ts';
import { END_STATE, type Diagnostic, type EntityTypeDef, type ProjectDefs, type Severity, type StepDef, type ValueType, type WorkflowDef } from './types.ts';
import { sameValueType } from './value-types.ts';

type Add = (severity: Severity, code: string, message: string, file: string, def: object, path: PathKey[]) => void;

function collector(): { list: Diagnostic[]; add: Add } {
  const list: Diagnostic[] = [];
  return {
    list,
    add: (severity, code, message, file, def, path) =>
      list.push({ severity, code, message, file, line: lineOf(def, path), ...(path.length ? { path: path.join('.') } : {}) }),
  };
}

/** Reports a condition's problems at `path`, with the character position in the message. */
function conditionAt(add: Add, src: string, scope: ConditionScope, file: string, def: object, path: PathKey[], opts?: ConditionCheckOptions): void {
  for (const p of checkCondition(src, scope, opts).problems) {
    add(p.severity, p.code, `\`${src}\`, at character ${p.pos + 1}: ${p.message}`, file, def, path);
  }
}

// ---------------------------------------------------------------- helpers other packages use too

/**
 * The field of `rel`'s target that points back at `def` (the inverse of a `many`, 24 §4): `via`
 * when given, else the target's one `one` relationship or `Ref` field to `def`. `candidates` are
 * every such field, for the message when there is none or several.
 */
export function relationshipInverse(
  def: EntityTypeDef, rel: { cardinality: 'one' | 'many'; target: string; via?: string }, entities: Record<string, EntityTypeDef>,
): { field?: string; candidates: string[]; target?: EntityTypeDef } {
  const target = resolveEntity(entities, domainOf(def), rel.target);
  if (!target) return { candidates: [] };
  const back = (name: string) => resolveEntity(entities, domainOf(target), name) === def;
  const candidates = [
    ...Object.entries(target.relationships).filter(([, r]) => r.cardinality === 'one' && back(r.target)).map(([n]) => n),
    ...Object.entries(target.fields).filter(([, f]) => f.type.kind === 'ref' && back(f.type.entity)).map(([n]) => n),
  ];
  if (rel.via) return { field: candidates.includes(rel.via) ? rel.via : undefined, candidates, target };
  return { field: candidates.length === 1 ? candidates[0] : undefined, candidates, target };
}

/**
 * Case fields a trigger or another workflow may set when starting a case (24 §7, §8): those no
 * agent or system step writes. (`startFields` in the runtime is narrower: what a person types
 * in when starting one by hand, never a Ref.)
 */
export function handoffFields(workflow: WorkflowDef): string[] {
  const machine = new Set<string>();
  for (const step of Object.values(workflow.steps)) {
    if (step.performer === 'agent' || step.performer === 'system') for (const f of Object.keys(step.writes)) machine.add(f);
  }
  return Object.keys(workflow.caseType.fields).filter((f) => !machine.has(f));
}

/** The outcomes a called workflow can end with (24 §8): the events that move it into `end`, plus `failed`. */
export function callOutcomes(workflow: WorkflowDef): string[] {
  const out = new Set<string>();
  for (const state of Object.values(workflow.states)) {
    for (const [event, target] of Object.entries(state.on)) if (target === END_STATE) out.add(event);
  }
  out.add('failed');
  return [...out];
}

/** The events a block state can send. */
export function blockEvents(block: BlockDef, target?: WorkflowDef): string[] {
  if (block.kind === 'call') return target ? callOutcomes(target) : [...BLOCK_EVENTS.call];
  if (block.kind === 'for_each') return block.mode === 'start' ? ['started'] : ['done', 'failed'];
  return [...BLOCK_EVENTS[block.kind]];
}

const isDateType = (t: ValueType) => t.kind === 'scalar' && (t.name === 'Date' || t.name === 'DateTime');
const isDocumentField = (t: ValueType) => t.kind === 'scalar' && (t.name === 'Document' || t.name === 'File' || t.name === 'Image');
const isTextField = (t: ValueType) => t.kind === 'scalar' && t.name === 'Text';
const isNumberField = (t: ValueType) => t.kind === 'scalar' && (t.name === 'Number' || t.name === 'Percentage');
/** Types a key field may have (25 §3): stored as text or a number. */
const isKeyType = (t: ValueType) => t.kind === 'ref' || t.kind === 'identifier' || t.kind === 'enum'
  || (t.kind === 'scalar' && ['Text', 'Number', 'Email', 'Phone', 'Date'].includes(t.name));

/** `{site_number} · {name}` → the names in braces. */
const templateNames = (title: string) => [...title.matchAll(/\{\s*([A-Za-z_][\w.]*)\s*\}/g)].map((m) => m[1]!);

// ---------------------------------------------------------------- the project: domains, entities, views, pages

/** `home:`: its entity is in the domain and has a lifecycle (a draft is its first state); its fields are Text. */
function checkHome(add: ReturnType<typeof collector>['add'], project: ProjectDefs, domain: DomainDef, file: string): void {
  const home = domain.home!;
  const def = resolveEntity(project.entities, domain.id, home.entity);
  if (!def) {
    add('error', 'unknown-entity', `home.entity: there is no entity \`${home.entity}\` in the ${domain.name} domain`, file, domain, ['home', 'entity']);
    return;
  }
  if (!def.lifecycleChart) add('error', 'home-needs-lifecycle', `home.entity: ${def.entity} needs a lifecycle, so a question can make a draft of it`, file, domain, ['home', 'entity']);
  for (const key of ['question', 'name'] as const) {
    const field = home[key];
    if (field === undefined) continue;
    const f = def.fields[field];
    if (!f) add('error', 'unknown-field', `home.${key}: ${def.entity} has no field \`${field}\``, file, domain, ['home', key]);
    else if (!(f.type.kind === 'scalar' && f.type.name === 'Text')) add('error', 'home-field-not-text', `home.${key}: \`${field}\` must be a Text field`, file, domain, ['home', key]);
  }
}

export function checkDomains(project: ProjectDefs, roles: string[] | undefined): Diagnostic[] {
  const { list, add } = collector();
  const domains = project.domains ?? {};
  const roleSet = roles ? new Set(roles) : undefined;
  const roleList = () => [...(roleSet ?? [])].join(', ') || 'none';

  const intake = new Map<string, string>();
  for (const domain of Object.values(domains)) {
    const file = domain.file ?? `${domain.dir}/domain.yaml`;
    if (roleSet && domain.owner !== undefined && !roleSet.has(domain.owner)) {
      add('error', 'unknown-role', `the owner \`${domain.owner}\` is not a role (roles: ${roleList()})`, file, domain, ['owner']);
    }
    domain.acceptsFrom?.forEach((other, i) => {
      if (!domains[other]) add('error', 'unknown-domain', `accepts_from: there is no domain \`${other}\``, file, domain, ['accepts_from', i]);
    });
    if (domain.intake) {
      const seen = intake.get(domain.intake.address);
      if (seen) add('error', 'duplicate-intake-address', `the intake address \`${domain.intake.address}\` is also the ${seen} domain's`, file, domain, ['intake', 'address']);
      else intake.set(domain.intake.address, domain.id);
    }
    if (domain.home) checkHome(add, project, domain, file);
    if (domain.id !== DEFAULT_DOMAIN && domain.policy?.approvals?.by && roleSet) {
      const policy = domain.policy;
      policy.approvals!.by!.forEach((role, i) => {
        if (!roleSet.has(role)) add('error', 'unknown-role', `approvals.by: \`${role}\` is not a role`, policy.file ?? `${domain.dir}/policy.yaml`, policy, ['approvals', 'by', i]);
      });
    }
    for (const view of Object.values(domain.views)) checkView(add, project, domain, view, view, view.file ?? domain.dir, []);
    checkPages(add, project, domain);
  }
  if (project.workspace?.policy?.approvals?.by && roleSet) {
    const policy = project.workspace.policy;
    policy.approvals!.by!.forEach((role, i) => {
      if (!roleSet.has(role)) add('error', 'unknown-role', `approvals.by: \`${role}\` is not a role`, 'workspace.yaml', project.workspace!, ['policy', 'approvals', 'by', i]);
    });
  }

  for (const def of Object.values(project.entities)) checkEntity(add, project, def, roleSet);
  return list;
}

function checkEntity(add: Add, project: ProjectDefs, def: EntityTypeDef, roles: Set<string> | undefined): void {
  const domainId = domainOf(def);
  const entities = scopedEntities(project.entities, domainId);
  const domain = project.domains?.[domainId];
  const at = (severity: Severity, code: string, message: string, path: PathKey[]) => add(severity, code, message, def.file, def, path);
  const scope = entityConditionScope(def, entities);
  const own = new Set([...Object.keys(def.fields), ...Object.keys(def.relationships)]);

  // ---- relationships and their inverses
  for (const [name, rel] of Object.entries(def.relationships)) {
    const inv = relationshipInverse(def, rel, entities);
    if (!inv.target) { at('error', 'unknown-entity', `${name}: there is no entity type ${rel.target}`, ['relationships', name]); continue; }
    if (rel.cardinality !== 'many') continue;
    if (rel.via && !inv.field) {
      at('error', 'unknown-field', `${name}: \`via: ${rel.via}\` is not a one relationship or Ref<${def.entity}> field of ${rel.target}${inv.candidates.length ? ` (it has ${inv.candidates.join(', ')})` : ''}`, ['relationships', name, 'via']);
    } else if (!inv.field) {
      at('error', 'ambiguous-inverse', inv.candidates.length
        ? `${name}: ${rel.target} points back at ${def.entity} through ${inv.candidates.join(' and ')}; say which with \`{ many: ${rel.target}, via: <field> }\``
        : `${name}: ${rel.target} has no one relationship or Ref<${def.entity}> field pointing back; add one, or name it with \`via\``, ['relationships', name]);
    }
  }

  // ---- title and parent
  if (def.title) {
    for (const n of templateNames(def.title)) {
      if (!scope[n]) at('error', 'unknown-field', `title: \`{${n}}\` is not a field of ${def.entity}`, ['title']);
    }
  }
  if (def.parent !== undefined) {
    const rel = def.relationships[def.parent];
    const field = def.fields[def.parent];
    if (!(rel?.cardinality === 'one' || field?.type.kind === 'ref')) {
      at('error', 'unknown-field', `parent: \`${def.parent}\` is not a one relationship or Ref field of ${def.entity}`, ['parent']);
    }
  }

  // ---- Literature (25 §3, §4): the key, and fields quoting another record's text
  def.key?.forEach((name, i) => {
    const f = def.fields[name];
    if (!f) at('error', 'key-unknown-field', `key: \`${name}\` is not a field of ${def.entity}`, ['key', i]);
    else if (!isKeyType(f.type)) at('error', 'key-unknown-field', `key: \`${name}\` is ${f.typeSource}; a key is a Text, Number or Ref field`, ['key', i]);
    else if (!f.required) at('error', 'key-field-not-required', `key: \`${name}\` identifies a ${def.entity}, so every one has it: add \`required: true\``, ['key', i]);
    else if (f.access?.length) at('error', 'key-field-restricted', `key: \`${name}\` has \`access:\`, but a key finds the ${def.entity} for anyone who creates or reads one by it: drop \`access:\` from ${name} or key on another field`, ['key', i]);
  });
  // The records table's default columns: its own fields, calculated ones, or its status.
  def.list?.forEach((name, i) => {
    if (def.fields[name] || def.calculated?.[name] || name === 'status') return;
    at('error', 'list-unknown-field', `list: \`${name}\` is not a field of ${def.entity}`, ['list', i]);
  });
  for (const [name, f] of Object.entries(def.fields)) {
    if (!f.quoteOf) continue;
    const path: PathKey[] = ['fields', name, 'quote_of'];
    const written = `${f.quoteOf.ref}.${f.quoteOf.field}`;
    if (!isTextField(f.type)) at('error', 'quote-of-not-text', `${name}: only a Text field quotes another record's text (this one is ${f.typeSource})`, path);
    const refField = def.fields[f.quoteOf.ref];
    const rel = def.relationships[f.quoteOf.ref];
    const targetName = refField?.type.kind === 'ref' ? refField.type.entity : rel?.cardinality === 'one' ? rel.target : undefined;
    if (!targetName) { at('error', 'quote-of-unknown-field', `${name}: \`quote_of: ${written}\`: \`${f.quoteOf.ref}\` is not a Ref field of ${def.entity}`, path); continue; }
    const target = resolveEntity(entities, domainId, targetName);
    if (!target) continue; // reported with the field or relationship
    const text = target.fields[f.quoteOf.field];
    if (!text || !isTextField(text.type)) {
      at('error', 'quote-of-unknown-field', `${name}: \`quote_of: ${written}\`: \`${f.quoteOf.field}\` is not a Text field of ${target.entity}`, path);
    }
  }

  // ---- calculated fields
  for (const [name, c] of Object.entries(def.calculated ?? {})) {
    const path: PathKey[] = ['calculated', name];
    if (own.has(name)) at('error', 'duplicate-field', `\`${name}\` is both a field and a calculated field of ${def.entity}`, path);
    if (c.kind === 'formula') { conditionAt(add, c.formula, scope, def.file, def, [...path, 'formula'], { expect: 'any' }); continue; }
    const rel = def.relationships[c.of];
    if (!rel || rel.cardinality !== 'many') {
      at('error', 'unknown-field', `${name}: \`${c.of}\` is not a many relationship of ${def.entity}`, [...path, c.rollup]);
      continue;
    }
    const target = resolveEntity(entities, domainId, rel.target);
    if (!target) continue; // reported with the relationship
    const targetScope = entityConditionScope(target, project.entities);
    if (c.field !== undefined && !targetScope[c.field]) at('error', 'unknown-field', `${name}: \`${c.field}\` is not a field of ${rel.target}`, [...path, 'field']);
    if (c.where) conditionAt(add, c.where, targetScope, def.file, def, [...path, 'where']);
  }

  // ---- links to other domains
  for (const [key, link] of Object.entries(def.links ?? {})) {
    const path: PathKey[] = ['links', key];
    const { domain: other } = splitEntityKey(key);
    const target = project.entities[key];
    if (!target || other === domainId || !key.includes('.') || !project.domains?.[other]) {
      at('error', 'unknown-link', other === domainId && key.includes('.')
        ? `${key}: a link goes to the same thing in another domain, not this one`
        : `${key}: there is no entity type ${key} (name another domain's entity by its key, e.g. edc.Site)`, path);
      continue;
    }
    for (const [mine, theirs] of Object.entries(link.match)) {
      if (!def.fields[mine]) at('error', 'unknown-field', `${key} match: \`${mine}\` is not a field of ${def.entity}`, [...path, 'match']);
      if (!target.fields[theirs]) at('error', 'unknown-field', `${key} match: \`${theirs}\` is not a field of ${key}`, [...path, 'match']);
    }
    if (!Object.keys(link.match).length) at('error', 'unknown-field', `${key}: say which fields pair the records, e.g. \`match: [site_number]\``, path);
    link.follow.forEach((f, i) => {
      if (!target.fields[f]) at('error', 'unknown-field', `${key} follow: \`${f}\` is not a field of ${key}`, [...path, 'follow', i]);
      if (own.has(f) || def.calculated?.[f]) at('error', 'followed-field-clash', `${key} follow: \`${f}\` is also a field of ${def.entity}; a followed field is read from ${key} only`, [...path, 'follow', i]);
    });
  }

  // ---- the lifecycle
  const chart = def.lifecycleChart;
  if (chart && !chart.fromList) {
    const states = chart.states;
    if (!states[chart.initial]) at('error', 'lifecycle-unknown-state', `initial: \`${chart.initial}\` is not one of the states (${Object.keys(states).join(', ')})`, ['lifecycle', 'initial']);
    const used = new Set<string>();
    for (const [name, s] of Object.entries(states)) {
      for (const [t, target] of Object.entries(s.on)) {
        used.add(t);
        if (!states[target]) at('error', 'lifecycle-unknown-state', `\`${name}\` moves to \`${target}\` on ${t}, but there is no such state`, ['lifecycle', 'states', name, 'on', t]);
      }
      for (const timer of s.after ?? []) {
        if (timer.remind && roles && !roles.has(timer.remind)) at('error', 'unknown-role', `\`${name}\`: remind \`${timer.remind}\` is not a role`, ['lifecycle', 'states', name, 'after']);
        if (timer.transition && !(timer.transition in s.on)) {
          at('error', 'lifecycle-unknown-transition', `\`${name}\`: the timer makes \`${timer.transition}\`, which is not a transition out of \`${name}\` (${Object.keys(s.on).join(', ') || 'none'})`, ['lifecycle', 'states', name, 'after']);
        } else if (timer.transition && chart.transitions[timer.transition] && !chart.transitions[timer.transition]!.by.some((b) => b.kind === 'system')) {
          // A timer moves the record as the system, which only a transition with `system` in its `by` allows.
          at('error', 'timer-not-allowed', `\`${name}\`: the timer makes \`${timer.transition}\`, which the system may not make; add \`system\` to its \`by\``, ['lifecycle', 'states', name, 'after']);
        }
      }
    }
    for (const [name, t] of Object.entries(chart.transitions)) {
      const path: PathKey[] = ['lifecycle', 'transitions', name];
      if (!used.has(name)) at('warning', 'unused-transition', `the transition \`${name}\` is declared but no state moves on it`, path);
      t.by.forEach((actor, i) => {
        if (actor.kind === 'role' && roles && !roles.has(actor.role)) at('error', 'unknown-role', `${name}: \`role:${actor.role}\` is not a role`, [...path, 'by', i]);
        if (actor.kind === 'source' && actor.source.startsWith('domain:') && !project.domains?.[actor.source.slice('domain:'.length)]) {
          at('error', 'unknown-domain', `${name}: \`source:${actor.source}\`: there is no domain ${actor.source.slice('domain:'.length)}`, [...path, 'by', i]);
        }
      });
      if (t.guard) conditionAt(add, t.guard, scope, def.file, def, [...path, 'guard']);
      if (t.signed && !domain?.regulated) at('warning', 'signed-not-regulated', `${name} needs a signature, but the ${domain?.name ?? domainId} domain is not regulated, so nothing signs`, [...path, 'signed']);
    }
    if (states[chart.initial]) {
      const seen = new Set([chart.initial]);
      const queue = [chart.initial];
      while (queue.length) for (const t of Object.values(states[queue.shift()!]!.on)) if (states[t] && !seen.has(t)) { seen.add(t); queue.push(t); }
      for (const name of Object.keys(states)) {
        if (!seen.has(name)) at('warning', 'unreachable-lifecycle-state', `no transition leads from \`${chart.initial}\` to \`${name}\``, ['lifecycle', 'states', name]);
      }
    }
  }
  def.invariants?.forEach((inv, i) => conditionAt(add, inv, scope, def.file, def, ['invariants', i]));

  // ---- the record page
  if (def.page && !def.page.isDefault) {
    const known = (n: string) => n === 'title' || !!scope[n];
    def.page.header.forEach((n, i) => {
      if (!known(n)) at('error', 'unknown-field', `page header: \`${n}\` is not a field of ${def.entity}`, ['page', 'header', i]);
    });
    for (const [area, blocks] of Object.entries(def.page.areas)) {
      // Lines: blocks the parser dropped shift indexes, so point at the area.
      for (const b of blocks ?? []) {
        const path: PathKey[] = ['page', area];
        if (b.kind === 'fields') {
          for (const n of b.fields) if (!known(n)) at('error', 'unknown-field', `page ${area}: \`${n}\` is not a field of ${def.entity}`, path);
        } else if (b.kind === 'kpis') {
          for (const n of b.fields) {
            const f = def.fields[n];
            if (!def.calculated?.[n] && !(f && isNumberField(f.type))) at('error', 'unknown-field', `page ${area}: kpis \`${n}\` is not a calculated or Number field of ${def.entity}`, path);
          }
        } else if (b.kind === 'viewer') {
          const f = def.fields[b.field];
          if (!f || !(isDocumentField(f.type) || isTextField(f.type))) at('error', 'unknown-field', `page ${area}: viewer \`${b.field}\` is not a Document, File, Image or Text field of ${def.entity}`, path);
        } else if (b.kind === 'related') {
          for (const n of b.relationships) {
            if (def.relationships[n]?.cardinality !== 'many' && !['versions', 'signatures'].includes(n)) {
              at('error', 'unknown-field', `page ${area}: related \`${n}\` is not a many relationship of ${def.entity}`, path);
            }
          }
        } else if (b.kind === 'chart') {
          const rel = def.relationships[b.of];
          if (!rel && !def.calculated?.[b.of]) at('error', 'unknown-field', `page ${area}: chart of \`${b.of}\` is not a relationship or calculated field of ${def.entity}`, path);
          const target = rel ? resolveEntity(entities, domainId, rel.target) : def;
          if (target) checkChartFields(add, def.file, def, path, b, target, entityConditionScope(target, project.entities), `page ${area}: chart`);
          if (b.chart === 'interval' && rel?.cardinality !== 'many') at('error', 'unknown-field', `page ${area}: an interval chart draws the rows of a many relationship; \`${b.of}\` is not one`, path);
        }
      }
    }
  }
}

/**
 * A chart's fields on the entity whose rows it draws (25 §5): `by`, `where`, and for an
 * interval `value`, `low`, `high` (numbers), `unit` and the names in the `label` template.
 */
function checkChartFields(
  add: Add, file: string, def: object, path: PathKey[], c: Pick<ChartBlockDef, 'chart' | 'by' | 'where' | 'label' | 'value' | 'low' | 'high' | 'unit'>,
  target: EntityTypeDef, scope: ConditionScope, what: string, params?: ConditionScope,
): void {
  const unknown = (key: string, n: string) => add('error', 'unknown-field', `${what} ${key} \`${n}\` is not a field of ${target.entity}`, file, def, path);
  if (c.by !== undefined && !scope[c.by]) unknown('by', c.by);
  if (c.where) conditionAt(add, c.where, scope, file, def, path, { params });
  if (c.chart !== 'interval') return;
  for (const key of ['value', 'low', 'high'] as const) {
    const n = c[key];
    if (n === undefined) continue;
    const kind = scope[n];
    if (!kind) unknown(key, n);
    else if (toName(kind).kind !== 'number' && toName(kind).kind !== 'any') add('error', 'unknown-field', `${what} ${key} \`${n}\` is not a number field of ${target.entity}`, file, def, path);
  }
  if (c.unit !== undefined && !scope[c.unit]) unknown('unit', c.unit);
  for (const n of templateNames(c.label ?? '')) if (!scope[n]) unknown('label', `{${n}}`);
}

function checkView(
  add: Add, project: ProjectDefs, domain: DomainDef, view: Omit<ViewDef, 'id' | 'title'>, def: object, file: string, base: PathKey[],
  params?: ConditionScope,
): void {
  const entities = scopedEntities(project.entities, domain.id);
  const entity = resolveEntity(entities, domain.id, view.entity);
  if (!entity) { add('error', 'unknown-entity', `there is no entity type ${view.entity} in ${domain.name}`, file, def, [...base, 'entity']); return; }
  const scope = entityConditionScope(entity, project.entities);
  if (view.filter) conditionAt(add, view.filter, scope, file, def, [...base, 'filter'], { params });
  const field = (n: string, path: PathKey[]) => {
    if (!scope[n]) add('error', 'unknown-field', `\`${n}\` is not a field of ${view.entity}`, file, def, path);
  };
  view.sort?.forEach((s, i) => field(s.field, [...base, 'sort', i]));
  if (view.group) field(view.group, [...base, 'group']);
  view.columns?.forEach((c, i) => { if (c !== 'title') field(c, [...base, 'columns', i]); });
}

function checkPages(add: Add, project: ProjectDefs, domain: DomainDef): void {
  const entities = scopedEntities(project.entities, domain.id);
  for (const page of Object.values(domain.pages)) {
    const file = page.file ?? domain.dir;
    const at = (code: string, message: string, path: PathKey[]) => add('error', code, message, file, page, path);
    if (page.under && !resolveEntity(entities, domain.id, page.under.entity)) at('unknown-entity', `under: there is no entity type ${page.under.entity}`, ['under']);
    const params: ConditionScope = {};
    for (const [name, src] of Object.entries(page.params)) {
      const m = /^Ref\s*<\s*([\w.]+)\s*>$/.exec(src);
      if (m && !resolveEntity(entities, domain.id, m[1]!)) at('unknown-entity', `params.${name}: there is no entity type ${m[1]}`, ['params', name]);
      params[name] = m ? 'text' : 'any';
    }
    page.blocks.forEach((b, i) => {
      const path: PathKey[] = ['blocks', i, b.kind];
      switch (b.kind) {
        case 'kpi': {
          const v: DashboardValue = b.value;
          const name = 'count' in v ? v.count : 'percent' in v ? v.percent : 'sum' in v ? v.sum : v.avg;
          const entity = resolveEntity(entities, domain.id, name);
          if (!entity) { at('unknown-entity', `${b.label}: there is no entity type ${name}`, [...path, 'value']); return; }
          const scope = entityConditionScope(entity, project.entities);
          if (v.where) conditionAt(add, v.where, scope, file, page, [...path, 'value', 'where'], { params });
          if ('of' in v && v.of) conditionAt(add, v.of, scope, file, page, [...path, 'value', 'of'], { params });
          if ('field' in v && !scope[v.field]) at('unknown-field', `${b.label}: \`${v.field}\` is not a field of ${name}`, [...path, 'value', 'field']);
          return;
        }
        case 'table':
        case 'list':
          if (typeof b.view === 'string') {
            if (!domain.views[b.view]) at('unknown-view', `there is no view \`${b.view}\` in ${domain.dir}/views/`, [...path, 'view']);
          } else checkView(add, project, domain, b.view, page, file, [...path, 'view'], params);
          return;
        case 'chart': {
          const entity = resolveEntity(entities, domain.id, b.entity);
          if (!entity) { at('unknown-entity', `chart: there is no entity type ${b.entity}`, [...path, 'entity']); return; }
          checkChartFields(add, file, page, path, b, entity, entityConditionScope(entity, project.entities), 'chart', params);
          return;
        }
        case 'heatmap': {
          const entity = resolveEntity(entities, domain.id, b.rows.entity);
          if (!entity) { at('unknown-entity', `rows: there is no entity type ${b.rows.entity}`, [...path, 'rows', 'entity']); return; }
          const scope = entityConditionScope(entity, project.entities);
          if (b.rows.where) conditionAt(add, b.rows.where, scope, file, page, [...path, 'rows', 'where'], { params });
          b.columns.forEach((c, j) => {
            if (!scope[c.value]) at('unknown-field', `column ${c.label}: \`${c.value}\` is not a field of ${b.rows.entity}`, [...path, 'columns', j]);
          });
          return;
        }
        default:
      }
    });
  }
}

// ---------------------------------------------------------------- workflows: triggers, blocks, signatures, review

/** The message fields a `message:` trigger can map (24 §10). */
export const MESSAGE_FIELDS = ['id', 'from', 'to', 'subject', 'text', 'receivedAt', 'attachments'] as const;
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export function checkWorkflowDomain(workflow: WorkflowDef, project: ProjectDefs | undefined, entities: Record<string, EntityTypeDef> | undefined, roles: string[] | undefined): Diagnostic[] {
  const { list, add } = collector();
  const shapeFile = shapeFileOf(workflow);
  const shape = (severity: Severity, code: string, message: string, path: PathKey[]) => add(severity, code, message, shapeFile, workflow, path);
  const domainId = domainOf(workflow);
  const domain = project?.domains?.[domainId];
  const fields = workflow.caseType.fields;
  const starts = new Set(handoffFields(workflow));
  const roleSet = roles ? new Set(roles) : undefined;

  // ---- what starts it
  (workflow.startsOn ?? []).forEach((t, i) => {
    const path: PathKey[] = ['starts_on', i];
    const entity = 'entity' in t ? (entities ? resolveEntity(entities, domainId, t.entity) : undefined) : undefined;
    if ('entity' in t && entities && !entity) shape('error', 'unknown-entity', `there is no entity type ${t.entity}`, [...path, t.kind === 'date' ? t.direction : t.kind]);
    if (entity) {
      const scope = entityConditionScope(entity, entities!);
      if (t.kind === 'entered' && !entity.lifecycle?.includes(t.state)) {
        shape('error', 'unknown-state', `${t.entity} has no state \`${t.state}\` (${entity.lifecycle?.join(', ') || 'it has no lifecycle'})`, [...path, 'entered']);
      }
      if (t.kind === 'changed') t.fields?.forEach((f) => { if (!scope[f]) shape('error', 'unknown-field', `\`${f}\` is not a field of ${t.entity}`, [...path, 'changed', 'fields']); });
      if (t.kind === 'date') {
        const f = entity.fields[t.field];
        if (!f) shape('error', 'unknown-field', `\`${t.field}\` is not a field of ${t.entity}`, [...path, t.direction, 'field']);
        else if (!isDateType(f.type)) shape('error', 'date-trigger-not-date', `\`${t.entity}.${t.field}\` is ${f.typeSource}; a date trigger needs a Date or DateTime field`, [...path, t.direction, 'field']);
      }
    }
    if (t.kind === 'message' && project && domain?.intake?.address !== t.address) {
      shape('error', 'unknown-intake-address', domain?.intake
        ? `\`${t.address}\` is not this domain's intake address (\`${domain.intake.address}\` in domain.yaml)`
        : `the ${domain?.name ?? domainId} domain has no intake address: add \`intake: { address: ${t.address} }\` to its domain.yaml`, [...path, 'message', 'address']);
    }
    if (t.kind === 'every') {
      if (t.on !== undefined && !WEEKDAYS.includes(t.on.toLowerCase()) && !/^([1-9]|[12]\d|3[01])$/.test(t.on)) {
        shape('error', 'invalid-format', `on: \`${t.on}\` is not a weekday (monday … sunday) or a day of the month (1 … 31)`, [...path, 'on']);
      }
    }
    if (t.as !== undefined && roleSet && !roleSet.has(t.as)) shape('error', 'unknown-role', `as: \`${t.as}\` is not a role`, [...path, 'as']);
    for (const [field, src] of Object.entries(t.with)) {
      const wpath: PathKey[] = [...path, 'with', field];
      const f = fields[field];
      if (!f) { shape('error', 'unknown-case-field', `with: \`${field}\` is not a field of the case`, wpath); continue; }
      if (!starts.has(field)) shape('error', 'not-a-start-field', `with: \`${field}\` is written by a step, so a trigger can't set it`, wpath);
      if (src === 'record') {
        if (t.kind === 'every' || t.kind === 'message') shape('error', 'invalid-trigger-value', `with: \`record\` names the record that fired the trigger; a ${t.kind === 'every' ? 'schedule' : 'message'} has none`, wpath);
        else if (entity && entities && !(f.type.kind === 'ref' && resolveEntity(entities, domainId, f.type.entity) === entity)) {
          shape('error', 'handoff-type-mismatch', `with: \`${field}\` is ${f.typeSource}; the record is a ${'entity' in t ? t.entity : ''}, so the field is Ref<${'entity' in t ? t.entity : ''}>`, wpath);
        }
      } else if (src.startsWith('message.')) {
        const m = src.slice('message.'.length);
        if (t.kind !== 'message') shape('error', 'invalid-trigger-value', `with: \`${src}\` reads the message, but this trigger isn't a message trigger`, wpath);
        else if (!(MESSAGE_FIELDS as readonly string[]).includes(m)) shape('error', 'unknown-message-field', `with: a message has no \`${m}\` (it has ${MESSAGE_FIELDS.join(', ')})`, wpath);
      }
    }
    if ('entity' in t && entity && !Object.values(t.with).includes('record')) {
      shape('warning', 'trigger-without-record', `the case is not told which ${t.entity} fired it: add \`with: { <Ref<${t.entity}> field>: record }\``, path);
    }
  });

  // ---- block states
  for (const [name, state] of Object.entries(workflow.states)) {
    const b = state.block;
    if (!b) continue;
    const path: PathKey[] = ['steps', name, b.kind];
    if (state.step) shape('error', 'block-with-step', `\`${name}\` has a ${b.kind} block and a step file (steps/${name}.md); a state does one or the other`, ['steps', name]);
    if (b.kind === 'wait_until') {
      const f = fields[b.record];
      const target = f?.type.kind === 'ref' && entities ? resolveEntity(entities, domainId, f.type.entity) : undefined;
      if (!f || f.type.kind !== 'ref') shape('error', 'wait-record-not-ref', `record: \`case.${b.record}\` is ${f ? f.typeSource : 'not a field of the case'}; wait_until watches a Ref<Entity> case field`, [...path, 'record']);
      else if (entities && !target) shape('error', 'unknown-entity', `record: there is no entity type ${f.type.entity}`, [...path, 'record']);
      if (target) conditionAt(add, b.condition, entityConditionScope(target, entities!), shapeFile, workflow, [...path, 'condition']);
    } else {
      checkHandoff(shape, workflow, name, b, project, entities);
    }
    const target = b.kind === 'wait_until' ? undefined : project?.workflows[b.workflow];
    const events = blockEvents(b, target);
    const known = b.kind === 'call' && !target ? undefined : new Set([...events, 'needs_person']);
    for (const event of Object.keys(state.on)) {
      if (known && !known.has(event)) shape('error', 'unknown-block-event', `\`${name}\` never sends \`${event}\`: a ${b.kind} block sends ${events.join(', ')}`, ['steps', name, 'on', event]);
    }
    const needed = b.kind === 'call' ? [] : b.kind === 'for_each' ? (b.mode === 'start' ? ['started'] : ['done']) : events;
    for (const event of needed) {
      if (!(event in state.on)) shape('error', 'block-event-without-transition', `\`${name}\` sends \`${event}\`, but the shape has no transition for it`, ['steps', name, 'on']);
    }
    if (b.kind === 'call' && target) {
      for (const event of callOutcomes(target)) {
        if (!(event in state.on)) shape('warning', 'block-event-without-transition', `${target.id} can end with \`${event}\`, but \`${name}\` has no transition for it (the case would wait for a person)`, ['steps', name, 'on']);
      }
    }
  }
  if (project) checkCallLoop(shape, workflow, project);

  // ---- signatures and review screens
  for (const step of Object.values(workflow.steps)) checkSignAndReview(add, workflow, step, entities);
  return list;
}

/** `start`, `call` and `for_each`: the target exists, may be reached from here, and gets what it needs. */
function checkHandoff(
  shape: (severity: Severity, code: string, message: string, path: PathKey[]) => void,
  workflow: WorkflowDef, state: string, b: Exclude<BlockDef, { kind: 'wait_until' }>, project: ProjectDefs | undefined, entities: Record<string, EntityTypeDef> | undefined,
): void {
  const path: PathKey[] = ['steps', state, b.kind];
  const fields = workflow.caseType.fields;
  let itemType: ValueType | undefined;
  if (b.kind === 'for_each') {
    const f = fields[b.items.split('.')[0]!];
    if (!f) shape('error', 'unknown-case-field', `items: \`case.${b.items}\` is not a field of the case`, [...path, 'items']);
    else if (f.type.kind !== 'list') shape('error', 'for-each-not-list', `items: \`case.${b.items}\` is ${f.typeSource}; for_each goes over a List case field`, [...path, 'items']);
    else itemType = f.type.of;
  }
  if (!project) return;
  const target = project.workflows[b.workflow];
  const targetPath: PathKey[] = b.kind === 'for_each' ? [...path, b.mode, 'workflow'] : [...path, 'workflow'];
  const withPath: PathKey[] = b.kind === 'for_each' ? [...path, b.mode, 'with'] : [...path, 'with'];
  if (!target) { shape('error', 'unknown-workflow', `there is no workflow \`${b.workflow}\``, targetPath); return; }
  const from = domainOf(workflow);
  const to = domainOf(target);
  if (from !== to && !project.domains?.[to]?.acceptsFrom?.includes(from)) {
    shape('error', 'cross-domain-not-allowed', `${b.workflow} is in the ${project.domains?.[to]?.name ?? to} domain, which doesn't accept work from ${project.domains?.[from]?.name ?? from}: add \`accepts_from: [${from}]\` to ${project.domains?.[to]?.dir ?? `domains/${to}`}/domain.yaml`, targetPath);
  }
  const targetFields = target.caseType.fields;
  const starts = new Set(handoffFields(target));
  const typeOfArg = (arg: HandoffArg): ValueType | undefined | null => {
    if ('case' in arg) {
      const f = fields[arg.case];
      if (!f && !arg.case.includes('.')) return null;
      return f?.type;
    }
    if ('item' in arg) {
      if (b.kind !== 'for_each') return null;
      return arg.item ? undefined : itemType;
    }
    return undefined;
  };
  for (const [field, arg] of Object.entries(b.with)) {
    const p: PathKey[] = [...withPath, field];
    const tf = targetFields[field];
    if (!tf) { shape('error', 'handoff-unknown-field', `${b.workflow} has no case field \`${field}\``, p); continue; }
    if (!starts.has(field)) shape('error', 'handoff-unknown-field', `\`${field}\` is written by a step of ${b.workflow}, so it can't be handed over`, p);
    if ('item' in arg && b.kind !== 'for_each') { shape('error', 'item-outside-for-each', `\`item\` is the element of a for_each; this is a ${b.kind} block`, p); continue; }
    if ('record' in arg) { shape('error', 'invalid-trigger-value', '`record` is the record that fired a trigger; a block passes `case.<field>` instead', p); continue; }
    const t = typeOfArg(arg);
    if (t === null) { shape('error', 'unknown-case-field', `\`case.${'case' in arg ? arg.case : ''}\` is not a field of the case`, p); continue; }
    if (t && !compatible(t, tf.type, workflow, target, entities, project)) {
      shape('error', 'handoff-type-mismatch', `\`${field}\` is ${tf.typeSource} in ${b.workflow}, but gets ${formatType(t)}`, p);
    }
  }
  for (const [field, f] of Object.entries(targetFields)) {
    if (f.required && starts.has(field) && !(field in b.with)) shape('error', 'handoff-missing-field', `${b.workflow} needs \`${field}\` (${f.typeSource}) to start: add it under \`with:\``, withPath);
  }
  if (b.kind === 'call') {
    for (const [mine, theirs] of Object.entries(b.returns)) {
      const p: PathKey[] = [...path, 'returns', mine];
      if (!fields[mine]) shape('error', 'handoff-unknown-field', `returns: \`${mine}\` is not a field of this case`, p);
      if (!targetFields[theirs]) shape('error', 'handoff-unknown-field', `returns: ${b.workflow} has no case field \`${theirs}\``, p);
      else if (fields[mine] && !compatible(targetFields[theirs]!.type, fields[mine]!.type, target, workflow, entities, project)) {
        shape('error', 'handoff-type-mismatch', `returns: \`${mine}\` is ${fields[mine]!.typeSource}, but ${b.workflow}'s \`${theirs}\` is ${targetFields[theirs]!.typeSource}`, p);
      }
    }
  }
}

const formatType = (t: ValueType): string => t.kind === 'ref' ? `Ref<${t.entity}>` : t.kind === 'list' ? `List<${formatType(t.of)}>` : t.kind === 'scalar' ? t.name : t.kind === 'named' ? t.name : t.kind;

/** Types match, with Refs compared by the entity they resolve to in each workflow's domain. */
function compatible(a: ValueType, b: ValueType, wa: WorkflowDef, wb: WorkflowDef, entities: Record<string, EntityTypeDef> | undefined, project: ProjectDefs): boolean {
  if (a.kind === 'ref' && b.kind === 'ref') {
    const ea = resolveEntity(project.entities, domainOf(wa), a.entity);
    const eb = resolveEntity(project.entities, domainOf(wb), b.entity);
    return ea && eb ? ea === eb : a.entity === b.entity;
  }
  if (a.kind === 'list' && b.kind === 'list') return compatible(a.of, b.of, wa, wb, entities, project);
  return sameValueType(a, b);
}

/** A workflow that calls itself through others never ends (24 §8). */
function checkCallLoop(shape: (severity: Severity, code: string, message: string, path: PathKey[]) => void, workflow: WorkflowDef, project: ProjectDefs): void {
  const calls = (wf: WorkflowDef) => Object.entries(wf.states).flatMap(([state, s]) =>
    s.block && (s.block.kind === 'call' || (s.block.kind === 'for_each' && s.block.mode === 'call')) ? [{ state, to: s.block.workflow }] : []);
  for (const { state, to } of calls(workflow)) {
    // Is there a path back from `to` to this workflow?
    const seen = new Set<string>();
    const queue: { id: string; path: string[] }[] = [{ id: to, path: [workflow.id, to] }];
    while (queue.length) {
      const { id, path } = queue.shift()!;
      if (id === workflow.id) {
        shape('error', 'call-loop', `calling ${to} here comes back to ${workflow.id} (${path.join(' → ')}), so the cases would wait on each other forever`, ['steps', state]);
        break;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      const wf = project.workflows[id];
      if (wf) for (const c of calls(wf)) queue.push({ id: c.to, path: [...path, c.to] });
    }
  }
}

/** `sign:` is for person steps; `review:` names case fields of the right types (24 §9, §11). */
function checkSignAndReview(add: Add, workflow: WorkflowDef, step: StepDef, entities: Record<string, EntityTypeDef> | undefined): void {
  const at = (code: string, message: string, path: PathKey[]) => add('error', code, message, step.file, step, path);
  const fields = workflow.caseType.fields;
  if (step.sign !== undefined && step.performer !== 'person') {
    at('sign-on-non-person-step', `only a person signs: \`sign:\` is for person steps, and this is ${step.performer === 'agent' ? 'an agent' : `a ${step.performer}`} step`, ['sign']);
  }
  const r = step.review;
  if (!r) return;
  if (r.kind === 'document') {
    if (!r.record) {
      // Inferred: the one Ref<Document-like entity> the step reads.
      const refs = step.reads.map((p) => p.slice('case.'.length)).filter((f) => fields[f]?.type.kind === 'ref');
      if (refs.length !== 1) at('review-record-not-ref', refs.length
        ? `review: the step reads several records (${refs.join(', ')}); say which with \`review: { kind: document, record: case.<field> }\``
        : 'review: say which record is reviewed, `review: { kind: document, record: case.<field> }`, or read it in `reads`', ['review']);
      return;
    }
    const f = fields[r.record];
    if (!f || f.type.kind !== 'ref') {
      at('review-record-not-ref', `review: \`case.${r.record}\` is ${f ? f.typeSource : 'not a field of the case'}; a document review opens a record, so it names a Ref case field`, ['review', 'record']);
    } else if (entities && !resolveEntity(entities, domainOf(workflow), f.type.entity)) {
      at('unknown-entity', `review: there is no entity type ${f.type.entity}`, ['review', 'record']);
    }
  } else if (r.kind === 'table') {
    const f = fields[r.items];
    if (!f || f.type.kind !== 'list') at('review-items-not-list', `review: \`case.${r.items}\` is ${f ? f.typeSource : 'not a field of the case'}; a table review shows a List case field`, ['review', 'items']);
  }
}
