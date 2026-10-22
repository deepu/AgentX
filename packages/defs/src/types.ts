/**
 * The definition model: what the files in a project folder parse into.
 *
 * PHASE 1 CONTRACT. Every kernel package codes against these shapes. Change them only
 * additively (new optional fields); a breaking change has to be made in every package.
 *
 * Project folder layout (docs/memwise/05-workflows.md §2, 04-domain-and-data.md §3):
 *
 *   <project>/
 *     domain/
 *       policy.yaml               domain policy layer
 *       entities/*.yaml           entity types
 *     workflows/<id>/
 *       workflow.yaml             the shape
 *       case.yaml                 the case type
 *       policy.yaml               workflow policy layer (optional)
 *       steps/<state>.md          one step per state that has work; front matter + prose
 *       examples/*.yaml           example cases (the acceptance tests)
 */

// ---------------------------------------------------------------- shared vocabularies

/** Effect classes, in order of severity (06 §3). A tool without a declared class counts as `irreversible`. */
export const EFFECT_CLASSES = ['read', 'draft', 'write', 'outbound', 'irreversible'] as const;
export type EffectClass = (typeof EFFECT_CLASSES)[number];

export type Performer = 'agent' | 'person' | 'external' | 'system';
export type Strictness = 'strict' | 'guided' | 'open';
/**
 * Which engine runs an agent step (Phase 3, D17): `step` our own journaled loop (the default);
 * `open` the open engine, i.e. a chat with the person (05 §3, 09 §3). An open-engine step is a
 * conversation: the run waits on it like a person step, and the chat ends it with an outcome.
 */
export type StepEngine = 'step' | 'open';

/** Milliseconds. Files write durations as `30s`, `10m`, `3d`, `1h30m`. */
export type DurationMs = number;

// ---------------------------------------------------------------- value types (04 §4)

export const SCALAR_TYPES = [
  'Text', 'Number', 'Boolean', 'Money', 'Date', 'DateTime', 'Duration', 'Percentage',
  'PersonName', 'Email', 'Phone', 'Address', 'File', 'Image', 'Document', 'TimeSeries',
] as const;
export type ScalarTypeName = (typeof SCALAR_TYPES)[number];

/** A parsed type expression: `Money`, `Identifier(GSTIN)`, `Quantity(kg)`, `Enum[a, b]`, `List<Flag>`, `Ref<Customer>`. */
export type ValueType =
  | { kind: 'scalar'; name: ScalarTypeName }
  | { kind: 'identifier'; scheme: string }
  | { kind: 'quantity'; unit: string }
  | { kind: 'enum'; values: string[] }
  | { kind: 'list'; of: ValueType }
  | { kind: 'ref'; entity: string }
  /** A record type declared in the case file's `types:` section, or an entity type name. */
  | { kind: 'named'; name: string };

/** Money is never a bare float. */
export interface Money { amount: number; currency: string }

export interface FieldDef {
  type: ValueType;
  /** The type expression exactly as written, for messages and round-tripping. */
  typeSource: string;
  required?: boolean;
  description?: string;
  /** Roles allowed to see the field (field-level access, enforced from Phase 2). */
  access?: string[];
  /** Phase 6 (24 §4): false exempts the field from the regulated reason rule. Default true in a regulated domain. */
  controlled?: boolean;
  /**
   * Literature (25 §4, D82): a Text field whose value must be words of another record's Text
   * field: `quote_of: article.abstract` is `{ ref: 'article', field: 'abstract' }`. Checked on
   * every write; a value not found there raises a flag on the record.
   */
  quoteOf?: { ref: string; field: string };
}

export interface RecordTypeDef { name: string; fields: Record<string, FieldDef> }

// ---------------------------------------------------------------- case and entity types

/** `case.yaml` */
export interface CaseTypeDef {
  /** `case: client_intake` */
  id: string;
  fields: Record<string, FieldDef>;
  /** Small record types used by fields, e.g. `Flag`. */
  types: Record<string, RecordTypeDef>;
  file: string;
  hash: string;
}

/** `domain/entities/*.yaml` (generated tables come in Phase 2). */
export interface EntityTypeDef {
  entity: string;
  fields: Record<string, FieldDef>;
  /** Phase 6: `via` names the inverse of a `many` relationship (24 §4). */
  relationships: Record<string, { cardinality: 'one' | 'many'; target: string; via?: string }>;
  /** The state names (both the list form and the statechart form). */
  lifecycle?: string[];
  /** field -> owner (a plugin id or `domain`). */
  ownership?: Record<string, string>;
  file: string;
  hash: string;

  // ---- Phase 6 (docs/memwise/24-phase-6-interfaces.md §4); the loader always sets `domain`.
  /** The domain it belongs to (`domain` for the default domain). */
  domain?: string;
  /** How a record is named: `{site_number} · {name}`. */
  title?: string;
  /** A `one` relationship (or Ref field) naming the page-tree parent. */
  parent?: string;
  calculated?: Record<string, import('./domain-types.ts').CalculatedFieldDef>;
  links?: Record<string, import('./domain-types.ts').EntityLinkDef>;
  /** The lifecycle as a statechart (the list form is converted, with `fromList`). */
  lifecycleChart?: import('./domain-types.ts').LifecycleDef;
  invariants?: string[];
  /** The record page layout as written; absent: `defaultPageLayout`. */
  page?: import('./domain-types.ts').PageLayoutDef;

  // ---- Literature (docs/memwise/25-literature-poc.md §3, §6)
  /**
   * D80: the fields that identify a record (`key: [pmid]`): unique in the store, and a create
   * with a key that exists returns that record (`existed: true`) instead of making another.
   */
  key?: string[];
  /** D83: a record chat may keep rows of this entity (`keep_from_chat: true`). */
  keepFromChat?: boolean;
  /**
   * The columns its records table shows when nobody chose any (`list: [journal, year, status]`):
   * fields, calculated fields or `status`. Absent: short fields chosen from the records.
   */
  list?: string[];

  // ---- Stage 3 (docs/memwise/26-projects-and-pages.md §3, D92)
  /**
   * `scope: app`: records shared by every project of the app (a Sponsor, a Person who is PI on
   * several studies); their table has no project column. Absent: `project` (the default).
   */
  scope?: import('./project-types.ts').EntityScope;
}

// ---------------------------------------------------------------- policy files (08 §2)

/** How an effect is treated, in order of strictness. A lower layer may only move right. */
export const TREATMENTS = ['allow', 'preview', 'approve', 'deny'] as const;
export type Treatment = (typeof TREATMENTS)[number];

/**
 * One policy layer as written (`domain/policy.yaml`, `workflows/<id>/policy.yaml`, or the
 * `policy:` block of a step's front matter). Every key is optional; absent means "inherit".
 */
export interface PolicyDoc {
  /** `policy: intake-domain`; defaults to the file's place. */
  name?: string;
  effects?: Partial<Record<EffectClass, Treatment>>;
  tools?: {
    /** If set, only these tools (intersected down the layers). */
    allow?: string[];
    deny?: string[];
    /** Tools the step must call before an outcome counts (workflow and step layers). */
    require?: string[];
    /** Per-tool tightening. */
    rules?: Record<string, { treatment?: Treatment; rateLimit?: { count: number; perMs: DurationMs } }>;
  };
  budgets?: { tokens?: number; timeMs?: DurationMs; modelCalls?: number; money?: Money };
  /** Model roles the layer permits. */
  modelRoles?: string[];
  taint?: { enabled?: boolean; outboundWhenTainted?: Treatment };
  /** Roles that may decide effect approvals (Phase 2); compiled tighten-only (intersection). */
  approvals?: { by?: string[] };
  file?: string;
}

// ---------------------------------------------------------------- steps (05 §2)

export type WriteSource =
  /**
   * `from: tool gst.validate_gstin` - the written value must deep-equal a value found in a
   * result of that tool in this step run (the whole result or any field at any depth; a
   * boolean or number must be the whole result or the top-level key named like the write),
   * or, with the object form `{ tool, field }`, the value at that dotted path of a result.
   */
  | { kind: 'tool'; tool: string; field?: string }
  /** The agent's judgement (default for agent steps). */
  | { kind: 'judgement' }
  /** A person enters it (person and external steps). */
  | { kind: 'person' };

/**
 * Where a system step's tool argument comes from (`map:` in the front matter): `case.<path>`
 * reads the case (`{ case: 'client_name' }`, the path without `case.`); anything else is a literal.
 * Literature (25 §3): `item.<path>` reads the item of a tool called once per item (`each:`;
 * `{ item: '' }` is the whole item), `{ today: <days> }` is a Date (today plus that many days, in
 * the local time zone, `YYYY-MM-DD`) and `{ now: true }` a DateTime, both as of the step's start.
 */
export type ArgSource = { case: string } | { value: unknown } | { item: string } | { today: number } | { now: true };

export interface WriteDef {
  field: string;
  type: ValueType;
  typeSource: string;
  from: WriteSource;
  required?: boolean;
}

/** `steps/<state>.md`: typed front matter plus prose instructions. */
export interface StepDef {
  /** The state this step belongs to (the file name without `.md`). */
  id: string;
  title: string;
  performer: Performer;
  strictness: Strictness;
  /** Paths read from the case, e.g. `case.pan`, `case.documents`. */
  reads: string[];
  writes: Record<string, WriteDef>;
  tools: { allowed: string[]; required: string[] };
  /** A model role ("checker"), never a model name. Required for agent steps. */
  model?: string;
  budget?: { tokens?: number; timeMs?: DurationMs; modelCalls?: number };
  /** Checkpoint rules in prose; each is judged by the verifier role before an outcome counts. */
  checkpoint: string[];
  outcomes: string[];
  /** Optional extra policy layer for this step (merged with the layer derived from the fields above). */
  policy?: PolicyDoc;
  /** Role that does (or decides) a person or external step (Phase 2). */
  assignee?: string;
  /** System steps: the arguments of each tool call, by tool then argument, in call order (Phase 2). */
  map?: Record<string, Record<string, ArgSource>>;
  /** Agent steps: `open` runs the step as a conversation in chat (Phase 3). Absent means `step`. */
  engine?: StepEngine;
  /**
   * System steps: the outcome is this field of this required tool's result (Phase 3), and must
   * be one of the step's outcomes. Front matter: `outcomeFrom: { tool: playbooks.check_draft, field: outcome }`.
   */
  outcomeFrom?: { tool: string; field: string };
  /**
   * External and person steps: the extraction the form may run while the step waits (Phase 5,
   * D68). Front matter: `extract: { tool, documents, fields, min_confidence }`.
   */
  extract?: ExtractDef;
  /** Phase 6 (24 §9): person steps: the meaning of the e-signature submitting needs. */
  sign?: string;
  /** Phase 6 (24 §11): how the step is reviewed; absent: chosen from what it reads and writes. */
  review?: import('./domain-types.ts').ReviewDef;
  /**
   * Literature (25 §3): system steps: tools called once per item of a List case field, by tool
   * then the field's path without `case.` (front matter: `map: { <tool>: { each: case.<field>, … } }`).
   */
  each?: Record<string, string>;
  /**
   * Literature (25 §4, D81): agent steps: `required` makes every judgement write carry the exact
   * words it was read from (`quotes` on `step.finish`). Quotes are always checked when given.
   */
  quotes?: 'required';
  /** The Markdown body: the instructions in the expert's own words. */
  instructions: string;
  file: string;
  hash: string;
}

/** `extract:` on an external or person step (23 §5). */
export interface ExtractDef {
  /** A tool that is `read` in the step's effective policy (quarantined reading allowed). */
  tool: string;
  /** The `List<Document>` (or `Document`) write whose files it reads. */
  documents: string;
  /** Writes it may fill, by the result's field name; `{ legal_name: client_name }` maps a result name to a write. */
  fields: Record<string, string>;
  /** Suggestions at or above this (and found in the document) are pre-filled. Default 0.8. */
  minConfidence: number;
}

// ---------------------------------------------------------------- workflows (05 §1-2)

export interface WaitDef {
  /** Send a reminder after this long in the state (Phase 2 delivers it; Phase 1 records the timer). */
  remindMs?: DurationMs;
  /** `timeout: 7d → needs_person` */
  timeout?: { afterMs: DurationMs; target: string };
}

export interface StateDef {
  name: string;
  /** outcome or event name -> target state name, or `end`. */
  on: Record<string, string>;
  wait?: WaitDef;
  /** Set when `steps/<name>.md` exists. A state without a step file is a wait state (waits for an outside event). */
  step?: string;
  /** Role whose attention a wait state (e.g. `needs_person`) needs (Phase 2). */
  assignee?: string;
  /** Phase 6: a hand-off block (start, call, for_each, wait_until; 24 §8). A state with a block has no step file. */
  block?: import('./domain-types.ts').BlockDef;
}

/** A loaded, parsed workflow folder. This whole object is the run's definition snapshot (D36). */
export interface WorkflowDef {
  /** `workflow: client-intake` */
  id: string;
  version: number;
  title?: string;
  /** Role that gets attention items for this workflow: stopped runs, needs_person (Phase 2). */
  owner?: string;
  start: string;
  states: Record<string, StateDef>;
  /** Keyed by state name. */
  steps: Record<string, StepDef>;
  caseType: CaseTypeDef;
  policy?: PolicyDoc;
  examples: ExampleCase[];
  /** Folder, relative to the project root. */
  dir: string;
  /** sha256 over every file in the folder (sorted path + content); identifies this exact definition. */
  hash: string;
  /**
   * Phase 4: set when the workflow comes from a plugin, referenced through its binding (`dir` is
   * then inside `plugins/`, and `hash` covers the plugin's folder and the binding), or was forked
   * from one into `workflows/` (`forked_from:` in workflow.yaml).
   */
  origin?: import('./plugin-types.ts').WorkflowOrigin;
  /** Phase 6: the domain it belongs to (`domain` for the default domain). The loader always sets it. */
  domain?: string;
  /** Phase 6: what starts it (`starts_on:`, 24 §7). */
  startsOn?: import('./domain-types.ts').TriggerDef[];
  /**
   * Stage 3 (26 §3): set on a project's own copy of an app playbook (the template at the version
   * the project took, plus its overrides). Runs pin it; its policy is the project's app layer.
   */
  project?: string;
  /** Stage 3: files of the folder that come from the project's `overrides/` (relative to the folder). */
  overridden?: string[];
}

/** The final pseudo-state every workflow may transition to. */
export const END_STATE = 'end';

// ---------------------------------------------------------------- example cases (05 §12)

/** A scripted model turn, for deterministic runs without a live model. */
export interface ScriptedTurn {
  text?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
}

/** `examples/*.yaml`: an example case with expected results. */
export interface ExampleCase {
  name: string;
  description?: string;
  /** State to start in; defaults to the workflow's `start`. */
  startAt?: string;
  /** Initial case values (plain values; provenance `input`). */
  case: Record<string, unknown>;
  /** Stubbed results for tools, by tool name: one result for every call, or a list consumed in order. */
  tools?: Record<string, unknown | { results: unknown[] }>;
  /** Scripted model turns by model role. Omitted: the example needs a live model. */
  model?: Record<string, ScriptedTurn[]>;
  /** Answers to approval requests, by tool name. */
  approvals?: Record<string, 'approve' | 'reject'>;
  /**
   * Phase 6: records to create before the run, by entity key (bare in the workflow's domain), each
   * with an optional `id` (referenced as `Ref` values) and `status`.
   */
  records?: Record<string, Record<string, unknown>[]>;
  /**
   * Answers to person and external steps, by state (Phase 2): one answer for every visit, or a
   * list consumed in order. A run waiting in a state without an answer left is where it stops.
   */
  submit?: Record<string, ExampleSubmission | ExampleSubmission[]>;
  expect: {
    /** Outcome of the first step run (the step at `startAt`). */
    outcome?: string;
    /** State the run is in when it stops (a wait state, or `end`). */
    state?: string;
    /** Case values after the run (deep-equal on the listed fields only). */
    writes?: Record<string, unknown>;
    /** Number of times each tool's effect actually happened. */
    effects?: Record<string, number>;
    /**
     * Rows in the domain tables after the run, by entity type (Phase 2): a count, or the rows
     * expected (each matched on the listed fields only; the count must match too).
     */
    entities?: Record<string, number | Record<string, unknown>[]>;
  };
  file: string;
}

/** A scripted answer to a person or external step in an example case. */
export interface ExampleSubmission {
  outcome: string;
  values?: Record<string, unknown>;
  comment?: string;
}

// ---------------------------------------------------------------- project

/** One role from `domain/roles.yaml` (Phase 2). */
export interface RoleDef { id: string; title: string; description?: string }

export interface ProjectDefs {
  root: string;
  domainPolicy?: PolicyDoc;
  /** `domain/roles.yaml`; empty when the project declares no roles. */
  roles: Record<string, RoleDef>;
  entities: Record<string, EntityTypeDef>;
  /** Authored workflows plus plugin workflows resolved through frozen bindings (Phase 4). */
  workflows: Record<string, WorkflowDef>;
  /** Phase 4: plugins installed in `plugins/`, by id (the newest version present). */
  plugins?: Record<string, import('./plugin-types.ts').InstalledPlugin>;
  /** Phase 4: frozen bindings (`domain/bindings/*.yaml`), by plugin id. */
  bindings?: Record<string, import('./plugin-types.ts').BindingDef>;
  /**
   * Phase 4: every installed version of every plugin, by id then version (a binding pins a
   * version, which need not be the newest in `plugins`).
   */
  pluginVersions?: Record<string, Record<string, import('./plugin-types.ts').InstalledPlugin>>;
  /** Phase 6: `workspace.yaml` (absent: a workspace named after the folder, no policy). */
  workspace?: import('./domain-types.ts').WorkspaceDef;
  /**
   * Phase 6: every domain, by id. The default domain (`domain`) is present whenever the project
   * has `domain/` or `workflows/`. `entities` is keyed by entity key (24 §2).
   */
  domains?: Record<string, import('./domain-types.ts').DomainDef>;
  /** Stage 3 (26 §3): every domain as an app, by domain id (`app.yaml`, or version 1 without one). */
  apps?: Record<string, import('./project-types.ts').AppDef>;
  /**
   * Stage 3: every project, by id: `projects/<id>/project.yaml`, plus one implicit project (id =
   * the domain id) for each app that has none. Each carries its effective definitions.
   */
  projects?: Record<string, import('./project-types.ts').MwProjectDef>;
}

// ---------------------------------------------------------------- checks (05 §8)

export type Severity = 'error' | 'warning';

export interface Diagnostic {
  severity: Severity;
  /** Stable code, e.g. `unreachable-state`, `unknown-tool`, `policy-loosened`. */
  code: string;
  message: string;
  /** File relative to the project root, and a 1-based line where known. */
  file?: string;
  line?: number;
  /** Dotted path inside the file, e.g. `steps.check.on.failed`. */
  path?: string;
}

/** What the checks need to know beyond the files: which tools are bound in the domain. */
export interface CheckEnvironment {
  /** Tool names bound in the domain, with their effect class (undefined = unclassified). */
  tools: Record<string, { effect?: EffectClass; /** JSON Schema of the arguments, when known (system-step `map` checks). */ inputSchema?: Record<string, unknown> }>;
  /**
   * Roles that exist (assignees, owners and approvers must reference one). `checkProject` fills
   * it from the project's `domain/roles.yaml` when not given; undefined means roles aren't checked.
   */
  roles?: string[];
}
