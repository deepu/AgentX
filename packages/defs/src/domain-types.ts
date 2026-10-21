/**
 * Domains and records (docs/memwise/24-phase-6-interfaces.md): the workspace, several domains,
 * entity pages, calculated fields, links between domains, lifecycles, triggers, hand-offs,
 * views, free pages and the condition language.
 *
 * PHASE 6 CONTRACT. Every kernel package codes against these shapes. Change them only
 * additively. Imports nothing at run time (safe for the app's bundles).
 */
import type { DurationMs, PolicyDoc } from './types.ts';

// ---------------------------------------------------------------- workspace and domains (24 §2)

/** The default domain's id: the project root's `domain/` and `workflows/` folders. */
export const DEFAULT_DOMAIN = 'domain';
export const DOMAIN_ID_PATTERN = /^[a-z][a-z0-9_]{0,30}$/;

/** `workspace.yaml` */
export interface WorkspaceDef {
  /** `workspace: Northlight CRO`; default the project folder's name. */
  name: string;
  /** Workspace house rules: the policy layer above every domain's. */
  policy?: PolicyDoc;
  /** Firings from one trigger within a minute above this are held (24 §7). Default 25. */
  stormLimit?: number;
  file?: string;
}

/** `domains/<id>/domain.yaml` (or `domain/domain.yaml` for the default domain). */
export interface DomainDef {
  id: string;
  /** Display name; default the id (the default domain: "Main"). */
  name: string;
  description?: string;
  /** Role that gets flags and held triggers, and owns triggered cases by default. */
  owner?: string;
  /** Regulated mode (24 §9). */
  regulated?: boolean;
  /** Retention of records, e.g. 25y (recorded and shown). */
  retentionMs?: DurationMs;
  /** Domains whose workflows may start or call this domain's workflows (24 §8). */
  acceptsFrom?: string[];
  /** Incoming messages (24 §10). */
  intake?: { address: string };
  /** The domain's home: a question box that opens a chat with a draft record beside it. */
  home?: DomainHomeDef;
  /** The domain's policy layer (`policy.yaml`). */
  policy?: PolicyDoc;
  /** Folder relative to the project root (`domains/etmf`, or `domain` for the default domain). */
  dir: string;
  /** Entity keys of its entity types. */
  entities: string[];
  /** Ids of its workflows. */
  workflows: string[];
  /** Free pages, by id (`pages/<id>.yaml`). */
  pages: Record<string, FreePageDef>;
  /** Shared views, by id (`views/<id>.yaml`). */
  views: Record<string, ViewDef>;
  file?: string;
}

/**
 * `home:` in domain.yaml: asking a question makes a draft of `entity` (its lifecycle's first
 * state) with the question in `question`, and opens a chat anchored to it; the chat fills the
 * draft in. Drafts are the "recent questions"; records past their first state are listed above them.
 */
export interface DomainHomeDef {
  ask?: string;
  placeholder?: string;
  /** Entity name as written (bare in its own domain, or a key). */
  entity: string;
  question: string;
  name?: string;
  /** Text field the chat writes the record's page into (markdown with chart blocks). */
  page?: string;
  suggested: string[];
}

/** A role granted in one domain, optionally limited to records (24 §2). */
export interface Grant {
  role: string;
  domain: string;
  /** `{ sponsor: 'spon_…' }`: rows whose `sponsor` column holds one of these ids. */
  scope?: Record<string, string[]>;
  /** Stage 3 (26 §3, D92): the one project of the domain it holds in; absent: every project. */
  project?: string;
}

// ---------------------------------------------------------------- entity additions (24 §4)

/** A relationship, as parsed (string `many Document` or `{ many: Document, via: site }`). */
export interface RelationshipDef {
  cardinality: 'one' | 'many';
  /** Entity name as written (bare in its own domain, or a key). */
  target: string;
  /** `many`: the target's field pointing back (inferred when unique). */
  via?: string;
}

export type RollupKind = 'count' | 'sum' | 'min' | 'max' | 'percent';

export type CalculatedFieldDef =
  | {
      kind: 'rollup';
      rollup: RollupKind;
      /** A `many` relationship of this entity. */
      of: string;
      /** sum / min / max: the related entity's field. */
      field?: string;
      /** A condition on the related rows (count, sum…: which rows count; percent: the numerator). */
      where?: string;
      description?: string;
    }
  | { kind: 'formula'; formula: string; description?: string };

/** `links: { edc.Site: { match, follow } }` */
export interface EntityLinkDef {
  /** The other entity's key, `edc.Site`. */
  target: string;
  /** This entity's field → the other's field. */
  match: Record<string, string>;
  /** The other's fields this entity shows, read through the link (read-only here). */
  follow: string[];
}

/** Who may make a lifecycle transition. */
export type TransitionActor =
  | { kind: 'step' }
  | { kind: 'role'; role: string }
  | { kind: 'source'; source: string }
  | { kind: 'system' };

export interface LifecycleTransitionDef {
  name: string;
  by: TransitionActor[];
  /** A condition on the record that must hold. */
  guard?: string;
  /** Regulated: needs a matching signature on the record in the case making it (24 §9). */
  signed?: boolean;
  /** The button's words, e.g. "Keep watching, every Monday" (default: the name). */
  label?: string;
  /** Shown as the page's main button. */
  primary?: boolean;
}

export interface LifecycleStateDef {
  name: string;
  /** transition name → target state. */
  on: Record<string, string>;
  /** Timers from entering the state. */
  after?: { afterMs: DurationMs; remind?: string; transition?: string }[];
}

/** The statechart form of `lifecycle:` (the list form is turned into one too). */
export interface LifecycleDef {
  initial: string;
  states: Record<string, LifecycleStateDef>;
  transitions: Record<string, LifecycleTransitionDef>;
  /** Written as a plain list: any role may move along it; transitions are `to_<state>`. */
  fromList?: boolean;
}

// ---------------------------------------------------------------- record pages (24 §6)

export type PageLayoutShape = 'single' | 'split' | 'sidebar';
export type PageArea = 'header' | 'main' | 'left' | 'right' | 'side' | 'below';

/** Chart kinds (25 §5): counts per value (`bar`, `line`, `donut`), or a value with its interval per row (`interval`). */
export type ChartKind = 'bar' | 'line' | 'donut' | 'interval';

/**
 * A chart on a record page (24 §6, 25 §5). `bar`/`line`/`donut` count the related rows of `of`
 * per value of `by`; `interval` draws one row per related record: `label` (a template over its
 * fields, "{intervention} vs {comparator}"), `value`, `low`, `high` and `unit` (field names).
 * `where` filters the related rows (condition language).
 */
export interface ChartBlockDef {
  kind: 'chart';
  chart: ChartKind;
  /** A many relationship (or calculated field) of the record. */
  of: string;
  by?: string;
  where?: string;
  title?: string;
  label?: string;
  value?: string;
  low?: string;
  high?: string;
  unit?: string;
}

export type PageBlock =
  | { kind: 'fields'; fields: string[] }
  | { kind: 'details' }
  /** A Document, File or Image field, or (25 §4) a Text field shown with its quotes lit. */
  | { kind: 'viewer'; field: string }
  /** A Text field written as markdown (with ```chart blocks), shown full width: a page the chat wrote. */
  | { kind: 'markdown'; field: string }
  | { kind: 'related'; relationships: string[] }
  | { kind: 'cases' }
  | { kind: 'lifecycle' }
  | ChartBlockDef
  | { kind: 'checks' }
  | { kind: 'notes' }
  | { kind: 'mentions' }
  | { kind: 'start' }
  | { kind: 'history' }
  /** 25 §5: tiles with the values of these calculated or Number fields. */
  | { kind: 'kpis'; fields: string[] }
  /** 25 §5: "Ask about this record": opens a chat anchored to it (no data). */
  | { kind: 'chat' };

export interface PageLayoutDef {
  layout: PageLayoutShape;
  /** Field names shown in the header beside the title. */
  header: string[];
  /** Blocks by area (no `header`). */
  areas: Partial<Record<Exclude<PageArea, 'header'>, PageBlock[]>>;
  /** True when made by `defaultPageLayout` (no `page:` section). */
  isDefault?: boolean;
}

// ---------------------------------------------------------------- views and free pages (24 §6)

export interface ViewDef {
  id: string;
  title: string;
  /** Entity key or a bare name in the view's domain. */
  entity: string;
  filter?: string;
  sort?: { field: string; desc?: boolean }[];
  group?: string;
  columns?: string[];
  layout: 'table' | 'board';
  file?: string;
}

export type DashboardValue =
  | { count: string; where?: string }
  | { percent: string; where: string; of?: string }
  | { sum: string; field: string; where?: string }
  | { avg: string; field: string; where?: string };

export type DashboardBlock =
  | { kind: 'kpi'; label: string; value: DashboardValue; target?: number; format?: 'number' | 'percent' }
  | { kind: 'table'; title?: string; view: string | Omit<ViewDef, 'id' | 'title'> }
  | { kind: 'list'; title?: string; view: string | Omit<ViewDef, 'id' | 'title'> }
  | {
      kind: 'heatmap'; title?: string;
      /** Entity whose records are the rows (with an optional filter); each column is a value per row. */
      rows: { entity: string; where?: string; label?: string };
      columns: { label: string; value: string }[];
    }
  | { kind: 'text'; markdown: string }
  | DashboardChartDef;

/**
 * A chart on a free page (25 §5): `bar`/`line`/`donut` count the records of `entity` (matching
 * `where`) per value of `by`; `interval` is one row per record with `label` (a template),
 * `value`, `low`, `high` and `unit`. Computed in SQL like the KPIs.
 */
export interface DashboardChartDef {
  kind: 'chart';
  chart: ChartKind;
  entity: string;
  where?: string;
  by?: string;
  title?: string;
  label?: string;
  value?: string;
  low?: string;
  high?: string;
  unit?: string;
}

/** `pages/<id>.yaml`: a dashboard (a definition; numbers come from Postgres). */
export interface FreePageDef {
  id: string;
  title: string;
  description?: string;
  /** Where it hangs in the page tree: under an entity type (each record) or nowhere (the domain's top). */
  under?: { entity: string };
  /** Parameters, e.g. `study: Ref<Study>`, bound from the record it hangs under. */
  params: Record<string, string>;
  blocks: DashboardBlock[];
  file?: string;
}

// ---------------------------------------------------------------- triggers (24 §7)

export type TriggerDef =
  | { kind: 'entered'; entity: string; state: string; with: Record<string, string>; as?: string }
  | { kind: 'created'; entity: string; with: Record<string, string>; as?: string }
  | { kind: 'changed'; entity: string; fields?: string[]; with: Record<string, string>; as?: string }
  | { kind: 'date'; entity: string; field: string; direction: 'before' | 'after'; offsetMs: DurationMs; with: Record<string, string>; as?: string }
  | { kind: 'every'; everyMs: DurationMs; at?: string; on?: string; with: Record<string, string>; as?: string }
  | { kind: 'message'; address: string; with: Record<string, string>; as?: string };

// ---------------------------------------------------------------- hand-offs (24 §8)

/** `with:` values: `case.<path>`, `item`, `item.<path>`, `record`, or a literal. */
export type HandoffArg = { case: string } | { item: string } | { record: true } | { value: unknown };

export interface StartBlock { kind: 'start'; workflow: string; with: Record<string, HandoffArg> }
export interface CallBlock { kind: 'call'; workflow: string; with: Record<string, HandoffArg>; returns: Record<string, string> }
export interface ForEachBlock {
  kind: 'for_each';
  /** A `List` case field. */
  items: string;
  as?: string;
  mode: 'start' | 'call';
  workflow: string;
  with: Record<string, HandoffArg>;
  /** call: `all`, `any`, or a number. */
  join: 'all' | 'any' | number;
}
export interface WaitUntilBlock { kind: 'wait_until'; record: string; condition: string }

export type BlockDef = StartBlock | CallBlock | ForEachBlock | WaitUntilBlock;

/** The events each block can send. */
export const BLOCK_EVENTS: Record<BlockDef['kind'], string[]> = {
  start: ['started'],
  call: ['failed'], // plus the child's outcomes
  for_each: ['done', 'failed', 'started'],
  wait_until: ['met'],
};

// ---------------------------------------------------------------- review (24 §11)

export type ReviewDef =
  | { kind: 'document'; record: string }
  | { kind: 'table'; items: string }
  | { kind: 'diff' }
  | { kind: 'form' };

// ---------------------------------------------------------------- the condition language (24 §5)

export type ConditionNode =
  | { op: 'num'; value: number }
  | { op: 'str'; value: string }
  | { op: 'bool'; value: boolean }
  | { op: 'null' }
  | { op: 'today' }
  | { op: 'now' }
  | { op: 'duration'; ms: DurationMs; source: string }
  | { op: 'name'; name: string; pos: number }
  | { op: 'fn'; name: 'days_since' | 'days_until' | 'coalesce' | 'lower' | 'length'; args: ConditionNode[] }
  | { op: 'not'; arg: ConditionNode }
  | { op: 'neg'; arg: ConditionNode }
  | { op: 'and' | 'or' | 'implies'; left: ConditionNode; right: ConditionNode }
  | { op: '=' | '!=' | '<' | '<=' | '>' | '>='; left: ConditionNode; right: ConditionNode }
  | { op: '+' | '-' | '*' | '/'; left: ConditionNode; right: ConditionNode }
  | { op: 'is_set' | 'is_not_set'; arg: ConditionNode }
  | { op: 'in'; arg: ConditionNode; values: ConditionNode[] };

export interface ParsedCondition {
  source: string;
  ast?: ConditionNode;
  /** Every name it reads. */
  names: string[];
  /** Problems, with a 0-based character position. */
  errors: { message: string; pos: number }[];
}

// ---------------------------------------------------------------- events and messages (24 §7, §10)

export type EntityEventKind = 'created' | 'changed' | 'entered';

export interface EntityEvent {
  id: string;
  seq: number;
  /** Entity key. */
  entity: string;
  recordId: string;
  kind: EntityEventKind;
  /** changed: the fields; entered: state, from, transition. */
  fields?: string[];
  state?: string;
  from?: string;
  transition?: string;
  /** Who made the change (the version's `by`). */
  by?: string;
  /** Stage 3: the record's project (absent for an app-scoped record). */
  project?: string;
  at: string;
}

/** The JSON an email inbound hook posts (24 §10). */
export interface InboundMessageBody {
  messageId: string;
  from: string;
  to: string | string[];
  subject?: string;
  text?: string;
  html?: string;
  receivedAt?: string;
  attachments?: { filename: string; contentType: string; contentBase64: string }[];
}
