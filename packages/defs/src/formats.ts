/**
 * The file formats as written, in zod. One source for both the loader's structural
 * checks and the JSON Schemas editors use, so the two can't drift apart.
 *
 * These describe the raw YAML (`40k`, `7d → needs_person`, `from: tool x`); the parsers
 * turn them into the definition model in types.ts.
 */
import { z } from 'zod';
import { EFFECT_CLASSES, TREATMENTS } from './types.ts';
import { COUNT_PATTERN, DURATION_PATTERN, RATE_PATTERN } from './value-types.ts';

const duration = z.union([
  z.number().nonnegative(),
  z.string().regex(new RegExp(DURATION_PATTERN), { error: 'expected a duration like 30s, 10m, 3d or 1h30m' }),
], { error: 'expected a duration like 30s, 10m, 3d or 1h30m' }).meta({ description: 'A duration: 30s, 10m, 3d, 1h30m, or a number of milliseconds.' });

const count = z.union([
  z.number().nonnegative(),
  z.string().regex(new RegExp(COUNT_PATTERN), { error: 'expected a count like 12, 40k or 1.5m' }),
], { error: 'expected a count like 12, 40k or 1.5m' }).meta({ description: 'A count: 12, 40k, 1.5m (million).' });

const typeExpr = z.string({ error: 'expected a type expression like Text, Money or List<Flag>' })
  .meta({ description: 'A value type: Text, Money, Identifier(GSTIN), Quantity(kg), Enum[a, b], List<T>, Ref<Entity>, or a record type name.' });

const names = z.array(z.string());

const field = z.union([
  typeExpr,
  z.strictObject({
    type: typeExpr,
    required: z.boolean().optional(),
    description: z.string().optional(),
    access: names.optional().meta({ description: 'Roles allowed to see the field.' }),
  }),
], { error: 'expected a type expression or { type, required, description, access }' });

const fields = z.record(z.string(), field);

const treatment = z.enum(TREATMENTS);
const money = z.strictObject({ amount: z.number(), currency: z.string().regex(/^[A-Z]{3}$/, { error: 'expected a 3-letter ISO currency code' }) });

export const policyFormat = z.strictObject({
  policy: z.string().optional().meta({ description: 'The layer name.' }),
  effects: z.strictObject(Object.fromEntries(EFFECT_CLASSES.map((c) => [c, treatment.optional()]))).optional(),
  tools: z.strictObject({
    allow: names.optional().meta({ description: 'If set, only these tools.' }),
    deny: names.optional(),
    require: names.optional(),
    rules: z.record(z.string(), z.strictObject({
      treatment: treatment.optional(),
      rateLimit: z.string().regex(new RegExp(RATE_PATTERN), { error: 'expected a rate like 30/min or 5/10m' }).optional(),
    })).optional(),
  }).optional(),
  budgets: z.strictObject({ tokens: count.optional(), time: duration.optional(), modelCalls: count.optional(), money: money.optional() }).optional(),
  modelRoles: names.optional(),
  taint: z.strictObject({ enabled: z.boolean().optional(), outboundWhenTainted: treatment.optional() }).optional(),
  approvals: z.strictObject({
    by: names.optional().meta({ description: 'Roles that may decide effect approvals.' }),
  }).optional(),
}).meta({ title: 'MemWise policy layer', description: 'domain/policy.yaml, workflows/<id>/policy.yaml, or the policy block of a step.' });

export const TIMEOUT_PATTERN = '^\\s*(\\S+)\\s*(→|->)\\s*(\\S+)\\s*$';

export const workflowFormat = z.strictObject({
  workflow: z.string().meta({ description: 'The workflow id, usually the folder name.' }),
  version: z.number().int().positive(),
  title: z.string().optional(),
  owner: z.string().optional().meta({ description: 'Role that gets attention items: stopped runs, cases needing a person.' }),
  case: z.string().optional().meta({ description: 'Path to the case type, relative to this file. Default ./case.yaml.' }),
  policy: z.string().optional().meta({ description: 'Path to the workflow policy layer. Default ./policy.yaml when it exists.' }),
  forked_from: z.string().regex(/^\S+@\S+$/, { error: 'expected <plugin>@<version>, e.g. memwise/client-intake@1.0.0' }).optional()
    .meta({ description: 'Phase 4: this playbook is a fork of a plugin workflow, <plugin>@<version>; it shadows the plugin\'s.' }),
  start: z.string(),
  steps: z.record(z.string(), z.strictObject({
    on: z.record(z.string(), z.string()).optional().meta({ description: 'Outcome or event name → target state, or end.' }),
    wait: z.strictObject({
      remind: duration.optional(),
      timeout: z.string().regex(new RegExp(TIMEOUT_PATTERN), { error: 'expected a timeout like 7d → needs_person' }).optional(),
    }).optional(),
    assignee: z.string().optional().meta({ description: 'Role whose attention this state needs (for states without a step file).' }),
  })).meta({ description: 'The states, by name. A state with a steps/<name>.md file runs that step.' }),
}).meta({ title: 'MemWise workflow', description: 'workflows/<id>/workflow.yaml: the shape.' });

const writeSource = z.union([
  z.string().regex(/^\s*(judgement|person|tool\s+\S+)\s*$/, { error: 'expected judgement, person, tool <name>, or { tool, field }' }),
  z.strictObject({ tool: z.string(), field: z.string().optional().meta({ description: 'Dotted path inside the tool result.' }) }),
], { error: 'expected judgement, person, tool <name>, or { tool, field }' });

export const stepFormat = z.strictObject({
  title: z.string(),
  performer: z.enum(['agent', 'person', 'external', 'system']),
  strictness: z.enum(['strict', 'guided', 'open']).optional().meta({ description: 'Default guided.' }),
  reads: z.array(z.string().regex(/^case\.[A-Za-z_][\w.]*$/, { error: 'expected a case path like case.pan' })).optional(),
  writes: z.record(z.string(), z.union([
    typeExpr,
    z.strictObject({ type: typeExpr, from: writeSource.optional(), required: z.boolean().optional() }),
  ], { error: 'expected a type expression or { type, from, required }' })).optional(),
  tools: z.strictObject({ allowed: names.optional(), required: names.optional() }).optional(),
  model: z.string().optional().meta({ description: 'A model role, never a model name.' }),
  budget: z.strictObject({ tokens: count.optional(), time: duration.optional(), modelCalls: count.optional() }).optional(),
  checkpoint: z.array(z.string()).optional(),
  outcomes: names.optional(),
  policy: policyFormat.optional(),
  assignee: z.string().optional().meta({ description: 'Role that does (or decides) a person or external step.' }),
  map: z.record(z.string(), z.record(z.string(), z.unknown())).optional().meta({
    description: 'System steps: arguments for each tool, in call order. `case.<field>` reads the case; anything else is a literal (or write { value: ... }).',
  }),
  engine: z.enum(['step', 'open']).optional().meta({
    description: 'Agent steps: `open` runs the step as a conversation in chat (needs strictness: open); default `step`.',
  }),
  outcomeFrom: z.strictObject({
    tool: z.string().meta({ description: 'A tool in tools.required.' }),
    field: z.string().meta({ description: 'Dotted path inside its last result.' }),
  }).optional().meta({ description: 'System steps: the outcome is this field of this tool\'s last result (one of `outcomes`).' }),
  extract: z.strictObject({
    tool: z.string().meta({ description: 'A tool that is `read` in the step\'s effective policy, e.g. intake.extract_fields.' }),
    documents: z.string().meta({ description: 'The Document or List<Document> write whose files it reads.' }),
    fields: z.union([
      z.array(z.union([z.string(), z.record(z.string(), z.union([z.string(), z.strictObject({ as: z.string() })]))])),
      z.record(z.string(), z.union([z.string(), z.strictObject({ as: z.string() }), z.null()])),
    ], { error: 'expected a list of writes, e.g. [pan, gstin], or a map of result names to writes' }).optional()
      .meta({ description: 'Writes it may fill; `{ legal_name: client_name }` takes a result named legal_name into client_name.' }),
    min_confidence: z.number().min(0).max(1).optional().meta({ description: 'Suggestions at or above this (and found in the document) are pre-filled. Default 0.8.' }),
  }).optional().meta({ description: 'External and person steps: what the form may read from the uploaded documents while the step waits (Phase 5).' }),
}).meta({ title: 'MemWise step', description: 'The front matter of workflows/<id>/steps/<state>.md.' });

export const caseFormat = z.strictObject({
  case: z.string(),
  fields,
  types: z.record(z.string(), fields).optional().meta({ description: 'Small record types used by fields.' }),
}).meta({ title: 'MemWise case type', description: 'workflows/<id>/case.yaml.' });

export const entityFormat = z.strictObject({
  entity: z.string(),
  fields,
  relationships: z.record(z.string(), z.string().regex(/^\s*(one|many)\s+[A-Za-z_]\w*\s*$/, { error: 'expected one <Entity> or many <Entity>' })).optional(),
  lifecycle: names.optional(),
  ownership: z.record(z.string(), z.string()).optional().meta({ description: 'field → owner (a plugin id or domain).' }),
}).meta({ title: 'MemWise entity type', description: 'domain/entities/<name>.yaml.' });

const scriptedTurn = z.strictObject({
  text: z.string().optional(),
  toolCalls: z.array(z.strictObject({ name: z.string(), args: z.record(z.string(), z.unknown()) })).optional(),
});

const submission = z.strictObject({
  outcome: z.string(),
  values: z.record(z.string(), z.unknown()).optional(),
  comment: z.string().optional(),
});

export const exampleFormat = z.strictObject({
  name: z.string().optional().meta({ description: 'Default: the file name.' }),
  description: z.string().optional(),
  startAt: z.string().optional(),
  case: z.record(z.string(), z.unknown()),
  tools: z.record(z.string(), z.unknown()).optional(),
  model: z.record(z.string(), z.array(scriptedTurn)).optional(),
  approvals: z.record(z.string(), z.enum(['approve', 'reject'])).optional(),
  submit: z.record(z.string(), z.union([submission, z.array(submission)])).optional()
    .meta({ description: 'Answers to person and external steps, by state: one for every visit, or a list used in order.' }),
  expect: z.strictObject({
    outcome: z.string().optional(),
    state: z.string().optional(),
    writes: z.record(z.string(), z.unknown()).optional(),
    effects: z.record(z.string(), z.number().int().nonnegative()).optional(),
    entities: z.record(z.string(), z.union([z.number().int().nonnegative(), z.array(z.record(z.string(), z.unknown()))])).optional()
      .meta({ description: 'Rows in the domain tables after the run, by entity type: a count, or the rows (matched on the listed fields).' }),
  }),
}).meta({ title: 'MemWise example case', description: 'workflows/<id>/examples/*.yaml.' });

export const rolesFormat = z.strictObject({
  roles: z.record(z.string().regex(/^[a-z][a-z0-9_-]*$/, { error: 'a role id is lower-case letters, digits, - and _' }), z.union([
    z.string(),
    z.strictObject({ title: z.string(), description: z.string().optional() }),
  ], { error: 'expected a title, or { title, description }' })),
}).meta({ title: 'MemWise roles', description: 'domain/roles.yaml: the roles people can have.' });

// ---------------------------------------------------------------- plugins and bindings (Phase 4)

const role = z.union([
  z.string(),
  z.strictObject({ title: z.string(), description: z.string().optional() }),
], { error: 'expected a title, or { title, description }' });

const jsonSchema = z.record(z.string(), z.unknown()).meta({ description: 'A JSON Schema.' });

const toolRoute = z.union([
  z.strictObject({ builtin: z.string().meta({ description: 'First-party code shipped with the app, by name.' }) }),
  z.strictObject({ mcp: z.string().meta({ description: 'A server under mcp_servers.' }), tool: z.string().meta({ description: 'The tool name on that server.' }) }),
  z.strictObject({ command: z.array(z.string()).min(1).meta({ description: 'A subprocess per call: JSON arguments on stdin, a JSON result on stdout.' }), timeout: duration.optional() }),
], { error: 'expected { builtin: <name> }, { mcp: <server>, tool: <name> } or { command: [...] }' });

const mcpServer = z.union([
  z.strictObject({ command: z.string(), args: names.optional(), env: z.record(z.string(), z.string()).optional(), cwd: z.string().optional() }),
  z.strictObject({ type: z.enum(['http', 'sse']).optional(), url: z.string(), headers: z.record(z.string(), z.string()).optional() }),
  z.strictObject({ source: z.string().meta({ description: 'A connector set up in the app; the host resolves it with its credentials.' }) }),
], { error: 'expected { command, args, env }, { url, headers } or { source }' });

export const pluginFormat = z.strictObject({
  id: z.string().meta({ description: '<publisher>/<name>, lower case.' }),
  version: z.string().meta({ description: 'Semver, e.g. 1.0.0.' }),
  title: z.string(),
  description: z.string().optional(),
  trust: z.enum(['first-party', 'verified', 'community', 'local']).optional().meta({ description: 'Default local.' }),
  imported_from: z.strictObject({ kind: z.literal('claude-plugin'), name: z.string(), version: z.string().optional() }).optional(),
  provides: z.strictObject({
    capabilities: z.record(z.string(), z.strictObject({ tool: z.string() })).optional(),
  }).optional(),
  requires: z.strictObject({
    capabilities: z.record(z.string(), z.strictObject({
      as: z.string().meta({ description: 'The tool name the plugin\'s workflows use for it.' }),
      optional: z.boolean().optional(),
    })).optional(),
    entities: z.record(z.string(), z.strictObject({ fields })).optional().meta({ description: 'Entities in the plugin\'s own terms, mapped to the domain\'s at binding.' }),
    roles: z.record(z.string(), role).optional(),
  }).optional(),
  tools: z.record(z.string(), z.strictObject({
    description: z.string().optional(),
    effect: z.enum(EFFECT_CLASSES).optional().meta({ description: 'Absent: unclassified (irreversible until a binding classifies it).' }),
    input: jsonSchema.optional(),
    output: jsonSchema.optional(),
    quarantine: z.boolean().optional(),
    idempotent: z.boolean().optional(),
    secrets: names.optional(),
    annotations: z.strictObject({
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    }).optional(),
    capability: z.string().optional(),
    run: toolRoute,
  })).optional(),
  mcp_servers: z.record(z.string(), mcpServer).optional(),
  workflows: names.optional().meta({ description: 'Folders under workflows/.' }),
  skills: names.optional().meta({ description: 'Folders under skills/ with a SKILL.md.' }),
  records: z.record(z.string(), z.strictObject({
    title: z.string().optional(),
    list: z.strictObject({ tool: z.string(), items: z.string().optional(), args: z.record(z.string(), z.unknown()).optional() }),
    get: z.strictObject({ tool: z.string(), arg: z.string(), item: z.string().optional() }).optional(),
    key: z.string(),
    fields: z.record(z.string(), typeExpr),
  })).optional().meta({ description: 'Record kinds a connector exposes, for bindings to map onto domain entities.' }),
  policy: policyFormat.optional(),
  environment: z.strictObject({ runtime: z.string().optional(), lockfile: z.string().optional(), network: names.optional() }).optional(),
  components: names.optional(),
  pages: names.optional(),
  triggers: z.array(z.unknown()).optional(),
}).meta({ title: 'MemWise plugin', description: 'memwise-plugin.yaml: a plugin\'s manifest.' });

export const TRANSFORM_NAMES = ['trim', 'lower', 'upper', 'digits', 'squash'] as const;

const transform = z.union([
  z.enum(TRANSFORM_NAMES),
  z.strictObject({ default: z.unknown() }),
  z.strictObject({ map: z.record(z.string(), z.unknown()) }),
  z.strictObject({ money: z.string().regex(/^[A-Z]{3}$/, { error: 'expected a 3-letter ISO currency code' }) }),
  z.strictObject({ template: z.string().meta({ description: 'Text from several source fields: "{first} {last}".' }) }),
], { error: 'expected trim, lower, upper, digits, squash, { default }, { map }, { money: INR } or { template }' });

export const bindingFormat = z.strictObject({
  plugin: z.string(),
  plugin_version: z.string(),
  plugin_hash: z.string().optional(),
  version: z.number().int().nonnegative().optional(),
  frozen: z.strictObject({ by: z.string(), at: z.string(), run: z.string().optional() }).optional(),
  tools: z.record(z.string(), z.strictObject({
    effect: z.enum(EFFECT_CLASSES).optional(),
    off: z.boolean().optional(),
    reason: z.string().optional(),
  })).optional(),
  capabilities: z.record(z.string(), z.string()).optional().meta({ description: 'Required capability → the bound tool that provides it.' }),
  entities: z.record(z.string(), z.strictObject({ entity: z.string(), fields: z.record(z.string(), z.string()).optional() })).optional(),
  roles: z.record(z.string(), z.string()).optional(),
  records: z.record(z.string(), z.strictObject({
    entity: z.string(),
    fields: z.record(z.string(), z.union([
      z.string(),
      z.strictObject({ from: z.string().optional(), transform: z.array(transform).optional(), direction: z.enum(['read', 'write', 'both']).optional() }),
    ], { error: 'expected a source field, or { from, transform, direction }' })),
    identity: z.strictObject({
      keys: names.optional(),
      fuzzy: z.strictObject({ field: z.string(), auto: z.number().min(0).max(1), review: z.number().min(0).max(1) }).optional(),
      create_missing: z.boolean().optional(),
    }).optional(),
  })).optional(),
  policy: policyFormat.optional(),
  dry_run: z.strictObject({ at: z.string(), hash: z.string(), passed: z.boolean(), summary: z.string() }).optional(),
}).meta({ title: 'MemWise binding', description: 'domain/bindings/<slug>.yaml: how one plugin is bound into this domain.' });

export const formats = {
  workflow: workflowFormat,
  step: stepFormat,
  case: caseFormat,
  entity: entityFormat,
  policy: policyFormat,
  example: exampleFormat,
  roles: rolesFormat,
  plugin: pluginFormat,
  binding: bindingFormat,
} as const;
export type FormatName = keyof typeof formats;

/** JSON Schemas for each file format (draft 2020-12). `bun run schemas` writes them to schemas/. */
export const jsonSchemas = Object.fromEntries(
  Object.entries(formats).map(([name, schema]) => [name, z.toJSONSchema(schema, { io: 'input' })]),
) as unknown as Record<FormatName, Record<string, unknown>>;
