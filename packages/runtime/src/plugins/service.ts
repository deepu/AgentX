// Plugins, bindings and identity (22 §2-§6, §8): the kernel's PluginsService, IdentityService,
// entityRecord, and the operations behind the bind-plugin playbook's tools (kernel-tools.ts).
// Files are `@memwise/defs`'s (plugins/, domain/bindings/, binding drafts); the kernel adds the
// database (installs, freezes, identity links), the gateway (reads through plugin tools) and runs.
import {
  actorLabel, PgBindingVersionStore, PgEntityStore, PgIdentityStore, PgPluginStore, PROJECT_COLUMN, projectScoped, tableOf, ulid, withActor,
  withRecordContext, withTransaction,
} from '@memwise/db';
import {
  applyDraft, BINDINGS_DIR, keyOf, bindingPath, DEFAULT_DOMAIN, hasRole, bindingToYaml, checkProject, compileRecordMapping, createBindingDraft, DraftConflictError,
  draftContentHash, draftDir, DraftStaleError, EFFECT_CLASSES, importClaudePlugin, installPlugin, listDrafts, loadDraft, loadProject,
  matchRecord, parseBindingFile, PLUGIN_MANIFEST, proposeBinding, readDraft, structuralDiff, updateDraftMeta, withDiscoveredTools,
  writeDraftFiles, writeDraftReport,
  type BindingDef, type BindingGap, type BindingReport, type Diagnostic, type DraftReport, type EffectClass, type EntityTypeDef,
  type ExampleOutcome, type IdentityCandidate, type InstalledPlugin, type MappedRecord, type PluginManifest, type ProjectDefs,
  type RecordBinding, type RecordSourceDef, type StepToken, type StructuralDiff, type ValueType, type WorkflowDef,
} from '@memwise/defs';
import { createToolGateway, type ToolContext, type ToolDefinition, type ToolGateway } from '@memwise/gateway';
import { PgEffectLedger, PgRateCounter } from '@memwise/db';
import { compilePolicy, extractDiagnostics, layersFor, PLATFORM_DEFAULTS, pluginLayers, violationsToDiagnostics } from '@memwise/policy';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type pg from 'pg';
import { domainTools } from '../domain-tools.ts';
import { loadDomainPolicy, projectPolicyLayers } from '../runs.ts';
import {
  BIND_PLUGIN, type Actor, type BindingView, type EntityRecordView, type IdentityService, type KernelChange, type PersonActor, type ResolveCounts, type SourceSync,
  type PluginDetail, type PluginsService, type PluginSummary, type RunRecord, type StartRunInput, type TestRunner,
} from '../types.ts';
import type {
  BindingOps, ClassifyToolsResult, DryRunResult, FreezeResult, InstallCheckResult, ProposeBindingResult, ResolveIdentityResult,
} from './kernel-tools.ts';
import { discoverMcpTools, type McpConnections } from './routes.ts';
import {
  boundPlugins, isReservedToolName, pluginPolicies, pluginTool, pluginToolEnvironment, toolClass, type BoundPlugin,
} from './tools.ts';

/** How soon a connector whose read failed is read again (Stage 6), when its interval is longer. */
const RETRY_FAILED_MS = 5 * 60_000;

export interface PluginServiceDeps {
  /** Absolute project folder. */
  projectDir: string;
  pool: pg.Pool;
  project(): Promise<{ project: ProjectDefs; diagnostics: Diagnostic[] }>;
  index(): Promise<Diagnostic[]>;
  /** startRun as the kernel itself. */
  startRun(input: StartRunInput): Promise<{ runId: string; caseId: string }>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  /** The live gateway (frozen bindings' tools bound). */
  tools(): ToolGateway;
  entities(): Record<string, EntityTypeDef>;
  testRunner: TestRunner;
  emit(change: KernelChange): void;
  /** Implementations for builtin routes (the caller's builtins and the kernel's extractor). */
  builtins(): Map<string, ToolDefinition>;
  mcp: McpConnections;
  resolveMcpSource?: (slug: string) => Promise<import('@memwise/defs').McpServerDef | undefined>;
  /** Tool names bound outside plugins (the caller's tools, the kernel's), with their class, for checks. */
  kernelToolEnvironment(): Record<string, { effect?: EffectClass; inputSchema?: Record<string, unknown> }>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const errorCount = (ds: Diagnostic[]) => ds.filter((d) => d.severity === 'error').length;
const rank = (c: EffectClass) => EFFECT_CLASSES.indexOf(c);
/** Sample records read per source at dry run. */
const SAMPLE_RECORDS = 20;

/** Semver order (pre-releases before their release; build metadata ignored). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split('+')[0]!.split(/-(.*)/s);
    return { nums: core!.split('.').map((n) => Number(n) || 0), pre };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** The value at a dotted path; empty = the value itself. */
function valueAt(v: unknown, path?: string): unknown {
  if (!path) return v;
  let cur = v;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * The record in a `get` tool's result: at `item` when the source says, else the result itself,
 * else the one object inside it that has the record's key (`{ contact: {...} }`).
 */
function recordIn(result: unknown, source: RecordSourceDef): Record<string, unknown> | undefined {
  const at = valueAt(result, source.get?.item);
  if (!at || typeof at !== 'object' || Array.isArray(at)) return undefined;
  const obj = at as Record<string, unknown>;
  if (source.get?.item || valueAt(obj, source.key) !== undefined) return obj;
  const inner = Object.values(obj).filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && valueAt(v, source.key) !== undefined);
  return inner.length === 1 ? inner[0] : obj;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const blank = (v: unknown) => v === undefined || v === null || v === '';
/**
 * A project connection's settings as a tool's arguments: only the names the tool's input takes
 * (`study` for Rave), never anything else. Connection settings hold no credentials (26 §3).
 */
export function argsFrom(settings: Record<string, unknown> | undefined, inputSchema: Record<string, unknown> | undefined): Record<string, unknown> {
  const props = (inputSchema?.properties ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(settings ?? {}).filter(([k, v]) => k in props && v !== undefined && v !== null && v !== ''));
}

/** A mapped record whose `{ link }` references found no linked record: those fields are kept as they are. */
type LinkedMappedRecord = MappedRecord & { keep?: string[] };

/**
 * Whether the value stored and the value a source gives now are the same for a field of this type,
 * so a sweep writes a version only when something changed: "104" and 104 in a Text field, 7 and
 * "7" in a Number one, a Date as a day however it is written.
 */
export function sameValue(a: unknown, b: unknown, type?: ValueType): boolean {
  if (blank(a) || blank(b)) return blank(a) && blank(b);
  return normalFor(a, type) === normalFor(b, type);
}

function normalFor(v: unknown, type?: ValueType): unknown {
  const name = type?.kind === 'scalar' ? type.name : type?.kind === 'quantity' ? 'Number' : undefined;
  const asNumber = (x: unknown) => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' && !Number.isNaN(Number(x)) ? Number(x) : x);
  const toIso = (x: unknown) => (x instanceof Date ? x.toISOString() : typeof x === 'string' && !Number.isNaN(Date.parse(x)) ? new Date(x).toISOString() : x);
  switch (name) {
    case 'Number': case 'Percentage': case 'Duration': return asNumber(v);
    case 'Date': { const d = toIso(v); return typeof d === 'string' ? d.slice(0, 10) : typeof v === 'string' ? v.slice(0, 10) : v; }
    case 'DateTime': return toIso(v);
    case 'Boolean': return v === true || v === 'true' ? true : v === false || v === 'false' ? false : v;
  }
  if (type && (type.kind === 'scalar' || type.kind === 'identifier' || type.kind === 'enum' || type.kind === 'ref')) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  // Without a type (or a structured one): dates as days, the rest as written.
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?Z$/.test(v)) return v.slice(0, 10);
  return typeof v === 'object' ? JSON.stringify(v) : v;
}

/** A plugin's namespace: the first segment its tool names share (`crm` for `crm.list_contacts`). */
export function pluginNamespace(manifest: Pick<PluginManifest, 'id' | 'tools'>): string {
  const firsts = new Set(Object.keys(manifest.tools).map((n) => n.split('.')[0]!));
  if (firsts.size === 1) return [...firsts][0]!;
  return manifest.id.split('/').at(-1)!;
}

/** A token for a read the kernel makes itself (identity resolution, read-through, dry-run samples). */
function systemToken(label: string, onBehalfOf?: string): StepToken {
  const now = Date.now();
  return {
    runId: `system:${label}`, caseId: 'system', stepId: label, stepRunId: `system:${label}:${ulid()}`, workflowId: 'system',
    workflowVersion: 0, agentRole: `kernel.${label}`, ...(onBehalfOf ? { onBehalfOf } : {}),
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 600_000).toISOString(),
  };
}

/** The class a tool gets from a binding, in one plain line for the binder. */
function describeTool(name: string, manifest: PluginManifest): string {
  const t = manifest.tools[name];
  if (!t) return name;
  const hints = Object.entries(t.annotations ?? {}).filter(([, v]) => v).map(([k]) => k);
  const props = Object.keys(((t.inputSchema as { properties?: Record<string, unknown> }).properties) ?? {});
  return `${name}: ${t.description || '(no description)'}${hints.length ? ` Hints: ${hints.join(', ')}.` : ''}${props.length ? ` Arguments: ${props.join(', ')}.` : ' No arguments.'}`;
}

function gapsText(gaps: BindingGap[]): string[] {
  return gaps.map((g) => g.message + (g.suggestions?.length ? ` (perhaps ${g.suggestions.slice(0, 3).join(', ')})` : ''));
}

export interface PluginServices {
  plugins: PluginsService;
  identity: IdentityService;
  ops: BindingOps;
  entityRecord(entity: string, id: string, actor: Actor): Promise<EntityRecordView | undefined>;
  /** Pending identity candidates for this person's inbox (the bind-plugin owner role). */
  identityInbox(actor: Actor): Promise<IdentityCandidate[]>;
}

export function createPluginServices(deps: PluginServiceDeps): PluginServices {
  const root = resolve(deps.projectDir);
  const pluginStore = new PgPluginStore();
  const bindingVersions = new PgBindingVersionStore();
  const identityStore = new PgIdentityStore();
  const entityStore = new PgEntityStore();
  const changed = () => deps.emit({ kind: 'plugins' });

  async function live() { return (await deps.project()).project; }

  function entityDef(name: string): EntityTypeDef | undefined {
    const entities = deps.entities();
    return entities[name] ?? Object.values(entities).find((e) => e.entity.toLowerCase() === name.toLowerCase());
  }

  /** Every installed version of a plugin, newest first. */
  function versionsOf(project: ProjectDefs, id: string): InstalledPlugin[] {
    const all = Object.values(project.pluginVersions?.[id] ?? {});
    if (!all.length && project.plugins?.[id]) all.push(project.plugins[id]!);
    return all.sort((a, b) => compareVersions(b.manifest.version, a.manifest.version));
  }

  /** The bind-plugin run open for a plugin, if any. */
  async function openBindRun(pluginId: string): Promise<{ runId: string; caseId: string; draftId?: string } | undefined> {
    const { rows } = await deps.pool.query(
      `select r.id, r.case_id, c.values from mw.runs r join mw.cases c on c.id = r.case_id
        where r.workflow_id = $1 and r.status = 'active' and c.values -> 'plugin' ->> 'value' = $2
        order by r.created_at desc limit 1`, [BIND_PLUGIN, pluginId]);
    const r = rows[0];
    if (!r) return undefined;
    const draft = r.values?.draft?.value as string | undefined;
    return { runId: r.id, caseId: r.case_id, ...(draft ? { draftId: draft } : {}) };
  }

  async function summaryOf(project: ProjectDefs, id: string): Promise<PluginSummary | undefined> {
    const versions = versionsOf(project, id);
    const newest = versions[0];
    if (!newest) return undefined;
    const m = newest.manifest;
    const binding = project.bindings?.[id];
    const open = await openBindRun(id);
    const state: PluginSummary['binding'] = open
      ? { status: 'binding', ...open }
      : binding?.frozen
        ? { status: 'bound', version: binding.version, pluginVersion: binding.pluginVersion, frozenAt: binding.frozen.at, frozenBy: binding.frozen.by }
        : { status: 'unbound' };
    return {
      id, version: m.version, versions: versions.map((v) => v.manifest.version), title: m.title,
      ...(m.description ? { description: m.description } : {}), trust: m.trust,
      ...(m.importedFrom ? { imported: 'claude-plugin' as const } : {}),
      tools: Object.keys(m.tools).length, workflows: [...m.workflows], provides: Object.keys(m.provides.capabilities),
      requires: Object.keys(m.requires.capabilities),
      binding: state,
      ...(binding?.frozen && compareVersions(m.version, binding.pluginVersion) > 0 ? { upgradeAvailable: true } : {}),
    };
  }

  // ---------------------------------------------------------------- reads through plugin tools

  /**
   * Calls a plugin tool as a `read` through a gateway (the live one, or one made for a draft's
   * binding): policy checked under the platform, plugin and domain layers; refused unless it is
   * classified `read` and allowed.
   */
  async function readThrough(gateway: ToolGateway, tool: string, args: Record<string, unknown>, label: string, plugins: ReturnType<typeof pluginPolicies>, actor?: Actor): Promise<unknown> {
    const bound = gateway.bound()[tool];
    if (!bound) throw new Error(`${tool} is not bound`);
    if (bound.effect !== 'read') throw new Error(`${tool} is not classified \`read\` (${bound.effect ?? 'unclassified'}), so the kernel does not call it by itself`);
    const domainPolicy = await loadDomainPolicy(deps.pool);
    const pseudo = { origin: undefined } as Pick<WorkflowDef, 'origin'>;
    const layers = [PLATFORM_DEFAULTS, ...pluginLayers(plugins, pseudo, { tools: { allowed: [tool], required: [] } }),
      ...(domainPolicy ? [{ kind: 'domain' as const, name: domainPolicy.name ?? 'domain', doc: domainPolicy }] : [])];
    const { effective } = compilePolicy(layers);
    const token = systemToken(label, actor?.kind === 'person' ? actor.personId : undefined);
    const decision = await gateway.check({ tool, args, token }, effective, { tainted: false });
    if (decision.decision.verdict !== 'allow' && decision.decision.verdict !== 'preview') {
      throw new Error(`${tool} is not allowed here: ${decision.decision.reason ?? decision.decision.verdict}`);
    }
    const r = await gateway.execute({ tool, args, callId: label, idempotencyKey: `${token.stepRunId}:${tool}`, token }, decision);
    if (r.status !== 'ok') throw new Error(r.status === 'error' ? r.error : r.reason);
    return r.result;
  }

  /** A gateway binding one plugin's tools as a (draft) binding classes them; for dry-run samples. */
  function draftGateway(bp: BoundPlugin): ToolGateway {
    const tools = Object.values(bp.manifest.tools).filter((t) => !toolClass(t, bp.binding).off && !isReservedToolName(t.name))
      .map((t) => pluginTool(t, bp, { root, builtins: deps.builtins(), mcp: deps.mcp }));
    return createToolGateway({ tools, ledger: new PgEffectLedger(deps.pool), rates: new PgRateCounter(deps.pool) });
  }

  // ---------------------------------------------------------------- binding drafts

  const bindingFileOf = (pluginId: string) => bindingPath(pluginId);

  async function readDraftBinding(draftId: string, pluginId?: string): Promise<{ binding: BindingDef; text: string; path: string; pluginId: string }> {
    const d = await readDraft(root, draftId);
    if (!d) throw new Error(`there is no draft ${draftId}`);
    const id = pluginId ?? d.meta.plugin?.id;
    if (!id) throw new Error(`draft ${draftId} is not a binding draft`);
    const path = bindingFileOf(id);
    const file = join(draftDir(root, draftId), path);
    if (!existsSync(file)) throw new Error(`draft ${draftId} has no ${path}`);
    const text = await readFile(file, 'utf8');
    const parsed = parseBindingFile(text, path);
    if (!parsed.value) throw new Error(`${path} in draft ${draftId} does not load: ${parsed.diagnostics.map((x) => x.message).join('; ')}`);
    return { binding: parsed.value, text, path, pluginId: id };
  }

  async function writeDraftBinding(draftId: string, binding: BindingDef, summary: string, by: string, via: 'chat' | 'editor' | 'cli' = 'editor') {
    const path = bindingFileOf(binding.plugin);
    await writeDraftFiles(root, draftId, [{ path, content: bindingToYaml({ ...binding, file: path }) }], { by, via, summary });
  }

  /** The person who approved this run's review step (recorded as who froze it). */
  async function approverOf(runId: string): Promise<string | undefined> {
    const { rows } = await deps.pool.query(
      `select decided_by from mw.step_runs where run_id = $1 and outcome = 'approved' and decided_by is not null
        order by finished_at desc nulls last, started_at desc limit 1`, [runId]);
    return rows[0]?.decided_by;
  }

  /** The draft's project with its binding applied (not frozen yet), plugins from the live plugins/. */
  async function draftProject(draftId: string, pluginId: string) {
    void pluginId; // loadDraft counts a binding draft's own binding as applied
    return loadDraft(root, draftId);
  }

  // ---------------------------------------------------------------- the bind-plugin operations

  const ops: BindingOps = {
    async installCheck(pluginId): Promise<InstallCheckResult> {
      const project = await live();
      const plugin = versionsOf(project, pluginId)[0];
      if (!plugin) return { outcome: 'missing', missing: [`${pluginId} is not installed`], summary: `${pluginId} is not installed: install it first.` };
      const m = plugin.manifest;
      const missing: string[] = [];
      const lines: string[] = [`${m.title} ${m.version} (${m.id}, ${m.trust}) is installed.`];

      // Capabilities: provided by a bound plugin (or by this one), unless optional.
      const others = boundPlugins(project).filter((b) => b.manifest.id !== pluginId);
      const providers = new Map<string, string[]>();
      for (const b of others) for (const [cap, p] of Object.entries(b.manifest.provides.capabilities)) (providers.get(cap) ?? providers.set(cap, []).get(cap)!).push(`${p.tool} (${b.manifest.id})`);
      for (const [cap, p] of Object.entries(m.provides.capabilities)) (providers.get(cap) ?? providers.set(cap, []).get(cap)!).push(`${p.tool} (itself)`);
      for (const [cap, need] of Object.entries(m.requires.capabilities)) {
        const by = providers.get(cap);
        if (by?.length) lines.push(`It needs ${cap} (as ${need.as}): provided by ${by.join(', ')}.`);
        else if (need.optional) lines.push(`It can use ${cap} (as ${need.as}), which no bound plugin provides; that is optional.`);
        else missing.push(`the capability ${cap}: no bound plugin provides it; bind one that does first`);
      }

      // Tool names: free of other plugins' and the kernel's.
      const taken = new Map<string, string>();
      for (const b of others) for (const t of Object.keys(b.manifest.tools)) if (!b.binding.tools[t]?.off) taken.set(t, b.manifest.id);
      for (const t of Object.keys(m.tools)) {
        if (isReservedToolName(t)) missing.push(`the tool name ${t}: the kernel keeps it for itself`);
        else if (taken.has(t)) missing.push(`the tool name ${t}: ${taken.get(t)} already binds it`);
      }

      // What it can reach.
      const byClass = new Map<string, string[]>();
      for (const t of Object.values(m.tools)) {
        const c = toolClass(t, project.bindings?.[pluginId]).effect ?? 'unclassified';
        (byClass.get(c) ?? byClass.set(c, []).get(c)!).push(t.name);
      }
      if (byClass.size) lines.push(`Tools: ${[...byClass].map(([c, ts]) => `${ts.length} ${c} (${ts.join(', ')})`).join('; ')}.`);
      else lines.push('It has no tools.');
      const servers = Object.entries(m.mcpServers);
      if (servers.length) {
        lines.push(`MCP servers: ${servers.map(([n, s]) => `${n} (${'url' in s ? s.url : 'source' in s ? `the connector ${s.source}` : 'runs on this machine'})`).join(', ')}.`);
      }
      if (m.environment?.network?.length) lines.push(`Network: ${m.environment.network.join(', ')}.`);
      if (m.workflows.length) lines.push(`Workflows: ${m.workflows.join(', ')}.`);
      if (missing.length) lines.unshift(`Missing: ${missing.join('; ')}.`);
      return { outcome: missing.length ? 'missing' : 'ok', missing, summary: lines.join(' '), version: m.version };
    },

    async propose(pluginId, ctx): Promise<ProposeBindingResult> {
      const project = await live();
      const plugin = versionsOf(project, pluginId)[0];
      if (!plugin) throw new Error(`${pluginId} is not installed`);
      const previous = project.bindings?.[pluginId];
      const runId = ctx.token.runId;
      const by = ctx.token.onBehalfOf ?? 'system';
      // A retried propose step (or check → propose again after needs_person) reuses the draft its
      // run made, and starts from what is in it now, so a person's edits there are kept.
      const existing = (await listDrafts(root)).find((d) => d.kind === 'binding' && d.status === 'open' && d.runId === runId && d.plugin?.id === pluginId);
      const start = existing ? (await readDraftBinding(existing.id, pluginId)).binding : previous;
      const proposal = proposeBinding({ plugin, project, ...(start ? { previous: start } : {}) });
      const meta = existing ?? await createBindingDraft(root, {
        pluginId, pluginVersion: plugin.manifest.version, title: `${previous ? 'Upgrade' : 'Bind'} ${plugin.manifest.title}`, createdBy: by, runId,
        binding: proposal.binding,
      });
      if (existing) await writeDraftBinding(meta.id, proposal.binding, previous ? `Proposed an upgrade to ${plugin.manifest.version}` : 'Proposed a binding', by);
      deps.emit({ kind: 'drafts', draftId: meta.id });
      const unclassified = Object.entries(proposal.classes).filter(([, c]) => c.from === 'none').map(([t]) => t).sort();
      const gapLines = gapsText(proposal.gaps.filter((g) => g.kind !== 'tool-unclassified'));
      const summary = [
        previous ? `An upgrade from ${previous.pluginVersion} (binding version ${previous.version}) to ${plugin.manifest.version}.` : `A new binding of ${plugin.manifest.title} ${plugin.manifest.version}.`,
        unclassified.length ? `${plural(unclassified.length, 'tool')} unclassified: ${unclassified.join(', ')}.` : 'Every tool has a class.',
        ...gapLines,
      ].join(' ');
      return {
        outcome: unclassified.length ? 'unclassified' : 'classified', draft: meta.id,
        ...(unclassified.length ? { unclassified: unclassified.map((t) => describeTool(t, plugin.manifest)).join('\n') } : {}),
        unclassified_tools: unclassified, gaps: proposal.gaps.length, summary, version: plugin.manifest.version,
      };
    },

    async classify({ draft: given, classes, reasons }, ctx): Promise<ClassifyToolsResult> {
      // Without a draft id: the binding draft this run is making.
      const draft = given ?? (await listDrafts(root)).find((d) => d.kind === 'binding' && d.status === 'open' && d.runId === ctx.token.runId)?.id;
      if (!draft) throw new Error('name the binding draft to classify (draft)');
      const { binding, pluginId } = await readDraftBinding(draft);
      const project = await live();
      const plugin = versionsOf(project, pluginId).find((p) => p.manifest.version === binding.pluginVersion) ?? versionsOf(project, pluginId)[0];
      if (!plugin) throw new Error(`${pluginId} is not installed`);
      const classified: string[] = [];
      const refused: { tool: string; reason: string }[] = [];
      const tools = { ...binding.tools };
      for (const [tool, effect] of Object.entries(classes)) {
        const def = plugin.manifest.tools[tool];
        if (!def) { refused.push({ tool, reason: `${pluginId} has no tool ${tool}` }); continue; }
        if (!(EFFECT_CLASSES as readonly string[]).includes(effect)) { refused.push({ tool, reason: `${effect} is not an effect class` }); continue; }
        if (def.effect && rank(effect) < rank(def.effect)) {
          refused.push({ tool, reason: `the plugin declares ${tool} ${def.effect}; a binding may make it stricter, never looser` });
          continue;
        }
        tools[tool] = { ...tools[tool], effect, ...(reasons?.[tool] ? { reason: reasons[tool] } : {}) };
        classified.push(tool);
      }
      if (classified.length) {
        await writeDraftBinding(draft, { ...binding, tools }, `Classified ${classified.join(', ')}`, ctx.token.onBehalfOf ?? 'binder', 'editor');
        deps.emit({ kind: 'drafts', draftId: draft });
      }
      const unclassified = Object.values(plugin.manifest.tools).filter((t) => !tools[t.name]?.effect && !t.effect && !tools[t.name]?.off).map((t) => t.name).sort();
      return { draft, classified, refused, unclassified };
    },

    async dryRun(draftId, ctx): Promise<DryRunResult> {
      const report = await dryRunDraft(draftId);
      void ctx;
      return {
        outcome: report.outcome, hash: report.hash, errors: report.errors,
        examples_failed: report.examples.filter((e) => e.status === 'fail').length, summary: report.summary,
      };
    },

    async freeze({ draft, hash }, ctx): Promise<FreezeResult> {
      const d = await readDraft(root, draft);
      if (!d) throw new Error(`there is no draft ${draft}`);
      if (d.meta.status === 'published') {
        // Freezing again (a retried freeze step) finds the version it made.
        const made = await bindingVersions.byDraft(deps.pool, draft);
        if (made) return { outcome: 'frozen', version: made.version };
        // A crash between publishing and recording: the live binding says this run froze it.
        const pluginId = d.meta.plugin?.id;
        const path = pluginId ? bindingFileOf(pluginId) : undefined;
        const liveText = path && existsSync(join(root, path)) ? await readFile(join(root, path), 'utf8') : undefined;
        const liveBinding = liveText !== undefined ? parseBindingFile(liveText, path!).value : undefined;
        if (pluginId && liveBinding?.frozen?.runId === ctx.token.runId && liveBinding.version) {
          await bindingVersions.record(deps.pool, {
            pluginId, version: liveBinding.version, pluginVersion: liveBinding.pluginVersion, hash: liveBinding.hash,
            frozenBy: liveBinding.frozen.by, runId: ctx.token.runId, draftId: draft,
          });
          await deps.index();
          changed();
          deps.emit({ kind: 'drafts', draftId: draft });
          return { outcome: 'frozen', version: liveBinding.version };
        }
        throw new Error(`draft ${draft} was already published`);
      }
      if (d.meta.status !== 'open') throw new Error(`draft ${draft} is ${d.meta.status}`);
      if ((await draftContentHash(root, draft)) !== hash) return { outcome: 'stale', message: 'the binding changed after its dry run; dry-run it again' };
      const { binding, pluginId } = await readDraftBinding(draft);
      const runId = ctx.token.runId;
      const by = (await approverOf(runId)) ?? ctx.token.onBehalfOf ?? 'system';
      const current = (await live()).bindings?.[pluginId];
      const versions = await bindingVersions.list(deps.pool, pluginId);
      const version = Math.max(current?.version ?? 0, versions[0]?.version ?? 0, binding.version ?? 0) + 1;
      const frozen: BindingDef = { ...binding, version, frozen: { by, at: new Date().toISOString(), runId } };
      await writeDraftBinding(draft, frozen, `Frozen as binding version ${version}`, by);
      try {
        await applyDraft(root, draft, { hash: await draftContentHash(root, draft) });
      } catch (e) {
        if (e instanceof DraftStaleError) return { outcome: 'stale', message: e.message };
        if (e instanceof DraftConflictError) throw new Error(`the live binding changed since the draft was made (${e.paths.join(', ')}); bind the plugin again`);
        throw e;
      }
      const path = bindingFileOf(pluginId);
      const text = await readFile(join(root, path), 'utf8');
      const parsed = parseBindingFile(text, path);
      await bindingVersions.record(deps.pool, {
        pluginId, version, pluginVersion: binding.pluginVersion, hash: parsed.value?.hash ?? hash, frozenBy: by, runId, draftId: draft,
      });
      await deps.index();
      changed();
      deps.emit({ kind: 'drafts', draftId: draft });
      return { outcome: 'frozen', version };
    },

    async resolveIdentity(pluginId): Promise<ResolveIdentityResult> {
      return identity.resolve({ plugin: pluginId });
    },
  };

  /** `plugins.dry_run`: checks, the plugin's examples, samples through the mappings, upgrade impact. */
  async function dryRunDraft(draftId: string): Promise<BindingReport> {
    const { binding, pluginId, path } = await readDraftBinding(draftId);
    const checkedHash = await draftContentHash(root, draftId);
    const loaded = await draftProject(draftId, pluginId);
    const project = loaded.project;
    const bp = boundPlugins(project).find((b) => b.manifest.id === pluginId);

    // Checks of the domain with the binding applied, and each step's policy stack.
    const tools = { ...deps.kernelToolEnvironment(), ...pluginToolEnvironment(boundPlugins(project)) };
    for (const t of domainTools(project.entities)) tools[t.name] ??= { ...(typeof t.effect === 'string' ? { effect: t.effect } : {}), inputSchema: t.inputSchema };
    const all = [...loaded.diagnostics, ...checkProject(project, { tools })];
    const policies = pluginPolicies(boundPlugins(project));
    const seen = new Set<string>();
    for (const wf of Object.values(project.workflows)) {
      for (const step of [undefined, ...Object.values(wf.steps)]) {
        const { effective, violations } = compilePolicy(layersFor({ ...projectPolicyLayers(project, wf), plugins: pluginLayers(policies, wf, step), workflow: wf, step }));
        for (const x of [...violationsToDiagnostics(violations), ...extractDiagnostics(step, effective, tools)]) {
          const key = `${x.file}|${x.path}|${x.message}`;
          if (!seen.has(key)) { seen.add(key); all.push(x); }
        }
      }
    }
    // The binding's own files and the plugin's resolved workflows are what this draft is about.
    const mine = (file?: string) => !file || file.startsWith('domain/') || file.startsWith('plugins/') || file === path;
    const diagnostics = all.filter((x) => mine(x.file));
    const errors = errorCount(diagnostics);

    // The plugin's example cases, through the binding (out of process).
    const pluginWorkflows = Object.values(project.workflows).filter((w) => w.origin?.kind === 'plugin' && w.origin.plugin === pluginId);
    const examples: ExampleOutcome[] = [];
    if (!errors) {
      for (const wf of pluginWorkflows) {
        if (!wf.examples.length) continue;
        const outcomes = await deps.testRunner({ projectDir: draftDir(root, draftId), workflowId: wf.id });
        examples.push(...outcomes.map((o) => ({ ...o, name: `${wf.id}/${o.name}` })));
      }
    }

    // Sample records from each mapped source's list tool, through the mappings.
    const records: MappedRecord[] = [];
    const notes: string[] = [];
    if (bp) {
      const gateway = draftGateway(bp);
      const ns = pluginNamespace(bp.manifest);
      for (const [name, rb] of Object.entries(binding.records)) {
        const source = bp.manifest.records[name];
        if (!source) { notes.push(`the record source ${name} is not one ${pluginId} has`); continue; }
        const listClass = bp.manifest.tools[source.list.tool] ? toolClass(bp.manifest.tools[source.list.tool]!, binding).effect : undefined;
        if (listClass !== 'read') { notes.push(`${name}: sample records not read, because ${source.list.tool} is not classified read`); continue; }
        try {
          const result = await readThrough(gateway, source.list.tool, source.list.args ?? {}, `dry_run.${name}`, policies);
          const items = valueAt(result, source.list.items);
          if (!Array.isArray(items)) { notes.push(`${name}: ${source.list.tool} returned no list${source.list.items ? ` at ${source.list.items}` : ''}`); continue; }
          const map = compileRecordMapping(rb, source, ns, project.entities[rb.entity]);
          for (const item of items.slice(0, SAMPLE_RECORDS)) records.push(map((item ?? {}) as Record<string, unknown>));
        } catch (e) {
          notes.push(`${name}: the sample records could not be read (${(e as Error).message})`);
        }
      }
    }
    const recordErrors = records.filter((r) => r.errors.length || r.roundTrip.length).length;

    // Upgrades: how each of the plugin's workflows changes against the live binding.
    let impact: StructuralDiff[] | undefined;
    const liveProject = await live();
    const liveBinding = liveProject.bindings?.[pluginId];
    if (liveBinding) {
      impact = [];
      for (const after of pluginWorkflows) {
        const before = liveProject.workflows[after.id];
        if (before) impact.push(structuralDiff(before, after));
      }
    }

    const failing = examples.filter((e) => e.status === 'fail').length;
    const passed = errors === 0 && failing === 0 && recordErrors === 0 && !!bp;
    const warnings = diagnostics.length - errors;
    const parts = [
      errors ? `${plural(errors, 'error')} to fix` : 'checks pass',
      ...(warnings ? [plural(warnings, 'warning')] : []),
      errors ? 'example cases not run' : examples.length ? `${examples.filter((e) => e.status === 'pass').length} of ${plural(examples.length, 'example case')} pass` : 'no example cases',
      ...(records.length ? [`${plural(records.length, 'sample record')} mapped${recordErrors ? `, ${recordErrors} with problems` : ''}`] : []),
      ...(impact?.length ? [`${plural(impact.length, 'workflow')} compared with the live binding`] : []),
      ...notes,
    ];
    if (!bp) parts.unshift(`the binding of ${pluginId} does not apply (is ${binding.pluginVersion} installed?)`);
    const at = new Date().toISOString();
    const summary = `${parts.join('; ')}.`.replace(/^./, (c) => c.toUpperCase());

    // The binding records its dry run; the hash the step passes on is the content after that.
    await writeDraftBinding(draftId, { ...binding, dryRun: { at, hash: checkedHash, passed, summary } }, `Dry run: ${passed ? 'passed' : 'failed'}`, 'system');
    const hash = await draftContentHash(root, draftId);
    const report: BindingReport = {
      plugin: pluginId, draftId, hash, at, diagnostics, errors, warnings, examples, records,
      ...(impact ? { impact } : {}), outcome: passed ? 'passed' : 'failed', summary,
    };
    await writeDraftReport(root, draftId, report as unknown as DraftReport);
    deps.emit({ kind: 'drafts', draftId });
    return report;
  }

  // ---------------------------------------------------------------- PluginsService

  const plugins: PluginsService = {
    async list() {
      const project = await live();
      const ids = Object.keys(project.pluginVersions ?? project.plugins ?? {}).sort();
      const out: PluginSummary[] = [];
      for (const id of ids) { const s = await summaryOf(project, id); if (s) out.push(s); }
      return out;
    },

    async get(id) {
      const project = await live();
      const summary = await summaryOf(project, id);
      const newest = versionsOf(project, id)[0];
      if (!summary || !newest) return undefined;
      const binding = project.bindings?.[id];
      const forClasses = binding?.pluginVersion === newest.manifest.version ? binding : undefined;
      const row = await pluginStore.get(deps.pool, id, newest.manifest.version);
      const detail: PluginDetail = {
        ...summary, manifest: newest.manifest, dir: newest.dir, hash: newest.hash,
        skills: newest.skills.map((s) => ({ name: s.name, ...(s.description ? { description: s.description } : {}) })),
        toolClasses: Object.values(newest.manifest.tools).map((t) => {
          const c = toolClass(t, forClasses);
          const from = c.from === 'none' && t.annotations && (t.annotations.readOnlyHint || t.annotations.destructiveHint) ? 'annotations' as const : c.from;
          return { name: t.name, description: t.description, ...(c.effect ? { effect: c.effect } : {}), from, ...(c.off ? { off: true } : {}) };
        }),
        notes: row?.notes ?? [],
      };
      return detail;
    },

    async install(dir, by) {
      const src = resolve(dir);
      if (!existsSync(src)) throw new Error(`${dir} does not exist`);
      let manifest: PluginManifest | undefined;
      const notes: string[] = [];
      let keepManifest = false;
      if (!existsSync(join(src, PLUGIN_MANIFEST))) {
        const imported = await importClaudePlugin(src);
        manifest = imported.manifest;
        notes.push(...imported.notes);
        // Its tools are found by asking each server (`tools/list`), with the source folder as its root.
        for (const [name, server] of Object.entries(manifest.mcpServers)) {
          try {
            const tools = await discoverMcpTools(server, src, name, deps.resolveMcpSource);
            manifest = withDiscoveredTools(manifest, name, tools);
            notes.push(`found ${plural(tools.length, 'tool')} on the MCP server ${name}`);
          } catch (e) {
            // An install again keeps the manifest it has rather than one that knows fewer tools.
            keepManifest = true;
            notes.push(`the MCP server ${name} could not be reached, so its tools are not known yet: ${(e as Error).message}`);
          }
        }
        // The version a frozen binding pins keeps its manifest: rewriting it would change the hash the binding pins.
        const pinning = (await live()).bindings?.[manifest.id];
        if (pinning?.frozen && pinning.pluginVersion === manifest.version) keepManifest = true;
      }
      const installed = await installPlugin(root, src, manifest ? { manifest, ...(keepManifest ? { keepManifest } : {}) } : {});
      if (installed.manifestUpdated) notes.push(`installed again: the tools found now were written into ${installed.dir}/${PLUGIN_MANIFEST}`);
      await deps.index();
      const project = await live();
      const p = project.pluginVersions?.[installed.id]?.[installed.version]
        ?? (project.plugins?.[installed.id]?.manifest.version === installed.version ? project.plugins[installed.id] : undefined);
      if (!p) throw new Error(`${installed.id} ${installed.version} was copied to ${installed.dir} but does not load`);
      await pluginStore.record(deps.pool, {
        id: installed.id, version: installed.version, hash: p.hash, dir: installed.dir, manifest: p.manifest, notes,
        installedBy: actorLabel(by),
      });
      changed();
      return (await summaryOf(project, installed.id))!;
    },

    async startBind(pluginId, by) {
      const project = await live();
      if (!versionsOf(project, pluginId).length) throw new Error(`${pluginId} is not installed`);
      if (!project.workflows[BIND_PLUGIN]) throw new Error(`this project has no ${BIND_PLUGIN} playbook`);
      const open = await openBindRun(pluginId);
      if (open) throw new Error(`${pluginId} is already being bound (case ${open.caseId})`);
      const started = await deps.startRun({ workflowId: BIND_PLUGIN, startAt: 'check', case: { plugin: pluginId }, by: by.personId });
      changed();
      return started;
    },

    async binding(pluginId, opts = {}) {
      const project = await live();
      let binding: BindingDef | undefined;
      let text: string;
      let path = bindingFileOf(pluginId);
      let report: BindingReport | undefined;
      if (opts.draftId) {
        const d = await readDraftBinding(opts.draftId, pluginId);
        binding = d.binding; text = d.text; path = d.path;
        const r = (await readDraft(root, opts.draftId))?.report as unknown as BindingReport | undefined;
        if (r && 'plugin' in r) report = r;
      } else {
        const file = join(root, path);
        if (!existsSync(file)) return undefined;
        text = await readFile(file, 'utf8');
        binding = parseBindingFile(text, path).value;
        if (!binding) return undefined;
      }
      const plugin = versionsOf(project, pluginId).find((p) => p.manifest.version === binding!.pluginVersion) ?? versionsOf(project, pluginId)[0];
      let gaps: BindingGap[] = [];
      if (plugin) {
        try { gaps = proposeBinding({ plugin, project, previous: binding }).gaps; } catch { gaps = []; }
      }
      const view: BindingView = {
        pluginId, ...(opts.draftId ? { draftId: opts.draftId } : {}), binding, text, path, gaps,
        ...(report ? { report } : {}), ...(plugin?.manifest.policy ? { pluginPolicy: plugin.manifest.policy } : {}),
      };
      return view;
    },
  };

  // ---------------------------------------------------------------- identity

  /** Roles that decide identity matches: the bind-plugin playbook's owner; none when the domain has no roles. */
  async function deciderRoles(): Promise<string[] | undefined> {
    const project = await live();
    if (!Object.keys(project.roles).length) return undefined;
    const owner = project.workflows[BIND_PLUGIN]?.owner;
    return owner ? [owner] : undefined;
  }

  const mayDecide = (actor: Actor, roles: string[] | undefined) =>
    actor.kind === 'system' || (actor.kind === 'person' && (!roles || roles.some((r) => actor.roles.includes(r))));

  /**
   * Who decides one match: a pairing between two domains' records (plugin `domain:<other>`, 24
   * §4) goes to the owner of the record's domain; a plugin's match to the bind-plugin owner.
   */
  async function mayDecideCandidate(actor: Actor, c: Pick<IdentityCandidate, 'plugin' | 'entity'>): Promise<boolean> {
    if (!c.plugin.startsWith('domain:')) return mayDecide(actor, await deciderRoles());
    if (actor.kind === 'system') return true;
    if (actor.kind !== 'person') return false;
    const project = await live();
    const domain = entityDef(c.entity)?.domain ?? DEFAULT_DOMAIN;
    const owner = project.domains?.[domain]?.owner;
    return !owner || !Object.keys(project.roles).length || hasRole(actor, owner, domain);
  }
  async function decidable(actor: Actor, list: IdentityCandidate[]): Promise<IdentityCandidate[]> {
    const out: IdentityCandidate[] = [];
    for (const c of list) if (await mayDecideCandidate(actor, c)) out.push(c);
    return out;
  }

  async function resolveNow({ plugin: pluginId, source }: { plugin: string; source?: string }): Promise<ResolveCounts> {
    const totals = { linked: 0, candidates: 0, unmatched: 0, created: 0, refreshed: 0 };
    let everyMs: number | undefined;
    let failed = false;
    // Stage 6 Part B: a project whose read fails (a study the account can't see), or that clashes
    // with another over a study, is recorded against that project; the others are still read.
    const failures = new Map<string, string>();
    const read = new Set<string>();
    try {
      // Everything that can fail is in here, so every failure is recorded with its next try (not
      // retried on each minute's sweep).
      const project = await live();
      const bp = boundPlugins(project).find((b) => b.manifest.id === pluginId);
      if (!bp) throw new Error(`${pluginId} is not bound`);
      everyMs = bp.binding.sync?.everyMs;
      const policies = pluginPolicies(boundPlugins(project));
      const ns = pluginNamespace(bp.manifest);
      const sources = Object.entries(bp.binding.records).filter(([name]) => !source || name === source);
      if (source && !sources.length) throw new Error(`the binding of ${pluginId} maps no record source ${source}`);
      // In the binding's order, so a source others link to (sites, for subjects) is read first.
      for (const [name, rb] of sources) {
        const def = bp.manifest.records[name];
        const entity = entityDef(rb.entity);
        if (!def || !entity) continue;
        // Stage 6 Part B: read once for each project whose connection goes through this plugin (its
        // settings, like the study, fill the tool's arguments of the same name), into that project.
        // No such project: once for the workspace, as before projects.
        const { targets, clashes } = await connectedProjects(project, pluginId, entity, bp.manifest.title ?? pluginId);
        for (const [p, why] of clashes) if (!failures.has(p)) failures.set(p, why);
        for (const target of targets) {
          // A project that failed on an earlier source (its study) isn't read for the later ones.
          if (target && failures.has(target.project)) continue;
          try {
            const args = { ...(def.list.args ?? {}), ...argsFrom(target?.settings, deps.tools().get(def.list.tool)?.inputSchema) };
            const result = await readThrough(deps.tools(), def.list.tool, args, `identity.${name}${target ? `@${target.project}` : ''}`, policies);
            const items = valueAt(result, def.list.items);
            if (!Array.isArray(items)) throw new Error(`${def.list.tool} returned no list${def.list.items ? ` at ${def.list.items}` : ''}`);
            const map = compileRecordMapping(rb, def, ns, entity);
            const mapped = await resolveLinkedRefs(pluginId, rb, items.map((i) => map((i ?? {}) as Record<string, unknown>)));
            // Only a binding with `sync:` keeps a copy of what the plugin owns (D110); others read it through.
            const owned = everyMs ? ownedFields(entity, bp.manifest, ns, name, rb) : [];
            const counts = await resolveSource(pluginId, name, rb, entity, mapped, { owned, title: bp.manifest.title, ...(target ? { project: target.project } : {}) });
            for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += counts[k];
            if (target) read.add(target.project);
          } catch (e) {
            // The workspace's own read fails as a whole, as before projects.
            if (!target) throw e;
            failures.set(target.project, (e as Error).message);
          }
        }
      }
    } catch (e) {
      failed = true;
      // Recording the failure must not hide it: the read's own error is the one that matters.
      await recordSync(pluginId, { error: (e as Error).message, everyMs: everyMs ?? (await syncInterval(pluginId)) }).catch(() => undefined);
      throw e;
    } finally {
      // A failed read changes what screens show too: what it linked, made or refreshed before it
      // failed (a source part way through), and the error itself on the source's "last read".
      if (failed) changed();
    }
    const { refreshed, ...rest } = totals;
    const result: ResolveCounts = { ...rest, ...(refreshed ? { refreshed } : {}) };
    if (failures.size) {
      // One line per project (`<project>: <why>`), so each project's screens show their own; the
      // projects read fine are refreshed, and the read is tried again within minutes.
      const error = [...failures].sort(([a], [b]) => a.localeCompare(b)).map(([p, why]) => `${p}: ${why}`).join('\n');
      await recordSync(pluginId, { error, counts: result, everyMs, read: [...read].some((p) => !failures.has(p)) }).catch(() => undefined);
      changed();
      throw new Error(error);
    }
    if (!source) await recordSync(pluginId, { counts: result, everyMs });
    changed();
    return result;
  }

  /**
   * The projects a plugin's record source is read for (Stage 6 Part B): each active project running
   * the entity's app with a connection through the plugin, with its study and that connection's
   * settings. None connects: one read for the workspace (`[undefined]`), as before projects.
   *
   * One study is read into one project (D114): identity links are one per outside record, so a
   * second project reading the same study would find every record linked already and stay empty.
   * The first by id reads it; the others are clashes, reported against them.
   */
  async function connectedProjects(project: ProjectDefs, pluginId: string, entity: EntityTypeDef, title: string): Promise<{
    targets: ({ project: string; settings: Record<string, unknown> } | undefined)[]; clashes: Map<string, string>;
  }> {
    const app = entity.domain ?? DEFAULT_DOMAIN;
    const candidates = Object.values(project.projects ?? {}).filter((p) => !p.implicit && p.apps.includes(app) && p.connections.some((x) => x.plugin === pluginId));
    // No project connects through it: one read for the workspace. Some do but none runs: none.
    if (!candidates.length) return { targets: [undefined], clashes: new Map() };
    // The live status is the database's (the file's is where a project started).
    const live = new Map((await deps.pool.query<{ id: string; status: string }>(`select id, status from mw.projects where id = any($1::text[])`, [candidates.map((p) => p.id)])).rows.map((r) => [r.id, r.status]));
    const active = candidates.filter((p) => (live.get(p.id) ?? p.status) === 'active').sort((a, b) => a.id.localeCompare(b.id));
    const targets: { project: string; settings: Record<string, unknown> }[] = [];
    const clashes = new Map<string, string>();
    const claimed = new Map<string, string>(); // study (lower case; '' = every study) → project
    for (const p of active) {
      const c = p.connections.find((x) => x.plugin === pluginId)!;
      // The project's own study (`study:` in project.yaml) is the connection's study unless the
      // connection names another: one study, named once, for every app the project runs.
      const settings = { ...(p.study ? { study: p.study } : {}), ...(c.settings ?? {}) };
      const study = typeof settings.study === 'string' ? settings.study.trim().toLowerCase() : '';
      const owner = claimed.get(study) ?? (study === '' ? claimed.values().next().value : claimed.get(''));
      if (owner) {
        clashes.set(p.id, `${study ? `study ${String(settings.study)}` : 'every study'} is read from ${title} into ${owner} already; one study is read into one project. Name another study for ${p.id}, or remove its ${title} connection.`);
        continue;
      }
      claimed.set(study, p.id);
      targets.push({ project: p.id, settings });
    }
    return { targets, clashes };
  }

  /** The binding's `sync:` interval, for recording a failure that came before the binding was read. */
  async function syncInterval(pluginId: string): Promise<number | undefined> {
    try {
      return boundPlugins(await live()).find((b) => b.manifest.id === pluginId)?.binding.sync?.everyMs;
    } catch {
      return undefined;
    }
  }

  /** One read of a plugin's sources at a time (the sweep and a person's "Read now" may meet). */
  const reading = new Map<string, Promise<unknown>>();
  function oneAtATime<T>(pluginId: string, fn: () => Promise<T>): Promise<T> {
    const before = reading.get(pluginId) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(fn);
    reading.set(pluginId, next);
    void next.finally(() => { if (reading.get(pluginId) === next) reading.delete(pluginId); }).catch(() => undefined);
    return next;
  }

  const identity: IdentityService = {
    resolve(input) {
      return oneAtATime(input.plugin, () => resolveNow(input));
    },

    async syncs() {
      const project = await live();
      const withSources = boundPlugins(project).filter((b) => Object.keys(b.binding.records).length);
      const { rows } = await deps.pool.query(`select * from mw.source_syncs where plugin = any($1::text[])`, [withSources.map((b) => b.manifest.id)]);
      const byId = new Map(rows.map((r) => [r.plugin as string, r]));
      return withSources.map((b): SourceSync => {
        const r = byId.get(b.manifest.id);
        return {
          plugin: b.manifest.id, counts: r?.counts ?? {},
          ...(r?.at ? { at: iso(r.at) } : {}), ...(r?.next_due ? { nextDue: iso(r.next_due) } : {}),
          ...(r?.error ? { error: r.error, errorAt: iso(r.error_at) } : {}),
        };
      });
    },

    async syncDue(now = new Date()) {
      const out: { plugin: string; counts?: ResolveCounts; error?: string }[] = [];
      const project = await live();
      for (const b of boundPlugins(project)) {
        if (!b.binding.sync || !Object.keys(b.binding.records).length) continue;
        const { rows } = await deps.pool.query(`select next_due from mw.source_syncs where plugin = $1`, [b.manifest.id]);
        const due = rows[0]?.next_due as Date | null | undefined;
        if (due && due.getTime() > now.getTime()) continue;
        try {
          out.push({ plugin: b.manifest.id, counts: await identity.resolve({ plugin: b.manifest.id }) });
        } catch (e) {
          out.push({ plugin: b.manifest.id, error: (e as Error).message });
        }
      }
      return out;
    },

    async candidates(filter = {}) {
      const list = await identityStore.candidates(deps.pool, filter.status ? { status: filter.status } : {});
      return filter.actor ? decidable(filter.actor, list) : list;
    },

    async decide({ candidateId, decision, by }) {
      const found = await identityStore.candidate(deps.pool, candidateId);
      if (found && !(await mayDecideCandidate(by, found))) {
        return { applied: false, message: found.plugin.startsWith('domain:')
          ? 'only the owner of this domain decides whether two records are the same'
          : 'only the people who own plugin bindings decide identity matches' };
      }
      const r = await withTransaction(deps.pool, async (db) => {
        const c = await identityStore.candidate(db, candidateId, { forUpdate: true });
        if (!c) return { applied: false, message: `there is no identity match ${candidateId}` };
        if (c.status !== 'pending') return { applied: false, message: `this match was already ${c.status}` };
        if (decision === 'confirm') {
          // Links are one to one per source: a domain record already linked from this source
          // takes no second one. The match can't be confirmed, so it is settled (not rejected:
          // nobody said the two differ).
          const has = await identityStore.linkOfRecord(db, c.plugin, c.source, c.entity, c.recordId);
          if (has) {
            await identityStore.decide(db, c.id, 'settled', by.personId);
            return { applied: false, message: `this ${c.entity} is already linked to ${has.externalId} from ${c.source}` };
          }
          const linked = await identityStore.link(db, {
            entity: c.entity, recordId: c.recordId, plugin: c.plugin, source: c.source, externalId: c.externalId, method: 'person',
            score: c.score, reasons: c.reasons, linkedBy: by.personId,
          });
          if (!linked) {
            await identityStore.decide(db, c.id, 'settled', by.personId);
            return { applied: false, message: 'this record was linked to another one meanwhile' };
          }
          await identityStore.decide(db, c.id, 'confirmed', by.personId);
          await identityStore.settleOthers(db, c, by.personId);
        } else {
          await identityStore.decide(db, c.id, 'rejected', by.personId);
        }
        return { applied: true };
      });
      if (r.applied) changed();
      return r;
    },

    async links(entity, recordId) {
      const def = entityDef(entity);
      return identityStore.links(deps.pool, def ? keyOf(def) : entity, recordId);
    },
  };

  /** Records a plugin's read: when, what it found or why it failed, and when it is due again. */
  async function recordSync(pluginId: string, r: { counts?: ResolveCounts; error?: string; everyMs?: number; read?: boolean }) {
    // A failed read is tried again sooner (at most five minutes on), not a whole interval later.
    const next = r.everyMs ? new Date(Date.now() + (r.error !== undefined ? Math.min(r.everyMs, RETRY_FAILED_MS) : r.everyMs)) : null;
    if (r.error !== undefined && r.read) {
      // Some projects were read, some failed: when they were read, and why the others weren't.
      await deps.pool.query(
        `insert into mw.source_syncs (plugin, at, next_due, counts, error, error_at) values ($1, now(), $2, $3, $4, now())
         on conflict (plugin) do update set at = excluded.at, next_due = excluded.next_due, counts = excluded.counts, error = excluded.error, error_at = excluded.error_at`,
        [pluginId, next, JSON.stringify(r.counts ?? {}), r.error]);
    } else if (r.error !== undefined) {
      await deps.pool.query(
        `insert into mw.source_syncs (plugin, next_due, error, error_at) values ($1, $2, $3, now())
         on conflict (plugin) do update set next_due = excluded.next_due, error = excluded.error, error_at = excluded.error_at`, [pluginId, next, r.error]);
    } else {
      await deps.pool.query(
        `insert into mw.source_syncs (plugin, at, next_due, counts) values ($1, now(), $2, $3)
         on conflict (plugin) do update set at = excluded.at, next_due = excluded.next_due, counts = excluded.counts, error = null, error_at = null`,
        [pluginId, next, JSON.stringify(r.counts ?? {})]);
    }
  }

  /**
   * Stage 6: fields mapped with `{ link: <source> }` hold another source's outside id; each becomes
   * the domain record linked to it, or is left out when that record isn't linked (yet).
   */
  async function resolveLinkedRefs(pluginId: string, rb: RecordBinding, mapped: MappedRecord[]): Promise<LinkedMappedRecord[]> {
    const linkFields = Object.entries(rb.fields).flatMap(([field, m]) => {
      const t = m.transform?.find((x): x is { link: string } => typeof x === 'object' && 'link' in x);
      return t ? [[field, t.link] as const] : [];
    });
    if (!linkFields.length) return mapped;
    const bySource = new Map<string, Map<string, string>>();
    for (const [, src] of linkFields) {
      if (bySource.has(src)) continue;
      bySource.set(src, new Map((await identityStore.linksOf(deps.pool, pluginId, src)).map((l) => [l.externalId, l.recordId])));
    }
    return mapped.map((rec) => {
      const values = { ...rec.values };
      const keep: string[] = [];
      for (const [field, src] of linkFields) {
        const outside = values[field];
        if (outside === undefined) continue;
        const id = bySource.get(src)!.get(String(outside));
        if (id) values[field] = id;
        else { delete values[field]; keep.push(field); }
      }
      return { ...rec, values, ...(keep.length ? { keep } : {}) };
    });
  }

  /** The entity's fields this plugin owns (its `ownership:` names the plugin, its namespace or the source) that this mapping fills. */
  function ownedFields(entity: EntityTypeDef, manifest: PluginManifest, ns: string, source: string, rb: RecordBinding): string[] {
    return Object.entries(entity.ownership ?? {})
      .filter(([field, owner]) => (owner === manifest.id || owner === ns || owner === source) && field in rb.fields && field in entity.fields)
      .map(([field]) => field);
  }

  /** Links, proposes or creates for one source's mapped records; counts where each record stands now. */
  async function resolveSource(pluginId: string, source: string, rb: RecordBinding, entity: EntityTypeDef, mapped: LinkedMappedRecord[],
    opts: { owned?: string[]; title?: string; project?: string } = {}) {
    const counts = { linked: 0, candidates: 0, unmatched: 0, created: 0, refreshed: 0 };
    const existing = new Map((await identityStore.linksOf(deps.pool, pluginId, source)).map((l) => [l.externalId, l]));
    const decided = await identityStore.candidates(deps.pool, { plugin: pluginId, source });
    const rejected = new Set(decided.filter((c) => c.status === 'rejected').map((c) => `${c.externalId}\0${c.recordId}`));
    // Rows as the system sees them (every field): those already linked, looked up by id for the
    // refresh below; those not linked yet, for matching new records against.
    const linkedRecords = new Set((await deps.pool.query(`select record_id from mw.identity_links where plugin = $1 and source = $2`, [pluginId, source])).rows.map((r) => r.record_id as string));
    const wanted = [...new Set(mapped.flatMap((m) => { const l = m.externalId ? existing.get(m.externalId) : undefined; return l ? [l.recordId] : []; }))];
    // One study is read into one project (D114): records this read already links but that sit in
    // another project (read before the project connected, or before its `study:` changed) move
    // into it, so the project never reads its study and stays empty.
    if (opts.project && projectScoped(entity) && wanted.length) {
      await withTransaction(deps.pool, async (db) => {
        await withRecordContext(db, { by: `source:${pluginId}`, via: `sync:${source}`, reason: `Read from ${opts.title ?? pluginId} for project ${opts.project}` });
        await db.query(`update ${tableOf(entity)} set ${PROJECT_COLUMN} = $1 where id = any($2::text[]) and ${PROJECT_COLUMN} is distinct from $1`, [opts.project, wanted]);
      });
    }
    const rowById = new Map((opts.owned?.length ? await entityStore.getMany(deps.pool, entity, wanted, { unrestricted: true }) : []).map((r) => [r.id, { id: r.id, values: r.values }]));
    const rows = (await entityStore.unlinked(deps.pool, entity, { plugin: pluginId, source }, opts.project ? { project: opts.project } : {})).map((r) => ({ id: r.id, values: r.values }));
    const owned = opts.owned ?? [];
    for (const rec of mapped) {
      if (!rec.externalId) { counts.unmatched++; continue; }
      const link = existing.get(rec.externalId);
      if (link) {
        if (link.method === 'created') counts.created++; else counts.linked++;
        // Stage 6: the fields the plugin owns follow what it says now. Rave is their only source:
        // nothing here edits them, so a difference is a change made there (a new coordinator).
        const row = rowById.get(link.recordId);
        if (row && owned.length) {
          const changes: Record<string, unknown> = {};
          for (const f of owned) {
            // A reference whose record isn't linked yet keeps what it had (not nulled, then put back).
            if (rec.keep?.includes(f)) continue;
            if (!sameValue(row.values[f], rec.values[f], entity.fields[f]?.type)) changes[f] = rec.values[f] ?? null;
          }
          if (Object.keys(changes).length) {
            await withTransaction(deps.pool, async (db) => {
              await withRecordContext(db, { by: `source:${pluginId}`, via: `sync:${source}`, reason: `Read from ${opts.title ?? pluginId}` });
              await entityStore.update(db, entity, link.recordId, changes);
            });
            counts.refreshed++;
          }
        }
        continue;
      }
      // A domain record already linked to another record of this source is not offered again.
      const candidates = rows.filter((r) => !linkedRecords.has(r.id) && !rejected.has(`${rec.externalId}\0${r.id}`));
      const match = matchRecord(rec.values, candidates, rb.identity);
      const base = { entity: keyOf(entity), plugin: pluginId, source, externalId: rec.externalId };
      if (match.verdict === 'link' && match.recordId) {
        await identityStore.link(deps.pool, { ...base, recordId: match.recordId, method: match.method ?? 'key', score: match.score, reasons: match.reasons });
        linkedRecords.add(match.recordId);
        counts.linked++;
      } else if (match.verdict === 'review' && match.recordId) {
        await identityStore.propose(deps.pool, { ...base, recordId: match.recordId, score: match.score, reasons: match.reasons, external: rec.values });
        counts.candidates++;
      } else if (decided.some((c) => c.externalId === rec.externalId && c.status === 'pending')) {
        counts.candidates++;
      } else if (rb.identity.createMissing) {
        const values = Object.fromEntries(Object.entries(rec.values).filter(([k]) => k in entity.fields));
        const id = await entityStore.create(deps.pool, entity, values, { idempotencyKey: `identity:${pluginId}:${source}:${rec.externalId}`, ...(opts.project ? { project: opts.project } : {}) });
        await identityStore.link(deps.pool, { ...base, recordId: id, method: 'created', score: 0, reasons: ['nothing matched, so it was created'] });
        linkedRecords.add(id);
        counts.created++;
      } else {
        counts.unmatched++;
      }
    }
    return counts;
  }

  async function identityInbox(actor: Actor): Promise<IdentityCandidate[]> {
    if (actor.kind !== 'person') return [];
    return decidable(actor, await identityStore.candidates(deps.pool, { status: 'pending' }));
  }

  // ---------------------------------------------------------------- entity records with read-through

  async function entityRecord(entityName: string, id: string, actor: Actor): Promise<EntityRecordView | undefined> {
    const def = entityDef(entityName);
    if (!def) throw new Error(`no entity type ${entityName}`);
    const row = await withActor(deps.pool, actor, (db) => entityStore.get(db, def, id));
    if (!row) return undefined;
    const links = await identityStore.links(deps.pool, keyOf(def), id);
    const project = await live();
    const bound = boundPlugins(project);
    const policies = pluginPolicies(bound);
    const view: EntityRecordView = { entity: def.entity, id: row.id, values: row.values, hidden: row.hidden, createdAt: row.createdAt, links: [], readThrough: {} };
    for (const link of links) {
      const bp = bound.find((b) => b.manifest.id === link.plugin);
      const source = bp?.manifest.records[link.source];
      const rb = bp?.binding.records[link.source];
      const out: EntityRecordView['links'][number] = { ...link };
      if (!bp || !source || !rb) { out.error = `${link.plugin} is not bound, or no longer maps ${link.source}`; view.links.push(out); continue; }
      if (!source.get) { out.error = `${link.source} records can't be read one at a time`; view.links.push(out); continue; }
      try {
        const result = await readThrough(deps.tools(), source.get.tool, { [source.get.arg]: link.externalId }, `read_through.${link.source}`, policies, actor);
        const item = recordIn(result, source);
        if (!item) throw new Error(`${source.get.tool} returned no record`);
        const mapped = compileRecordMapping(rb, source, pluginNamespace(bp.manifest), def)(item);
        // The actor's field access holds for linked values too: a field hidden on the row is left
        // out, and the unmapped rest (`extra`, which may hold the same data) only for someone who
        // sees every field of the entity.
        out.values = Object.fromEntries(Object.entries(mapped.values).filter(([k]) => !row.hidden.includes(k)));
        if (!row.hidden.length) out.extra = mapped.extra;
        const ns = pluginNamespace(bp.manifest);
        for (const [field, owner] of Object.entries(def.ownership ?? {})) {
          if (owner !== bp.manifest.id && owner !== ns && owner !== link.source) continue;
          if (field in mapped.values && !row.hidden.includes(field)) view.readThrough[field] = { plugin: bp.manifest.id, value: mapped.values[field] };
        }
      } catch (e) {
        out.error = (e as Error).message;
      }
      view.links.push(out);
    }
    return view;
  }

  return { plugins, identity, ops, entityRecord, identityInbox };
}

export { BINDINGS_DIR, type RecordSourceDef };
export type { ToolContext };
