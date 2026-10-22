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
    controlled: z.boolean().optional().meta({ description: 'Phase 6: false exempts the field from the regulated reason rule (default true in a regulated domain).' }),
    quote_of: z.string().regex(/^\s*[A-Za-z_]\w*\.[A-Za-z_]\w*\s*$/, { error: 'expected <ref field>.<text field>, e.g. article.abstract' }).optional()
      .meta({ description: 'A Text field whose value must be words of the referenced record\'s Text field, e.g. article.abstract; a value not found there raises a flag.' }),
  }),
], { error: 'expected a type expression or { type, required, description, access, controlled, quote_of }' });

const fields = z.record(z.string(), field);

// ---------------------------------------------------------------- Phase 6 building blocks (24 §4-§8)

/** An entity name as a file names it: bare in its own domain, or a key (`edc.Site`). */
const ENTITY_NAME = '[A-Za-z_]\\w*(\\.[A-Za-z_]\\w*)?';

/** A condition in the condition language (24 §5). */
const condition = z.string().meta({ description: "A condition: status = 'filed', start_up_pack_complete = 100%, cv_expires <= today + 30d." });

const relationship = z.union([
  z.string().regex(new RegExp(`^\\s*(one|many)\\s+${ENTITY_NAME}\\s*$`), { error: 'expected one <Entity> or many <Entity>' }),
  z.strictObject({
    one: z.string().optional(),
    many: z.string().optional(),
    via: z.string().optional().meta({ description: "many: the target's field pointing back (needed when it isn't unique)." }),
  }),
], { error: 'expected one <Entity>, many <Entity>, or { many: <Entity>, via: <field> }' });

const calculated = z.union([
  z.strictObject({ count: z.string(), where: condition.optional(), description: z.string().optional() }),
  z.strictObject({ sum: z.string(), field: z.string(), where: condition.optional(), description: z.string().optional() }),
  z.strictObject({ min: z.string(), field: z.string(), where: condition.optional(), description: z.string().optional() }),
  z.strictObject({ max: z.string(), field: z.string(), where: condition.optional(), description: z.string().optional() }),
  z.strictObject({ percent: z.string(), where: condition, description: z.string().optional() }),
  z.strictObject({ formula: z.string(), description: z.string().optional() }),
], { error: 'expected { count | sum | min | max | percent: <many relationship>, field, where } or { formula }' });

const entityLink = z.strictObject({
  match: z.union([names, z.record(z.string(), z.string())]).meta({ description: "Fields compared, in this entity's names; { site_number: number } renames." }),
  follow: names.optional().meta({ description: "The other side's fields shown here, read-only." }),
});

const lifecycleChart = z.strictObject({
  initial: z.string(),
  states: z.record(z.string(), z.union([
    z.null(),
    z.strictObject({
      on: z.record(z.string(), z.string()).optional().meta({ description: 'Transition name → target state.' }),
      after: z.record(z.string(), z.strictObject({ remind: z.string().optional(), transition: z.string().optional() }))
        .optional().meta({ description: 'Timers from entering the state: { 60d: { remind: <role> } } or { 30d: { transition: <name> } }.' }),
      description: z.string().optional(),
    }),
  ])),
  transitions: z.record(z.string(), z.union([
    z.null(),
    z.strictObject({
      by: z.union([z.string(), names]).optional().meta({ description: 'step, role:<id>, source:<plugin | domain:<id>>, system.' }),
      guard: condition.optional(),
      signed: z.boolean().optional().meta({ description: 'Regulated domains: needs a matching signature on the record.' }),
      label: z.string().optional().meta({ description: 'The button\'s words, e.g. "Keep watching, every Monday".' }),
      primary: z.boolean().optional().meta({ description: "Shown as the page's main button." }),
      description: z.string().optional(),
    }),
  ])).optional(),
});

/** A record page block, as written: `details`, or `{ fields: [...] }`, `{ viewer: file }`, ... (the parser checks which). */
const pageBlock = z.union([z.string(), z.record(z.string(), z.unknown())])
  .meta({ description: 'fields: [names], details, viewer: <field>, markdown: <Text field>, related: [relationships], cases, lifecycle, chart: { kind, of, by, where, title, label, value, low, high, unit }, kpis: [fields], checks, notes, mentions, start, history, chat.' });
const pageArea = z.array(pageBlock);

export const pageLayoutFormat = z.strictObject({
  layout: z.enum(['single', 'split', 'sidebar']).optional().meta({ description: 'Default single.' }),
  header: names.optional().meta({ description: 'Fields shown beside the title.' }),
  main: pageArea.optional(),
  left: pageArea.optional(),
  right: pageArea.optional(),
  side: pageArea.optional(),
  below: pageArea.optional(),
});

const handoffTarget = z.strictObject({
  workflow: z.string(),
  with: z.record(z.string(), z.unknown()).optional()
    .meta({ description: 'Start fields of the other workflow ← case.<path>, item, item.<path>, record, or a literal.' }),
  returns: z.record(z.string(), z.string()).optional().meta({ description: "call: this case's field ← the child case's field, when the child ends." }),
});

const entityField = z.string().regex(new RegExp(`^${ENTITY_NAME}\\.[A-Za-z_]\\w*$`), { error: 'expected <Entity>.<field>, e.g. Person.cv_expires' });

export const triggerFormat = z.strictObject({
  entered: z.string().regex(new RegExp(`^${ENTITY_NAME}\\.[A-Za-z_]\\w*$`), { error: 'expected <Entity>.<state>, e.g. Site.activating' }).optional()
    .meta({ description: 'A record enters a lifecycle state.' }),
  created: z.string().optional().meta({ description: 'A record of this entity is created.' }),
  changed: z.union([z.string(), z.strictObject({ entity: z.string(), fields: names.optional() })]).optional()
    .meta({ description: 'A record changes (optionally only these fields).' }),
  before: z.strictObject({ field: entityField, by: duration }).optional().meta({ description: 'A date on a record, this long before it.' }),
  after: z.strictObject({ field: entityField, by: duration }).optional().meta({ description: 'A date on a record, this long after it.' }),
  every: duration.optional().meta({ description: 'A schedule: 2w, 1d.' }),
  at: z.string().regex(/^\d{1,2}:\d{2}$/, { error: 'expected a time like 06:00' }).optional(),
  on: z.union([z.string(), z.number().int()]).optional().meta({ description: 'every: a weekday (monday) or a day of the month (1).' }),
  message: z.strictObject({ address: z.string() }).optional().meta({ description: "An incoming message to the domain's intake address." }),
  with: z.record(z.string(), z.unknown()).optional().meta({ description: 'Case field ← record, message.<field>, or a literal.' }),
  as: z.string().optional().meta({ description: "Role the case runs as (default the workflow's owner)." }),
}).meta({ description: 'What starts the workflow: entered, created, changed, before, after, every or message.' });

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
    start: handoffTarget.optional().meta({ description: 'Phase 6: start a case of another workflow and move on (event started).' }),
    call: handoffTarget.optional().meta({ description: "Phase 6: run another workflow and wait; its outcome is this state's event." }),
    for_each: z.strictObject({
      items: z.string().regex(/^case\.[A-Za-z_][\w.]*$/, { error: 'expected a List case field like case.documents' }),
      as: z.string().optional(),
      start: handoffTarget.optional(),
      call: handoffTarget.optional(),
      join: z.union([z.enum(['all', 'any']), z.number().int().positive()]).optional().meta({ description: 'call: all (default), any, or a number.' }),
    }).optional().meta({ description: 'Phase 6: start or call once per item of a List case field (events done, failed, started).' }),
    wait_until: z.strictObject({
      record: z.string().regex(/^case\.[A-Za-z_]\w*$/, { error: 'expected a Ref case field like case.site' }),
      condition,
    }).optional().meta({ description: 'Phase 6: wait until a condition on a record holds (event met).' }),
  })).meta({ description: 'The states, by name. A state with a steps/<name>.md file runs that step.' }),
  starts_on: z.array(triggerFormat).optional().meta({ description: 'Phase 6: what starts the workflow.' }),
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
    description: 'System steps: arguments for each tool, in call order. `case.<field>` reads the case; `each: case.<List field>` calls the tool once per item, with `item.<field>`; `{ today: 7 }` is a date, `{ now: true }` the time; anything else is a literal (or write { value: ... }).',
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
  sign: z.string().optional().meta({ description: 'Phase 6: person steps need an e-signature with this meaning, e.g. "Reviewed and approved for filing".' }),
  review: z.union([
    z.enum(['document', 'table', 'diff', 'form']),
    z.strictObject({
      kind: z.enum(['document', 'table', 'diff', 'form']),
      record: z.string().regex(/^case\.[A-Za-z_]\w*$/, { error: 'expected a Ref case field like case.document' }).optional(),
      items: z.string().regex(/^case\.[A-Za-z_]\w*$/, { error: 'expected a List case field like case.items' }).optional(),
    }),
  ], { error: 'expected document, table, diff, form, or { kind, record | items }' }).optional()
    .meta({ description: 'Phase 6: how the person reviews it; default chosen from what the step reads and writes.' }),
  quotes: z.enum(['required'], { error: 'expected required' }).optional()
    .meta({ description: 'Agent steps: `required` makes every value the agent writes carry the exact words of a tool result it was read from.' }),
}).meta({ title: 'MemWise step', description: 'The front matter of workflows/<id>/steps/<state>.md.' });

export const caseFormat = z.strictObject({
  case: z.string(),
  fields,
  types: z.record(z.string(), fields).optional().meta({ description: 'Small record types used by fields.' }),
}).meta({ title: 'MemWise case type', description: 'workflows/<id>/case.yaml.' });

export const entityFormat = z.strictObject({
  entity: z.string(),
  title: z.string().optional().meta({ description: 'How a record is named: "{site_number} · {name}". Default the first Text field.' }),
  parent: z.string().optional().meta({ description: 'A one relationship or Ref field: the page-tree parent.' }),
  fields,
  relationships: z.record(z.string(), relationship).optional(),
  calculated: z.record(z.string(), calculated).optional().meta({ description: 'Rollups over many relationships and row formulas, computed in SQL.' }),
  links: z.record(z.string(), entityLink).optional().meta({ description: 'The same thing in another domain, by its key (edc.Site).' }),
  lifecycle: z.union([names, lifecycleChart], { error: 'expected a list of states, or { initial, states, transitions }' }).optional(),
  invariants: z.array(condition).optional().meta({ description: 'Conditions that should hold; a broken one raises a flag, never blocks a write.' }),
  ownership: z.record(z.string(), z.string()).optional().meta({ description: 'field → owner (a plugin id or domain).' }),
  page: pageLayoutFormat.optional().meta({ description: 'The record page layout.' }),
  key: z.union([z.string(), names]).optional().meta({ description: 'Fields that identify a record (Text, Number or Ref, required): unique, and creating one that exists returns it.' }),
  keep_from_chat: z.boolean().optional().meta({ description: 'A chat anchored to a record may keep rows of this entity (with the person\'s permission).' }),
  list: names.optional().meta({ description: 'The columns of its records table by default: fields, calculated fields or status. Default: its short fields.' }),
  scope: z.enum(['app', 'project']).optional().meta({ description: 'app: records shared by every project of the app (a Sponsor); project (the default): each project has its own.' }),
}).meta({ title: 'MemWise entity type', description: 'domain/entities/<name>.yaml or domains/<id>/entities/<name>.yaml.' });

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
  records: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).optional()
    .meta({ description: 'Phase 6: records to create before the run, by entity (bare in this domain, or a key); each may give `id` and `status`.' }),
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

// ---------------------------------------------------------------- workspace, domains, pages, views (Phase 6)

export const workspaceFormat = z.strictObject({
  workspace: z.string().optional().meta({ description: "The organisation's name; default the project folder's." }),
  roles: rolesFormat.shape.roles.optional().meta({ description: 'The roles people can have, in every domain.' }),
  policy: policyFormat.optional().meta({ description: "Workspace house rules: the layer above every domain's." }),
  storm_limit: z.number().int().positive().optional().meta({ description: 'Firings from one trigger within a minute above this are held for a person. Default 25.' }),
}).meta({ title: 'MemWise workspace', description: 'workspace.yaml: the organisation, its roles and house rules.' });

export const domainFormat = z.strictObject({
  domain: z.string().optional().meta({ description: 'The domain id, the folder name.' }),
  name: z.string().optional(),
  description: z.string().optional(),
  owner: z.string().optional().meta({ description: 'Role that gets flags and held triggers, and owns triggered cases by default.' }),
  regulated: z.boolean().optional().meta({ description: 'Regulated mode: e-signatures, required reasons, audit export.' }),
  qa: z.string().optional().meta({ description: 'Regulated domains: the role whose signature makes a change request live (QA). Default the owner.' }),
  retention: duration.optional().meta({ description: 'How long records are kept, e.g. 25y.' }),
  accepts_from: names.optional().meta({ description: "Domains whose workflows may start or call this domain's workflows." }),
  intake: z.strictObject({ address: z.string() }).optional().meta({ description: "Incoming messages to this address start the domain's message triggers." }),
  home: z.strictObject({
    ask: z.string().optional().meta({ description: 'The heading above the question box, e.g. "What does the literature say?".' }),
    placeholder: z.string().optional().meta({ description: 'The hint inside the question box.' }),
    entity: z.string().optional().meta({ description: 'The entity a question becomes a draft of (a bare name in this domain), e.g. Topic. It needs a lifecycle. Without one, a question makes a draft page.' }),
    question: z.string().optional().meta({ description: "The draft's Text field the question goes into (needed with entity)." }),
    name: z.string().optional().meta({ description: "The draft's Text field for a short name; the chat writes a better one." }),
    page: z.string().optional().meta({ description: "The draft's Text field the chat writes its page into (markdown, laid out for the question, with chart blocks)." }),
    suggested: z.array(z.string()).optional().meta({ description: 'Questions offered under the box.' }),
  }).optional().meta({ description: "The domain's home: a question box. Asking opens a chat with a draft record beside it; recent drafts and the records being worked on are listed under the box." }),
  pages: z.strictObject({
    refresh: z.string().optional().meta({ description: 'The playbook that refreshes a kept page in this app (started with { page, reason }); default the built-in refresh-page.' }),
    reviewer: z.string().optional().meta({ description: "The role that reviews answer changes, besides the page's owner." }),
    every: z.string().optional().meta({ description: 'The default schedule when a page is kept: mon … sun, daily or month.' }),
  }).optional().meta({ description: 'Pages built from questions: how kept pages are refreshed and who reviews answer changes.' }),
}).meta({ title: 'MemWise domain', description: 'domains/<id>/domain.yaml (or domain/domain.yaml for the default domain).' });

const viewSort = z.array(z.union([
  z.string().meta({ description: 'A field; `-field` sorts descending.' }),
  z.strictObject({ field: z.string(), desc: z.boolean().optional() }),
])).meta({ description: 'Sort order: [-received_at] or [{ field: received_at, desc: true }].' });

const inlineView = z.strictObject({
  entity: z.string(),
  filter: condition.optional(),
  sort: viewSort.optional(),
  group: z.string().optional(),
  columns: names.optional(),
  layout: z.enum(['table', 'board']).optional(),
});

export const viewFormat = z.strictObject({
  view: z.string().optional().meta({ description: 'The view id; default the file name.' }),
  title: z.string().optional(),
  entity: z.string().meta({ description: 'The entity type, bare in this domain or by key.' }),
  filter: condition.optional(),
  sort: viewSort.optional(),
  group: z.string().optional().meta({ description: 'A field to group by (a board groups by status by default).' }),
  columns: names.optional(),
  layout: z.enum(['table', 'board']).optional().meta({ description: 'Default table.' }),
}).meta({ title: 'MemWise view', description: 'domains/<id>/views/<id>.yaml: a shared, saved query on one entity type.' });

const dashboardValue = z.union([
  z.strictObject({ count: z.string(), where: condition.optional() }),
  z.strictObject({ percent: z.string(), where: condition, of: condition.optional().meta({ description: 'Which rows make 100% (default all of them).' }) }),
  z.strictObject({ sum: z.string(), field: z.string(), where: condition.optional() }),
  z.strictObject({ avg: z.string(), field: z.string(), where: condition.optional() }),
], { error: 'expected { count | percent | sum | avg: <Entity>, where, field }' });

/** A dashboard block, as written: `{ kpi }`, `{ table }`, `{ list }`, `{ heatmap }` or `{ text }` (the parser checks which). */
const dashboardBlock = z.record(z.string(), z.unknown())
  .meta({ description: 'kpi: { label, value: { count | percent | sum | avg: <Entity>, where, field, of }, target }, table: { title, view }, list: { title, view }, heatmap: { rows, columns }, chart: { kind, entity, where, by | label, value, low, high, unit, title }, text: markdown.' });

export const pageFormat = z.strictObject({
  page: z.string().optional().meta({ description: 'The page id; default the file name.' }),
  title: z.string(),
  description: z.string().optional(),
  under: z.union([z.string(), z.strictObject({ entity: z.string() })]).optional()
    .meta({ description: 'Hang the page under each record of this entity type in the page tree.' }),
  params: z.record(z.string(), typeExpr).optional().meta({ description: 'Parameters, e.g. study: Ref<Study>, bound from the record it hangs under.' }),
  blocks: z.array(dashboardBlock),
}).meta({ title: 'MemWise page', description: 'domains/<id>/pages/<id>.yaml: a dashboard.' });

/** The parts of a dashboard block, checked one by one by the page parser. */
export const dashboardBlockFormats = {
  kpi: z.strictObject({ label: z.string(), value: dashboardValue, target: z.number().optional(), format: z.enum(['number', 'percent']).optional() }),
  table: z.strictObject({ title: z.string().optional(), view: z.union([z.string(), inlineView]) }),
  list: z.strictObject({ title: z.string().optional(), view: z.union([z.string(), inlineView]) }),
  heatmap: z.strictObject({
    title: z.string().optional(),
    rows: z.strictObject({ entity: z.string(), where: condition.optional(), label: z.string().optional() }),
    columns: z.array(z.strictObject({ label: z.string(), value: z.string() })),
  }),
  text: z.string(),
  chart: z.strictObject({
    kind: z.enum(['bar', 'line', 'donut', 'interval']),
    entity: z.string(),
    where: condition.optional(),
    by: z.string().optional().meta({ description: 'bar, line, donut: count the records per value of this field.' }),
    title: z.string().optional(),
    label: z.string().optional().meta({ description: 'interval: each row\'s label, a template: "{intervention} vs {comparator}".' }),
    value: z.string().optional().meta({ description: 'interval: the field with the value.' }),
    low: z.string().optional().meta({ description: 'interval: the field with the interval\'s low end.' }),
    high: z.string().optional().meta({ description: 'interval: the field with the interval\'s high end.' }),
    unit: z.string().optional().meta({ description: 'interval: the field with the unit.' }),
  }),
} as const;

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

// ---------------------------------------------------------------- apps and projects (26 §3)

const templateCard = z.strictObject({
  title: z.string(),
  description: z.string().optional().meta({ description: 'The line under the title, e.g. "Many sites, visits".' }),
  without: names.optional().meta({ description: 'Template paths a project made from this card leaves out: workflows/<id>, pages/<id>, views/<id>.' }),
  settings: z.record(z.string(), z.unknown()).optional().meta({ description: 'Initial project settings.' }),
});

export const appFormat = z.strictObject({
  app: z.string().optional().meta({ description: 'The app id, the domain folder name.' }),
  title: z.string().optional().meta({ description: 'The app name people see, e.g. eTMF. Default the domain name.' }),
  version: z.number().int().positive().optional().meta({ description: 'The template version; publishing a template update makes the next one. Default 1.' }),
  description: z.string().optional(),
  nouns: z.strictObject({ one: z.string(), many: z.string() }).optional()
    .meta({ description: 'What a project is called in this app, e.g. { one: study, many: studies }.' }),
  home: z.strictObject({
    title: z.string(),
    link: z.string().optional(),
    columns: z.array(z.union([
      z.strictObject({ label: z.string(), value: dashboardValue, format: z.enum(['number', 'percent']).optional() }),
      z.strictObject({ label: z.string(), setting: z.string().meta({ description: "A key of each project's settings, e.g. phase." }) }),
    ])).optional().meta({ description: 'One row per project: { label, value: { count | percent | sum | avg: <Entity>, where } } read in that project, or { label, setting }.' }),
    next: z.string().optional().meta({ description: 'The setting holding each project\'s next milestone, { label, date }.' }),
  }).optional()
    .meta({ description: 'The app home, a page across its projects: { title: TMF across studies, link: All studies, columns }.' }),
  templates: z.record(z.string(), templateCard).optional().meta({ description: 'The template cards shown in New project, by id.' }),
}).meta({ title: 'MemWise app', description: 'domains/<id>/app.yaml: the domain as a template for projects.' });

const projectPerson = z.strictObject({
  email: z.string(),
  name: z.string().optional(),
  roles: z.union([z.string(), names]),
  note: z.string().optional().meta({ description: 'Shown beside the role, e.g. owner.' }),
});

const projectConnection = z.strictObject({
  title: z.string().optional(),
  plugin: z.string().optional().meta({ description: 'The installed plugin it goes through.' }),
  access: z.enum(['read', 'write']).optional(),
  settings: z.record(z.string(), z.unknown()).optional().meta({ description: 'Per-project settings (a mailbox, a folder), never credentials.' }),
});

export const projectFormat = z.strictObject({
  project: z.string().optional().meta({ description: 'The project id, the folder name.' }),
  app: z.string().meta({ description: 'The app (domain id) this project is a copy of.' }),
  also: names.optional().meta({ description: "Other apps this project also runs, at their current versions (a firm's GST, income tax and notices on the same clients). Their records of type scope: project live in this project too." }),
  version: z.number().int().positive().optional().meta({ description: "The app version its template was taken from. Default the app's current version." }),
  name: z.string(),
  template: z.string().optional().meta({ description: 'The template card it was made from (an id in app.yaml templates).' }),
  copied_from: z.string().optional().meta({ description: 'The project it was copied from (no records are copied).' }),
  study: z.string().optional().meta({ description: 'The study key linking projects across apps, e.g. MW-301.' }),
  status: z.enum(['draft', 'active', 'archived']).optional().meta({ description: 'The status it starts in; default active. Nothing runs in a draft.' }),
  people: z.array(projectPerson).optional().meta({ description: 'People and their roles in this project.' }),
  connections: z.record(z.string(), projectConnection).optional().meta({ description: 'Connections the project uses, by id.' }),
  without: names.optional().meta({ description: 'Template paths left out: workflows/<id>, pages/<id>, views/<id>.' }),
  settings: z.record(z.string(), z.unknown()).optional(),
}).meta({ title: 'MemWise project', description: 'projects/<id>/project.yaml: one copy of an app, with overrides/ holding whole files that replace the template\'s.' });

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
  workspace: workspaceFormat,
  domain: domainFormat,
  page: pageFormat,
  view: viewFormat,
  app: appFormat,
  project: projectFormat,
} as const;
export type FormatName = keyof typeof formats;

/** JSON Schemas for each file format (draft 2020-12). `bun run schemas` writes them to schemas/. */
export const jsonSchemas = Object.fromEntries(
  Object.entries(formats).map(([name, schema]) => [name, z.toJSONSchema(schema, { io: 'input' })]),
) as unknown as Record<FormatName, Record<string, unknown>>;
