/**
 * The checks a workflow must pass before it can go live (05 §8), apart from policy
 * tightening (`@memwise/policy`) and running the example cases (`memwise test`).
 *
 * Codes are stable; tools and editors key on them.
 */
import { boundPluginTools, checkBindings } from './binding-checks.ts';
import { checkDomains, checkWorkflowDomain } from './check-domains.ts';
import { domainOf, scopedEntities } from './domains.ts';
import { entityTools } from './entity-tools.ts';
import { shapeFileOf } from './load.ts';
import { lineOf, type PathKey } from './source.ts';
import { END_STATE, type CheckEnvironment, type Diagnostic, type EntityTypeDef, type FieldDef, type ProjectDefs, type Severity, type StepDef, type ValueType, type WorkflowDef } from './types.ts';
import { sameValueType } from './value-types.ts';
import { validateValue, type RecordTypes } from './values.ts';

/** Outcomes every step may take without declaring them; the run stops for a person when the shape has no transition. */
export const BUILTIN_OUTCOMES = ['needs_person', 'failed'] as const;
/** Tools the step engine provides itself; example cases script calls to them. */
export const ENGINE_TOOLS = ['step.finish', 'checkpoint.verdict', 'explain.answer'] as const;

export interface CheckOptions {
  /**
   * Entity types as the workflow's domain names them (`scopedEntities`). Without them, `Ref<>`
   * targets and entity-named types aren't checked.
   */
  entities?: Record<string, EntityTypeDef>;
  /** Phase 6: the whole project, for checks across workflows and domains (triggers, hand-offs, call loops). */
  project?: ProjectDefs;
}

/** The outcome a system step finishes with: its only declared one, `done` when it declares none. */
export const systemOutcome = (step: StepDef): string => step.outcomes[0] ?? 'done';

/** Effective outcomes of a step, for the transition checks. */
const outcomesOf = (step: StepDef) => (step.performer === 'system' && !step.outcomes.length && !step.outcomeFrom ? ['done'] : step.outcomes);

/**
 * A conversation step (Phase 3): an agent step on the open engine, i.e. a chat with a person.
 * The run waits on it like a person step, so it gets the person-step rules (assignee, timeout).
 */
export const isConversationStep = (step: StepDef): boolean => step.performer === 'agent' && step.engine === 'open';

/** Steps the run waits on: a person, someone outside the business, or a chat. */
const waitsOnSomeone = (step: StepDef) => step.performer === 'person' || step.performer === 'external' || isConversationStep(step);

class Diagnostics {
  readonly list: Diagnostic[] = [];
  /** `def` is the parsed object the path belongs to, for its line (when it was loaded in this process). */
  add(severity: Severity, code: string, message: string, file: string, def: object, path: PathKey[]): void {
    this.list.push({ severity, code, message, file, line: lineOf(def, path), ...(path.length ? { path: path.join('.') } : {}) });
  }
}

/** Walks a type down to the named and referenced types inside it. */
function typeNames(type: ValueType): ValueType[] {
  return type.kind === 'list' ? typeNames(type.of) : type.kind === 'named' || type.kind === 'ref' ? [type] : [];
}

/** Checks that record and entity types named in `type` exist. */
function checkTypeRefs(
  type: ValueType, records: Record<string, unknown>, entities: Record<string, EntityTypeDef> | undefined,
  report: (code: string, message: string) => void,
): void {
  for (const t of typeNames(type)) {
    if (t.kind === 'ref') {
      if (entities && !entities[t.entity]) report('unknown-entity', `\`Ref<${t.entity}>\`: there is no entity type ${t.entity}`);
    } else if (t.kind === 'named' && !records[t.name] && entities && !entities[t.name]) {
      // Without the project's entities the name might still be an entity type, so only say so when we know.
      report('unknown-type', `\`${t.name}\` is not a record type in the case file or an entity type`);
    }
  }
}

export function checkWorkflow(workflow: WorkflowDef, env: CheckEnvironment, opts: CheckOptions = {}): Diagnostic[] {
  const d = new Diagnostics();
  const shapeFile = shapeFileOf(workflow);
  const shape = (severity: Severity, code: string, message: string, path: PathKey[]) => d.add(severity, code, message, shapeFile, workflow, path);
  const { states, caseType } = workflow;
  const entities = opts.entities;
  const exists = (target: string) => target === END_STATE || target in states;
  const roles = env.roles ? new Set(env.roles) : undefined;
  const roleList = () => [...(roles ?? [])].join(', ') || 'none';

  // ---- the shape: start, targets, reachability, exits, waits
  if (!states[workflow.start]) shape('error', 'unknown-start', `the start state \`${workflow.start}\` is not one of the steps`, ['start']);
  if (roles && workflow.owner !== undefined && !roles.has(workflow.owner)) {
    shape('error', 'unknown-role', `the owner \`${workflow.owner}\` is not a role in domain/roles.yaml (roles: ${roleList()})`, ['owner']);
  }
  if (roles && workflow.policy?.approvals?.by) {
    const policy = workflow.policy;
    policy.approvals!.by!.forEach((role, i) => {
      if (!roles.has(role)) d.add('error', 'unknown-role', `approvals.by: \`${role}\` is not a role in domain/roles.yaml (roles: ${roleList()})`, policy.file ?? shapeFile, policy, ['approvals', 'by', i]);
    });
  }

  for (const [name, state] of Object.entries(states)) {
    for (const [event, target] of Object.entries(state.on)) {
      if (!exists(target)) shape('error', 'unknown-target', `\`${name}\` goes to \`${target}\` on ${event}, but there is no such state`, ['steps', name, 'on', event]);
    }
    const timeout = state.wait?.timeout;
    if (timeout && !exists(timeout.target)) shape('error', 'unknown-target', `\`${name}\` times out to \`${timeout.target}\`, but there is no such state`, ['steps', name, 'wait', 'timeout']);
    if (!Object.keys(state.on).length && !timeout) shape('error', 'no-exit', `\`${name}\` has no way out: add transitions under \`on\` or a timeout`, ['steps', name]);
    if (roles && state.assignee !== undefined && !roles.has(state.assignee)) {
      shape('error', 'unknown-role', `\`${name}\`: assignee \`${state.assignee}\` is not a role in domain/roles.yaml (roles: ${roleList()})`, ['steps', name, 'assignee']);
    }

    const step = state.step ? workflow.steps[state.step] : undefined;
    // Phase 6: start, call and for_each states wait on other cases, which have their own timeouts.
    const handsOver = !step && state.block && state.block.kind !== 'wait_until';
    const waits = !handsOver && (!step || waitsOnSomeone(step));
    if (waits && !timeout) {
      const who = !step ? (state.block ? 'waits until its condition holds' : 'waits for an outside event (it has no step file)')
        : isConversationStep(step) ? 'waits for a conversation in chat'
        : `waits for a ${step.performer === 'person' ? 'person' : 'participant outside the business'}`;
      shape('warning', 'wait-without-timeout', `\`${name}\` ${who} but has no timeout: add \`wait: { timeout: 7d → needs_person }\` so it can't stall`, ['steps', name]);
    }
  }

  if (states[workflow.start]) {
    const seen = new Set([workflow.start]);
    const queue = [workflow.start];
    while (queue.length) {
      const s = states[queue.shift()!]!;
      for (const t of [...Object.values(s.on), ...(s.wait?.timeout ? [s.wait.timeout.target] : [])]) {
        if (states[t] && !seen.has(t)) { seen.add(t); queue.push(t); }
      }
    }
    for (const name of Object.keys(states)) {
      if (!seen.has(name)) shape('error', 'unreachable-state', `\`${name}\` can't be reached from \`${workflow.start}\``, ['steps', name]);
    }
  }

  // ---- the case type: every named type resolves
  const records = caseType.types;
  const checkFields = (fields: Record<string, FieldDef>, path: PathKey[]) => {
    for (const [name, field] of Object.entries(fields)) {
      checkTypeRefs(field.type, records, entities, (code, message) =>
        d.add('error', code, `${name}: ${message}`, caseType.file, caseType, [...path, name]));
    }
  };
  checkFields(caseType.fields, ['fields']);
  for (const [name, rec] of Object.entries(records)) checkFields(rec.fields, ['types', name]);

  // ---- steps
  for (const [name, state] of Object.entries(states)) {
    const step = state.step ? workflow.steps[state.step] : undefined;
    if (step) checkStep(d, workflow, name, step, env, entities);
  }

  // ---- example cases
  checkExamples(d, workflow, env, entities);

  // ---- Phase 6: what starts it, block states, signatures and review screens
  d.list.push(...checkWorkflowDomain(workflow, opts.project, entities, env.roles));
  return d.list;
}

/** Resolves `case.a.b` through record and entity types; returns the first segment that doesn't exist. */
function unknownReadSegment(path: string, workflow: WorkflowDef, entities?: Record<string, EntityTypeDef>): string | undefined {
  const [head, ...rest] = path.split('.').slice(1);
  let field = workflow.caseType.fields[head!];
  if (!field) return head;
  for (const seg of rest) {
    const t: ValueType = field.type;
    const fields: Record<string, FieldDef> | undefined = t.kind === 'named'
      ? (workflow.caseType.types[t.name]?.fields ?? entities?.[t.name]?.fields)
      : t.kind === 'ref' ? entities?.[t.entity]?.fields : undefined;
    // Lists, scalars and types we can't see into: the rest of the path is the tool's business.
    if (!fields) return undefined;
    if (t.kind === 'ref' && entities?.[t.entity]?.relationships[seg]) return undefined;
    field = fields[seg];
    if (!field) return seg;
  }
  return undefined;
}

function checkStep(d: Diagnostics, workflow: WorkflowDef, stateName: string, step: StepDef, env: CheckEnvironment, entities?: Record<string, EntityTypeDef>): void {
  const at = (severity: Severity, code: string, message: string, path: PathKey[]) => d.add(severity, code, message, step.file, step, path);
  const shape = (severity: Severity, code: string, message: string, path: PathKey[]) => d.add(severity, code, message, shapeFileOf(workflow), workflow, path);
  const state = workflow.states[stateName]!;
  const caseFields = workflow.caseType.fields;

  const conversation = isConversationStep(step);
  if (step.engine === 'open' && !(step.performer === 'agent' && step.strictness === 'open')) {
    at('error', 'open-engine-needs-open-step', step.performer === 'agent'
      ? `\`engine: open\` runs the step as a chat, so it needs \`strictness: open\` (this one is ${step.strictness})`
      : `only agent steps run on an engine; \`engine: open\` makes no sense on a ${step.performer} step`, ['engine']);
  }
  if (step.performer === 'agent') {
    // A conversation's model is the chat's own, so it names no model role.
    if (!step.model && !conversation) at('error', 'missing-model-role', 'an agent step names a model role, e.g. `model: checker`', []);
    if (!step.outcomes.length) at('error', 'no-outcomes', 'an agent step declares at least one outcome, e.g. `outcomes: [done]`', []);
  }
  if (step.outcomeFrom) {
    if (step.performer !== 'system') {
      at('error', 'outcome-from-system-only', `only system steps take their outcome from a tool result; a ${step.performer} step chooses its own`, ['outcomeFrom']);
    } else if (!step.tools.required.includes(step.outcomeFrom.tool)) {
      at('error', 'outcome-from-not-required', `the outcome comes from ${step.outcomeFrom.tool}, which this step does not call: add it to tools.required`, ['outcomeFrom', 'tool']);
    }
  }
  if (waitsOnSomeone(step)) {
    const roles = env.roles;
    const kind = conversation ? 'conversation' : step.performer;
    if (roles && step.assignee === undefined) {
      at('error', 'missing-assignee', `a ${kind} step names the role that does it, e.g. \`assignee: ${roles[0] ?? 'staff'}\``, []);
    } else if (roles && step.assignee !== undefined && !roles.includes(step.assignee)) {
      at('error', 'unknown-role', `assignee \`${step.assignee}\` is not a role in domain/roles.yaml (roles: ${roles.join(', ') || 'none'})`, ['assignee']);
    }
  } else if (step.assignee !== undefined && env.roles && !env.roles.includes(step.assignee)) {
    at('error', 'unknown-role', `assignee \`${step.assignee}\` is not a role in domain/roles.yaml (roles: ${env.roles.join(', ') || 'none'})`, ['assignee']);
  }
  if (env.roles && step.policy?.approvals?.by) {
    step.policy.approvals.by.forEach((role, i) => {
      if (!env.roles!.includes(role)) at('error', 'unknown-role', `policy.approvals.by: \`${role}\` is not a role in domain/roles.yaml`, ['policy', 'approvals', 'by', i]);
    });
  }
  if (step.extract) checkExtract(d, step, env);
  if (step.performer === 'system') checkSystemStep(d, workflow, step, env, entities);
  else if (step.map) at('warning', 'map-ignored', `only system steps use \`map\`; a ${step.performer} step chooses its own arguments`, ['map']);
  if (step.quotes && step.performer !== 'agent') at('warning', 'quotes-ignored', `only agent steps quote their sources; a ${step.performer} step has no judgement to quote for`, ['quotes']);

  for (const outcome of outcomesOf(step)) {
    if (!(outcome in state.on)) shape('error', 'outcome-without-transition', `step \`${stateName}\` can finish with \`${outcome}\`, but the shape has no transition for it`, ['steps', stateName, 'on']);
  }
  for (const event of Object.keys(state.on)) {
    if (!outcomesOf(step).includes(event) && !(BUILTIN_OUTCOMES as readonly string[]).includes(event)) {
      shape('warning', 'unknown-outcome', `\`${event}\` is not an outcome of step \`${stateName}\` (it declares ${step.outcomes.join(', ') || 'none'})`, ['steps', stateName, 'on', event]);
    }
  }

  step.reads.forEach((read, i) => {
    if (!read.startsWith('case.')) return; // the format check already reported it
    const missing = unknownReadSegment(read, workflow, entities);
    if (missing) at('error', 'unknown-case-field', `\`${read}\`: \`${missing}\` is not a field of the case`, ['reads', i]);
  });

  const allowed = new Set(step.tools.allowed);
  for (const [field, write] of Object.entries(step.writes)) {
    const caseField = caseFields[field];
    if (!caseField) {
      at('error', 'unknown-case-field', `\`${field}\` is not a field of the case type \`${workflow.caseType.id}\``, ['writes', field]);
    } else if (!sameValueType(caseField.type, write.type)) {
      at('error', 'write-type-mismatch', `\`${field}\` is ${caseField.typeSource} in the case type but written as ${write.typeSource}`, ['writes', field]);
    }
    checkTypeRefs(write.type, workflow.caseType.types, entities, (code, message) => at('error', code, `${field}: ${message}`, ['writes', field]));
    if (write.from.kind === 'tool' && !allowed.has(write.from.tool)) {
      at('error', 'tool-not-allowed', `\`${field}\` comes from tool ${write.from.tool}, which is not in tools.allowed`, ['writes', field, 'from']);
    }
  }

  (['allowed', 'required'] as const).forEach((list) => step.tools[list].forEach((tool, i) => {
    if (!env.tools[tool]) at('error', 'unknown-tool', `tool ${tool} is not bound in the domain`, ['tools', list, i]);
    if (list === 'required' && !allowed.has(tool)) at('error', 'required-not-allowed', `required tool ${tool} must also be in tools.allowed`, ['tools', list, i]);
  }));
}

const isDocumentType = (t: ValueType): boolean =>
  (t.kind === 'scalar' && (t.name === 'Document' || t.name === 'File' || t.name === 'Image')) || (t.kind === 'list' && isDocumentType(t.of));

/**
 * `extract:` (23 §5, D68): a form step's extraction reads the files of one of its Document writes
 * with a bound `read` tool and fills only the step's own writes. Whether the step's effective
 * policy lets the tool run is checked with the policy (`extractToolRefusal` in @memwise/policy).
 */
function checkExtract(d: Diagnostics, step: StepDef, env: CheckEnvironment): void {
  const at = (code: string, message: string, path: PathKey[]) => d.add('error', code, message, step.file, step, path);
  const x = step.extract!;
  if (step.performer !== 'external' && step.performer !== 'person') {
    at('extract-not-on-form-step', `only external and person steps have a form that can read documents; this is a ${step.performer} step`, ['extract']);
  }
  const docs = step.writes[x.documents];
  if (!docs) at('extract-documents-not-written', `\`${x.documents}\` is not one of this step's writes; name the Document or List<Document> field the files are uploaded to`, ['extract', 'documents']);
  else if (!isDocumentType(docs.type)) at('extract-documents-not-document', `\`${x.documents}\` is ${docs.typeSource}, not a Document or List<Document>`, ['extract', 'documents']);
  if (!Object.keys(x.fields).length) at('extract-no-fields', 'say which of the step\'s writes extraction may fill, e.g. `fields: [pan, gstin]`', ['extract', 'fields']);
  for (const [name, target] of Object.entries(x.fields)) {
    if (!step.writes[target]) at('extract-field-not-written', `\`${target}\`${name !== target ? ` (from ${name})` : ''} is not one of this step's writes, so extraction can't fill it`, ['extract', 'fields']);
    else if (target === x.documents) at('extract-field-not-written', `\`${target}\` holds the documents themselves; extraction fills the other fields`, ['extract', 'fields']);
  }
  if (!(x.minConfidence >= 0 && x.minConfidence <= 1)) at('invalid-format', 'min_confidence is between 0 and 1, e.g. 0.8', ['extract', 'min_confidence']);
  const tool = env.tools[x.tool];
  if (!tool) at('unknown-tool', `tool ${x.tool} is not bound in the domain`, ['extract', 'tool']);
  else if (tool.effect !== 'read') {
    at('extract-tool-not-read', `${x.tool} is ${tool.effect ?? 'unclassified (treated as irreversible)'}; a form may only run a \`read\` tool while the step waits`, ['extract', 'tool']);
  }
}

/**
 * A system step runs without a model: its required tools in order, each with the arguments its
 * `map` gives, and its writes taken from their results. So every required argument must be
 * mapped, every `case.` source must be a field the step reads, and every write must name a tool.
 */
function checkSystemStep(d: Diagnostics, workflow: WorkflowDef, step: StepDef, env: CheckEnvironment, entities?: Record<string, EntityTypeDef>): void {
  const at = (severity: Severity, code: string, message: string, path: PathKey[]) => d.add(severity, code, message, step.file, step, path);
  if (step.outcomeFrom) {
    // The tool result picks among the declared outcomes, so there must be some to pick from.
    if (!step.outcomes.length) at('error', 'no-outcomes', `the outcome comes from ${step.outcomeFrom.tool}: declare the outcomes it may give, e.g. \`outcomes: [passed, failed]\``, []);
  } else if (step.outcomes.length > 1) at('error', 'system-step-outcomes', `a system step finishes with one outcome; this one declares ${step.outcomes.join(', ')}`, ['outcomes']);
  if (!step.tools.required.length) at('warning', 'system-step-no-tools', 'a system step calls its `tools.required` in order; this one has none, so it does nothing', ['tools']);
  const calls = new Set(step.tools.required);
  const map = step.map ?? {};
  for (const tool of Object.keys(map)) {
    if (!calls.has(tool)) at('error', 'map-unknown-tool', `\`map\` gives arguments for ${tool}, which is not in tools.required (the tools this step calls)`, ['map', tool]);
  }
  const reads = step.reads.map((r) => r.slice('case.'.length));
  const isRead = (path: string) => reads.some((r) => path === r || path.startsWith(`${r}.`));
  // `each: case.<List field>` (25 §3): the tool is called once per item, which `item.<path>` reads.
  const itemFields: Record<string, Record<string, FieldDef> | undefined> = {};
  for (const [tool, path] of Object.entries(step.each ?? {})) {
    if (!calls.has(tool)) continue; // reported as map-unknown-tool
    const missing = unknownReadSegment(`case.${path}`, workflow, entities);
    if (missing) { at('error', 'unknown-case-field', `\`each: case.${path}\`: \`${missing}\` is not a field of the case`, ['map', tool, 'each']); continue; }
    if (!isRead(path)) at('error', 'map-unread-field', `\`case.${path}\` is not in the step's \`reads\`; add it there so the record shows what the step used`, ['map', tool, 'each']);
    const field = !path.includes('.') ? workflow.caseType.fields[path] : undefined;
    if (field && field.type.kind !== 'list') {
      at('error', 'map-each-not-list', `\`each: case.${path}\` is ${field.typeSource}, not a List: the tool is called once per item of a list`, ['map', tool, 'each']);
      continue;
    }
    const of = field?.type.kind === 'list' ? field.type.of : undefined;
    itemFields[tool] = of?.kind === 'named' ? (workflow.caseType.types[of.name]?.fields ?? entities?.[of.name]?.fields) : undefined;
  }
  for (const tool of step.tools.required) {
    const args = map[tool] ?? {};
    const schema = env.tools[tool]?.inputSchema;
    const required = Array.isArray(schema?.required) ? (schema.required as unknown[]).filter((a): a is string => typeof a === 'string') : [];
    for (const arg of required) {
      if (!(arg in args)) at('error', 'unmapped-argument', `${tool} needs the argument \`${arg}\`: add it under \`map: { ${tool}: { ${arg}: case.<field> } }\``, step.map?.[tool] ? ['map', tool] : ['tools', 'required']);
    }
    const props = schema?.properties && typeof schema.properties === 'object' ? schema.properties as Record<string, unknown> : undefined;
    for (const [arg, src] of Object.entries(args)) {
      if (props && schema?.additionalProperties === false && !(arg in props)) {
        at('error', 'unknown-argument', `${tool} has no argument \`${arg}\` (it takes ${Object.keys(props).join(', ') || 'none'})`, ['map', tool, arg]);
      }
      if ('item' in src) {
        if (!step.each?.[tool]) at('error', 'map-item-without-each', `\`item${src.item ? `.${src.item}` : ''}\` reads the item of a tool called once per item: add \`each: case.<List field>\` to ${tool}'s map`, ['map', tool, arg]);
        const head = src.item.split('.')[0];
        const fields = itemFields[tool];
        if (head && fields && !fields[head]) at('error', 'unknown-case-field', `\`item.${src.item}\`: \`${head}\` is not a field of the items (they have ${Object.keys(fields).join(', ')})`, ['map', tool, arg]);
        continue;
      }
      if (!('case' in src)) continue;
      const missing = unknownReadSegment(`case.${src.case}`, workflow, entities);
      if (missing) at('error', 'unknown-case-field', `\`case.${src.case}\`: \`${missing}\` is not a field of the case`, ['map', tool, arg]);
      else if (!isRead(src.case)) at('error', 'map-unread-field', `\`case.${src.case}\` is not in the step's \`reads\`; add it there so the record shows what the step used`, ['map', tool, arg]);
    }
  }
  for (const [field, write] of Object.entries(step.writes)) {
    if (write.from.kind !== 'tool') at('error', 'system-write-not-from-tool', `a system step has no judgement: \`${field}\` must come \`from: { tool, field }\``, ['writes', field]);
    else if (!calls.has(write.from.tool)) at('error', 'system-write-tool-not-called', `\`${field}\` comes from ${write.from.tool}, which this step does not call (it is not in tools.required)`, ['writes', field, 'from']);
    else if (step.each?.[write.from.tool] && write.type.kind !== 'list') {
      at('error', 'each-write-not-list', `\`${field}\` comes from ${write.from.tool}, which is called once per item, so it is a list of results: declare it List<${write.typeSource}>`, ['writes', field]);
    }
  }
}

function checkExamples(d: Diagnostics, workflow: WorkflowDef, env: CheckEnvironment, entities?: Record<string, EntityTypeDef>): void {
  const records: RecordTypes = { ...entities, ...workflow.caseType.types };
  const fields = workflow.caseType.fields;
  const isTool = (name: string) => !!env.tools[name] || (ENGINE_TOOLS as readonly string[]).includes(name);

  for (const ex of workflow.examples) {
    const at = (code: string, message: string, path: PathKey[]) => d.add('error', code, `${ex.name}: ${message}`, ex.file, ex, path);

    if (ex.startAt !== undefined && !workflow.states[ex.startAt]) at('example-unknown-state', `startAt \`${ex.startAt}\` is not a state`, ['startAt']);
    const expectState = ex.expect.state;
    if (expectState !== undefined && expectState !== END_STATE && !workflow.states[expectState]) {
      at('example-unknown-state', `expect.state \`${expectState}\` is not a state`, ['expect', 'state']);
    }
    const startState = workflow.states[ex.startAt ?? workflow.start];
    const step = startState?.step ? workflow.steps[startState.step] : undefined;
    const outcome = ex.expect.outcome;
    if (outcome !== undefined && step && !outcomesOf(step).includes(outcome) && !(BUILTIN_OUTCOMES as readonly string[]).includes(outcome)) {
      at('example-unknown-outcome', `expect.outcome \`${outcome}\` is not an outcome of step \`${step.id}\``, ['expect', 'outcome']);
    }

    const values = (section: 'case' | 'writes', vals: Record<string, unknown> | undefined) => {
      const base: PathKey[] = section === 'case' ? ['case'] : ['expect', 'writes'];
      for (const [name, value] of Object.entries(vals ?? {})) {
        const field = fields[name];
        if (!field) { at('example-unknown-field', `\`${name}\` is not a field of the case`, [...base, name]); continue; }
        for (const err of validateValue(field.type, value, records)) at('example-invalid-value', `${name}${err.startsWith('[') ? '' : ': '}${err}`, [...base, name]);
      }
    };
    values('case', ex.case);
    values('writes', ex.expect.writes);

    for (const [state, answers] of Object.entries(ex.submit ?? {})) {
      const target = workflow.states[state];
      const s = target?.step ? workflow.steps[target.step] : undefined;
      if (!s || !waitsOnSomeone(s)) {
        at('example-unknown-state', `submit.${state}: \`${state}\` is not a person, external or conversation step`, ['submit', state]);
        continue;
      }
      (Array.isArray(answers) ? answers : [answers]).forEach((a) => {
        if (!s.outcomes.includes(a.outcome)) at('example-unknown-outcome', `submit.${state}: \`${a.outcome}\` is not an outcome of step \`${state}\``, ['submit', state]);
        for (const [name, value] of Object.entries(a.values ?? {})) {
          const w = s.writes[name];
          if (!w) { at('example-unknown-field', `submit.${state}: step \`${state}\` does not write \`${name}\``, ['submit', state]); continue; }
          for (const err of validateValue(w.type, value, records)) at('example-invalid-value', `submit.${state}.${name}: ${err}`, ['submit', state]);
        }
      });
    }
    for (const entity of Object.keys(ex.expect.entities ?? {})) {
      if (entities && !entities[entity]) at('unknown-entity', `expect.entities: there is no entity type ${entity}`, ['expect', 'entities', entity]);
    }
    // Phase 6: records made before the run, each with an optional id and status.
    for (const [entity, rows] of Object.entries(ex.records ?? {})) {
      const def = entities?.[entity];
      if (entities && !def) { at('unknown-entity', `records: there is no entity type ${entity}`, ['records', entity]); continue; }
      if (!def) continue;
      rows.forEach((row, i) => {
        for (const [name, value] of Object.entries(row)) {
          if (name === 'id') continue;
          if (name === 'status') {
            if (def.lifecycle && !def.lifecycle.includes(String(value))) at('example-invalid-value', `records.${entity}[${i}].status: \`${value}\` is not a state of ${entity} (${def.lifecycle.join(', ')})`, ['records', entity, i, name]);
            continue;
          }
          const f = def.fields[name];
          if (!f) { at('example-unknown-field', `records.${entity}[${i}]: \`${name}\` is not a field of ${entity}`, ['records', entity, i, name]); continue; }
          for (const err of validateValue(f.type, value, records)) at('example-invalid-value', `records.${entity}[${i}].${name}: ${err}`, ['records', entity, i, name]);
        }
      });
    }

    const tools: [string, PathKey[]][] = [
      ...Object.keys(ex.tools ?? {}).map((t): [string, PathKey[]] => [t, ['tools', t]]),
      ...Object.keys(ex.approvals ?? {}).map((t): [string, PathKey[]] => [t, ['approvals', t]]),
      ...Object.keys(ex.expect.effects ?? {}).map((t): [string, PathKey[]] => [t, ['expect', 'effects', t]]),
      ...Object.entries(ex.model ?? {}).flatMap(([role, turns]) => turns.flatMap((turn, i) =>
        (turn.toolCalls ?? []).map((c, j): [string, PathKey[]] => [c.name, ['model', role, i, 'toolCalls', j]]))),
    ];
    const reported = new Set<string>();
    for (const [tool, path] of tools) {
      if (isTool(tool) || reported.has(tool)) continue;
      reported.add(tool);
      at('example-unknown-tool', `tool ${tool} is not bound in the domain`, path);
    }
  }
}

/**
 * Entity types, then every workflow with the project's entities (and its roles, unless `env` names
 * them). Phase 4: the tools frozen bindings bind count as bound (a tool `env` names keeps its
 * entry), and the bindings themselves are checked.
 */
export function checkProject(project: ProjectDefs, env: CheckEnvironment): Diagnostic[] {
  const d = new Diagnostics();
  const pluginTools = boundPluginTools(project);
  if (Object.keys(pluginTools).length) {
    const tools = { ...env.tools };
    for (const [name, t] of Object.entries(pluginTools)) {
      tools[name] ??= { ...(t.effect ? { effect: t.effect } : {}), ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}) };
    }
    env = { ...env, tools };
  }
  // Phase 6: the entity tools the kernel binds for every entity type (24 §3).
  const tools = { ...env.tools };
  for (const [name, t] of Object.entries(entityTools(project.entities))) tools[name] ??= { effect: t.effect };
  env = { ...env, tools };
  const entities = project.entities;
  const declared = Object.keys(project.roles ?? {});
  if (!env.roles && declared.length) env = { ...env, roles: declared };
  const by = project.domainPolicy?.approvals?.by;
  if (env.roles && by && project.domainPolicy) {
    by.forEach((role, i) => {
      if (!env.roles!.includes(role)) d.add('error', 'unknown-role', `approvals.by: \`${role}\` is not a role in domain/roles.yaml`, project.domainPolicy!.file ?? 'domain/policy.yaml', project.domainPolicy!, ['approvals', 'by', i]);
    });
  }
  for (const entity of Object.values(entities)) {
    const scoped = scopedEntities(entities, domainOf(entity));
    for (const [name, field] of Object.entries(entity.fields)) {
      checkTypeRefs(field.type, {}, scoped, (code, message) => d.add('error', code, `${name}: ${message}`, entity.file, entity, ['fields', name]));
    }
  }
  const out = d.list;
  // Phase 6: domains, relationships, calculated fields, links, lifecycles, pages, views (check-domains.ts).
  out.push(...checkDomains(project, env.roles));
  for (const workflow of Object.values(project.workflows)) {
    out.push(...checkWorkflow(workflow, env, { entities: scopedEntities(entities, domainOf(workflow)), project }));
  }
  if (project.bindings) out.push(...checkBindings(project));
  return out;
}

