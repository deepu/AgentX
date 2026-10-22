/**
 * Plugins, bindings, mappings and identity resolution (Phase 4,
 * docs/memwise/22-phase-4-interfaces.md).
 *
 * PHASE 4 CONTRACT. `@memwise/runtime` and `@memwise/server-core` code against these shapes;
 * change them only additively.
 *
 * Project folder additions:
 *
 *   <project>/
 *     plugins/<slug>/<version>/      an installed plugin (a copy, never edited): inert until bound
 *       memwise-plugin.yaml          PluginManifest
 *       workflows/<id>/...           workflows in the plugin's own terms (requires.entities)
 *       skills/<name>/SKILL.md
 *       ...                          code the tools' routes run (MCP servers, commands)
 *     domain/bindings/<slug>.yaml    BindingDef: the frozen binding of one plugin into this domain
 *
 * `<slug>` is the plugin id with `/` replaced by `__` (`memwise/client-intake` →
 * `memwise__client-intake`). A binding draft (`drafts/<id>/`, kind `binding`) copies `domain/` only.
 */
import type { EffectClass, PolicyDoc, RoleDef, WorkflowDef } from './types.ts';

export const PLUGINS_DIR = 'plugins';
export const BINDINGS_DIR = 'domain/bindings';
export const PLUGIN_MANIFEST = 'memwise-plugin.yaml';
/** Id pattern: `<publisher>/<name>`, lower case. */
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/;

/** Who wrote the plugin; sets defaults later (06 §10). Imported Claude plugins are `community`. */
export type PluginTrust = 'first-party' | 'verified' | 'community' | 'local';

// ---------------------------------------------------------------- the manifest (06 §2)

/**
 * How a tool's code is reached (06 §6). The core decides the route, never the author:
 * - `builtin`: first-party code shipped with the app, found by name in the kernel's builtins;
 * - `mcp`: a tool of an MCP server the plugin declares (`mcp_servers`), by its name there;
 * - `command`: a subprocess per call: JSON arguments on stdin, a JSON result on stdout.
 */
export type ToolRoute =
  | { builtin: string }
  | { mcp: string; tool: string }
  | { command: string[]; timeoutMs?: number };

/** An MCP server a plugin brings, as in Claude's `.mcp.json`; or a source set up in the workspace. */
export type McpServerDef =
  | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { url: string; headers?: Record<string, string> }
  /** A connector the person set up in the app (a Craft "source"); the host resolves it, with its credentials. */
  | { source: string };

export interface McpToolAnnotationsDef {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface PluginToolDef {
  /** Dotted, globally unique once bound (`gst.validate_gstin`, imported: `<server>.<tool>`). */
  name: string;
  description: string;
  /** Declared class; absent = unclassified (irreversible until a binding classifies it, D29). */
  effect?: EffectClass;
  /** JSON Schema of the arguments; `input:` in YAML. */
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  quarantine?: boolean;
  idempotent?: boolean;
  secrets?: string[];
  /** MCP annotations of an imported tool, seeding its class (06 §3). */
  annotations?: McpToolAnnotationsDef;
  /** The capability this tool provides (§capabilities), if any. */
  capability?: string;
  run: ToolRoute;
}

/** A kind of record a connector exposes, so a binding can map it to a domain entity (04 §5). */
export interface RecordSourceDef {
  /** `contact` */
  name: string;
  title?: string;
  /** Lists records: the tool, and the dotted path of the array in its result (`contacts`; empty = the result itself). */
  list: { tool: string; items?: string; args?: Record<string, unknown> };
  /** Reads one record live (read-through): the tool and the argument that takes the key. */
  get?: { tool: string; arg: string; item?: string };
  /** The field holding the record's id in the connector. */
  key: string;
  /** Field → type expression (value types, as in entity files). */
  fields: Record<string, string>;
}

/** What a plugin expects of the domain's entities, in its own terms (`Client`), mapped at binding. */
export interface RequiredEntityDef {
  name: string;
  /** Field → type expression; `{ type, required, description }` in YAML. */
  fields: Record<string, { typeSource: string; required?: boolean; description?: string }>;
}

/** `memwise-plugin.yaml` */
export interface PluginManifest {
  id: string;
  /** Semver. */
  version: string;
  title: string;
  description?: string;
  trust: PluginTrust;
  /** Capabilities this plugin provides: name → the tool that provides it. */
  provides: { capabilities: Record<string, { tool: string }> };
  requires: {
    /**
     * Capabilities it needs: name → the tool name its workflows use for it (`as`). The binding
     * picks which bound tool provides it; `optional` ones may stay unfilled.
     */
    capabilities: Record<string, { as: string; optional?: boolean }>;
    entities: Record<string, RequiredEntityDef>;
    /** Roles its workflows name (assignee, owner, approvers), mapped to the domain's at binding. */
    roles: Record<string, RoleDef>;
  };
  /** By tool name. */
  tools: Record<string, PluginToolDef>;
  mcpServers: Record<string, McpServerDef>;
  /** Workflow folder names under `workflows/`. */
  workflows: string[];
  /** Skill folder names under `skills/`. */
  skills: string[];
  records: Record<string, RecordSourceDef>;
  /** Default policy layer (06 §3): the domain may tighten, never loosen (D30). */
  policy?: PolicyDoc;
  /** Declared only in Phase 4 (recorded with the binding; environments are built in Phase 7). */
  environment?: { runtime?: string; lockfile?: string; network?: string[] };
  /** Recorded, not acted on yet (components and pages: later phases; triggers: Phase 6). */
  components?: string[];
  pages?: string[];
  triggers?: unknown[];
  /** Where it came from when imported: a Claude plugin's `.claude-plugin/plugin.json`. */
  importedFrom?: { kind: 'claude-plugin'; name: string; version?: string };
  file: string;
}

/** A skill a plugin ships: `skills/<name>/SKILL.md`. */
export interface PluginSkill { name: string; description?: string; file: string; body: string }

/** A plugin as found in `plugins/<slug>/<version>/`. */
export interface InstalledPlugin {
  manifest: PluginManifest;
  /** Folder relative to the project root. */
  dir: string;
  /** sha256 over every file in the folder (as for workflows). */
  hash: string;
  skills: PluginSkill[];
  /** The plugin's workflows as written (its own terms); resolved through the binding into `ProjectDefs.workflows`. */
  workflows: Record<string, WorkflowDef>;
}

// ---------------------------------------------------------------- bindings (06 §4)

/** A deterministic transform (no model when a mapping runs, P1). Applied left to right. */
export type Transform =
  | 'trim' | 'lower' | 'upper' | 'digits' | 'squash'
  | { default: unknown }
  | { map: Record<string, unknown> }
  /** A number (or numeric text) as Money in this currency. */
  | { money: string }
  /** Text from several source fields: `"{first} {last}"`. Replaces `from`. */
  | { template: string }
  /**
   * Stage 6 (26 §9): the value is the id of another record of the same plugin's source `link`;
   * the kernel turns it into the domain record linked to it (a `Ref` field), or leaves the field
   * empty when that record isn't linked yet. Pure mappings leave the outside id as it is.
   */
  | { link: string };

export type MappingDirection = 'read' | 'write' | 'both';

export interface FieldMapping {
  /** Source field (dotted path into the record); absent with a `template` transform. */
  from?: string;
  transform?: Transform[];
  /** Default `read`. `write` and `both` are checked by a round trip at dry run; writing back is later (Phase 6). */
  direction?: MappingDirection;
}

export interface IdentityRules {
  /** Domain fields compared exactly after both sides are normalised (trim, lower case, no spaces); first key that matches decides. */
  keys: string[];
  /** Similarity on one domain field: at or above `auto` links, at or above `review` asks a person. */
  fuzzy?: { field: string; auto: number; review: number };
  /** A record matching nothing creates a domain record from the mapped fields. Default false (stays unlinked). */
  createMissing?: boolean;
}

/** How one of the plugin's record sources maps onto a domain entity. */
export interface RecordBinding {
  entity: string;
  /** Domain field → mapping. Fields of the source not mapped are kept under `<plugin namespace>.*`, never dropped. */
  fields: Record<string, FieldMapping>;
  identity: IdentityRules;
}

/** `domain/bindings/<slug>.yaml` */
export interface BindingDef {
  /** The plugin id. */
  plugin: string;
  /** The plugin version and folder hash this binding was made against (pinned: an upgrade is a new binding version). */
  pluginVersion: string;
  pluginHash: string;
  /** Bumped by every freeze; 0 in a draft that was never frozen. */
  version: number;
  frozen?: { by: string; at: string; runId?: string };
  /** Tool → confirmed class, or `off` (not bound). Tools not listed keep their declared class; unclassified ones count as irreversible. */
  tools: Record<string, { effect?: EffectClass; off?: boolean; reason?: string }>;
  /** Capability the plugin requires → the bound tool that provides it. */
  capabilities: Record<string, string>;
  /** Plugin entity → domain entity and field renames (plugin field → domain field). */
  entities: Record<string, { entity: string; fields: Record<string, string> }>;
  /** Plugin role → domain role. */
  roles: Record<string, string>;
  /** Record source → mapping onto a domain entity. */
  records: Record<string, RecordBinding>;
  /** The domain's tightening of the plugin's default policy. */
  policy?: PolicyDoc;
  /** The last dry run of this content. */
  dryRun?: { at: string; hash: string; passed: boolean; summary: string };
  /**
   * Stage 6 (26 §9): read the mapped record sources again this often (`sync: 15m`), refreshing the
   * fields the plugin owns on linked records, so a change outside becomes an entity event here.
   */
  sync?: { every: string; everyMs: number };
  file: string;
  hash: string;
}

/** `WorkflowDef.origin`: where a workflow in the domain comes from (06 §5). */
export interface WorkflowOrigin {
  /** `plugin`: referenced through a binding; `fork`: copied into `workflows/` and edited here. */
  kind: 'plugin' | 'fork';
  plugin: string;
  pluginVersion: string;
  bindingVersion?: number;
}

// ---------------------------------------------------------------- binding proposals and dry runs

/** What the proposer could not decide, for the person reviewing the binding. */
export interface BindingGap {
  kind: 'tool-unclassified' | 'capability-missing' | 'entity-unmapped' | 'field-unmapped' | 'role-unmapped' | 'record-unmapped' | 'type-mismatch';
  /** The plugin's name for the thing (tool, capability, `Client.tax_id`, role, record source). */
  subject: string;
  message: string;
  /** Candidates, best first. */
  suggestions?: string[];
}

export interface BindingProposal {
  binding: BindingDef;
  gaps: BindingGap[];
  /** Tools whose class came from: the manifest, MCP annotations, or nowhere (still unclassified). */
  classes: Record<string, { effect?: EffectClass; from: 'declared' | 'annotations' | 'binding' | 'none' }>;
}

/** One record pushed through a mapping at dry run (and in the review screen). */
export interface MappedRecord {
  source: string;
  externalId: string;
  /** The record as the source returned it ("before", for the binding review). */
  raw?: Record<string, unknown>;
  /** Domain field → value after the transforms. */
  values: Record<string, unknown>;
  /** Fields of the record no mapping uses, kept under the plugin's namespace. */
  extra: Record<string, unknown>;
  errors: string[];
  /** For `both`/`write` fields: values that don't survive the round trip. */
  roundTrip: string[];
}

/** `plugins.dry_run`: checks, the plugin's example cases through the binding, mappings on sample records. */
export interface BindingReport {
  plugin: string;
  draftId: string;
  hash: string;
  at: string;
  diagnostics: import('./types.ts').Diagnostic[];
  errors: number;
  warnings: number;
  examples: import('./draft-types.ts').ExampleOutcome[];
  records: MappedRecord[];
  /** Upgrades: how each resolved workflow changes against the live binding (structural diff). */
  impact?: import('./draft-types.ts').StructuralDiff[];
  outcome: 'passed' | 'failed';
  summary: string;
}

// ---------------------------------------------------------------- identity resolution (04 §6)

export type MatchMethod = 'key' | 'fuzzy' | 'person' | 'created';

export interface IdentityMatch {
  /** Domain record id, or none. */
  recordId?: string;
  score: number;
  method?: MatchMethod;
  /** Plain words: "same GSTIN", "name 0.82 similar". */
  reasons: string[];
  /** `link`: confident; `review`: a person decides; `none`: nothing close (created or left unlinked). */
  verdict: 'link' | 'review' | 'none';
}

/** A domain record's link to a record held by a plugin (`mw.identity_links`). */
export interface IdentityLink {
  id: string;
  entity: string;
  recordId: string;
  plugin: string;
  source: string;
  externalId: string;
  method: MatchMethod;
  score: number;
  reasons: string[];
  linkedBy?: string;
  at: string;
}

/** An uncertain match waiting for a person (`mw.identity_candidates`). */
export interface IdentityCandidate {
  id: string;
  entity: string;
  recordId: string;
  plugin: string;
  source: string;
  externalId: string;
  score: number;
  reasons: string[];
  /** The record's mapped values, as seen when the candidate was made. */
  external: Record<string, unknown>;
  /**
   * `rejected` is a person's "different" (the pair is never proposed again); `settled` is the
   * kernel's: no longer asked because the outside record or the domain record got its link
   * from this source otherwise.
   */
  status: 'pending' | 'confirmed' | 'rejected' | 'settled';
  decidedBy?: string;
  decidedAt?: string;
  createdAt: string;
}
