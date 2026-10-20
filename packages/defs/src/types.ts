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
  relationships: Record<string, { cardinality: 'one' | 'many'; target: string }>;
  lifecycle?: string[];
  /** field -> owner (a plugin id or `domain`). */
  ownership?: Record<string, string>;
  file: string;
  hash: string;
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
 */
export type ArgSource = { case: string } | { value: unknown };

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
  /** The Markdown body: the instructions in the expert's own words. */
  instructions: string;
  file: string;
  hash: string;
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
  workflows: Record<string, WorkflowDef>;
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
