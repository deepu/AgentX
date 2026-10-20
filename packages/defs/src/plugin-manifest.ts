/**
 * `memwise-plugin.yaml` (Phase 4, docs/memwise/22-phase-4-interfaces.md §2): reading it into a
 * PluginManifest and writing one back (for imported Claude plugins). The YAML keys are snake_case
 * (`mcp_servers`, `imported_from`); a tool's `input`/`output` become `inputSchema`/`outputSchema`.
 */
import { stringify as stringifyYaml } from 'yaml';
import { pluginFormat } from './formats.ts';
import { policyToRaw, toPolicyDoc } from './parse-policy.ts';
import { typeAt } from './parse-types.ts';
import {
  PLUGIN_ID_PATTERN, type McpServerDef, type McpToolAnnotationsDef, type PluginManifest, type PluginToolDef, type PluginTrust,
  type RecordSourceDef, type RequiredEntityDef, type ToolRoute,
} from './plugin-types.ts';
import { asRecord, asString, asStrings, compact, isRecord, readYaml, rememberLocator, Reporter, type ParseResult } from './source.ts';
import { EFFECT_CLASSES, type EffectClass, type RoleDef } from './types.ts';
import { parseDuration } from './value-types.ts';

const TRUSTS: PluginTrust[] = ['first-party', 'verified', 'community', 'local'];
export const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const isSemver = (v: string): boolean => SEMVER_PATTERN.test(v);

/** Semver order: -1, 0 or 1. A pre-release sorts before its release; text that isn't semver sorts first, by text. */
export function compareSemver(a: string, b: string): number {
  const ma = SEMVER_PATTERN.exec(a);
  const mb = SEMVER_PATTERN.exec(b);
  if (!ma || !mb) return ma ? 1 : mb ? -1 : a < b ? -1 : a > b ? 1 : 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d) return d < 0 ? -1 : 1;
  }
  const pa = ma[4];
  const pb = mb[4];
  if (pa === pb) return 0;
  if (pa === undefined) return 1;
  if (pb === undefined) return -1;
  const xa = pa.split('.');
  const xb = pb.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const x = xa[i];
    const y = xb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

const isEffect = (v: unknown): v is EffectClass => (EFFECT_CLASSES as readonly unknown[]).includes(v);

/** `{ builtin }`, `{ mcp, tool }` or `{ command: [...], timeout }`; undefined when it is none of them. */
export function toolRoute(raw: unknown): ToolRoute | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.builtin === 'string') return { builtin: raw.builtin };
  if (typeof raw.mcp === 'string' && typeof raw.tool === 'string') return { mcp: raw.mcp, tool: raw.tool };
  if (Array.isArray(raw.command) && raw.command.length && raw.command.every((c) => typeof c === 'string')) {
    const timeoutMs = typeof raw.timeout === 'string' || typeof raw.timeout === 'number' ? parseDuration(raw.timeout) : undefined;
    return compact({ command: raw.command as string[], timeoutMs });
  }
  return undefined;
}

/** A server as in Claude's `.mcp.json` (`type: http|sse` is dropped: a url is enough). */
export function mcpServer(raw: unknown): McpServerDef | undefined {
  if (!isRecord(raw)) return undefined;
  const strings = (v: unknown) => (isRecord(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string')) as Record<string, string> : undefined);
  if (typeof raw.source === 'string') return { source: raw.source };
  if (typeof raw.url === 'string') return compact({ url: raw.url, headers: strings(raw.headers) });
  if (typeof raw.command === 'string') {
    return compact({ command: raw.command, args: Array.isArray(raw.args) ? asStrings(raw.args) : undefined, env: strings(raw.env), cwd: asString(raw.cwd) });
  }
  return undefined;
}

function annotations(raw: unknown): McpToolAnnotationsDef | undefined {
  if (!isRecord(raw)) return undefined;
  const out: McpToolAnnotationsDef = {};
  for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) if (typeof raw[k] === 'boolean') out[k] = raw[k];
  return Object.keys(out).length ? out : undefined;
}

function role(id: string, spec: unknown): RoleDef | undefined {
  if (typeof spec === 'string') return { id, title: spec };
  if (isRecord(spec)) return compact({ id, title: asString(spec.title) ?? id, description: asString(spec.description) });
  return undefined;
}

/**
 * Parses `memwise-plugin.yaml`. `file` is relative to the project root (or the plugin folder).
 * Checks what the text alone can tell: the id and version, every tool's route, that `mcp` routes
 * name a declared server, and that capability and record tools exist. Folders (workflows, skills)
 * are checked by `loadPlugin`.
 */
export function parsePluginManifest(text: string, file: string): ParseResult<PluginManifest> {
  const src = readYaml(text, file);
  const report = new Reporter(file, src.locate);
  report.diagnostics.push(...src.diagnostics);
  if (!isRecord(src.data)) {
    if (!src.diagnostics.length) report.error('invalid-format', 'expected a plugin manifest: id, version, title, tools');
    return { diagnostics: report.diagnostics };
  }
  report.validate(pluginFormat, src.data);
  const data = src.data;

  const id = asString(data.id) ?? '';
  if (id && !PLUGIN_ID_PATTERN.test(id)) report.error('invalid-plugin-id', `\`${id}\` is not a plugin id: write <publisher>/<name> in lower case, e.g. acme/client-intake`, ['id']);
  const version = asString(data.version) ?? '';
  if (version && !isSemver(version)) report.error('invalid-version', `\`${version}\` is not a version: write it as major.minor.patch, e.g. 1.0.0`, ['version']);

  const mcpServers: Record<string, McpServerDef> = {};
  for (const [name, spec] of Object.entries(asRecord(data.mcp_servers))) {
    const server = mcpServer(spec);
    if (server) mcpServers[name] = server;
  }

  const provides: PluginManifest['provides'] = { capabilities: {} };
  for (const [cap, spec] of Object.entries(asRecord(asRecord(data.provides).capabilities))) {
    const tool = asString(asRecord(spec).tool);
    if (tool) provides.capabilities[cap] = { tool };
  }

  const tools: Record<string, PluginToolDef> = {};
  for (const [name, spec] of Object.entries(asRecord(data.tools))) {
    const t = asRecord(spec);
    const run = toolRoute(t.run);
    if (!run) continue; // the format check said what's wrong with it
    if ('mcp' in run && !mcpServers[run.mcp]) {
      report.error('unknown-mcp-server', `${name} runs on the MCP server \`${run.mcp}\`, which is not under mcp_servers`, ['tools', name, 'run', 'mcp']);
    }
    const capability = asString(t.capability) ?? Object.entries(provides.capabilities).find(([, p]) => p.tool === name)?.[0];
    tools[name] = compact({
      name,
      description: asString(t.description) ?? '',
      effect: isEffect(t.effect) ? t.effect : undefined,
      inputSchema: isRecord(t.input) ? t.input : { type: 'object' },
      outputSchema: isRecord(t.output) ? t.output : undefined,
      quarantine: typeof t.quarantine === 'boolean' ? t.quarantine : undefined,
      idempotent: typeof t.idempotent === 'boolean' ? t.idempotent : undefined,
      secrets: Array.isArray(t.secrets) ? asStrings(t.secrets) : undefined,
      annotations: annotations(t.annotations),
      capability,
      run,
    });
  }
  for (const [cap, p] of Object.entries(provides.capabilities)) {
    if (!tools[p.tool]) report.error('unknown-tool', `the capability ${cap} is provided by ${p.tool}, which is not one of the plugin's tools`, ['provides', 'capabilities', cap, 'tool']);
  }

  const req = asRecord(data.requires);
  const requires: PluginManifest['requires'] = { capabilities: {}, entities: {}, roles: {} };
  for (const [cap, spec] of Object.entries(asRecord(req.capabilities))) {
    const s = asRecord(spec);
    const as = asString(s.as);
    if (as) requires.capabilities[cap] = compact({ as, optional: typeof s.optional === 'boolean' ? s.optional : undefined });
  }
  for (const [name, spec] of Object.entries(asRecord(req.entities))) {
    const fields: RequiredEntityDef['fields'] = {};
    for (const [field, f] of Object.entries(asRecord(asRecord(spec).fields))) {
      const obj = isRecord(f) ? f : undefined;
      const typeSource = obj ? obj.type : f;
      if (!typeAt(typeSource, report, obj ? ['requires', 'entities', name, 'fields', field, 'type'] : ['requires', 'entities', name, 'fields', field])) continue;
      fields[field] = compact({
        typeSource: (typeSource as string).trim(),
        required: obj && typeof obj.required === 'boolean' ? obj.required : undefined,
        description: obj ? asString(obj.description) : undefined,
      });
    }
    requires.entities[name] = { name, fields };
  }
  for (const [rid, spec] of Object.entries(asRecord(req.roles))) {
    const r = role(rid, spec);
    if (r) requires.roles[rid] = r;
  }

  const records: Record<string, RecordSourceDef> = {};
  for (const [name, spec] of Object.entries(asRecord(data.records))) {
    const r = asRecord(spec);
    const list = asRecord(r.list);
    const listTool = asString(list.tool);
    const key = asString(r.key);
    if (!listTool || !key) continue;
    const fields: Record<string, string> = {};
    for (const [field, type] of Object.entries(asRecord(r.fields))) {
      if (typeAt(type, report, ['records', name, 'fields', field])) fields[field] = (type as string).trim();
    }
    const get = isRecord(r.get) && typeof r.get.tool === 'string' && typeof r.get.arg === 'string'
      ? compact({ tool: r.get.tool, arg: r.get.arg, item: asString(r.get.item) })
      : undefined;
    if (!tools[listTool]) report.error('unknown-tool', `the record source ${name} is listed by ${listTool}, which is not one of the plugin's tools`, ['records', name, 'list', 'tool']);
    if (get && !tools[get.tool]) report.error('unknown-tool', `the record source ${name} is read by ${get.tool}, which is not one of the plugin's tools`, ['records', name, 'get', 'tool']);
    records[name] = compact({
      name,
      title: asString(r.title),
      list: compact({ tool: listTool, items: asString(list.items), args: isRecord(list.args) ? list.args : undefined }),
      get,
      key,
      fields,
    });
  }

  const env = isRecord(data.environment)
    ? compact({ runtime: asString(data.environment.runtime), lockfile: asString(data.environment.lockfile), network: Array.isArray(data.environment.network) ? asStrings(data.environment.network) : undefined })
    : undefined;
  const imported = asRecord(data.imported_from);

  const value: PluginManifest = compact({
    id,
    version,
    title: asString(data.title) ?? id,
    description: asString(data.description),
    trust: TRUSTS.includes(data.trust as PluginTrust) ? data.trust as PluginTrust : 'local',
    provides,
    requires,
    tools,
    mcpServers,
    workflows: asStrings(data.workflows),
    skills: asStrings(data.skills),
    records,
    policy: isRecord(data.policy) ? toPolicyDoc(data.policy, file) : undefined,
    environment: env,
    components: Array.isArray(data.components) ? asStrings(data.components) : undefined,
    pages: Array.isArray(data.pages) ? asStrings(data.pages) : undefined,
    triggers: Array.isArray(data.triggers) ? data.triggers : undefined,
    importedFrom: imported.kind === 'claude-plugin' && typeof imported.name === 'string'
      ? compact({ kind: 'claude-plugin' as const, name: imported.name, version: asString(imported.version) })
      : undefined,
    file,
  });
  rememberLocator(value, src.locate);
  return { value, diagnostics: report.diagnostics };
}

const empty = (o: object | undefined) => !o || !Object.keys(o).length;

function routeToRaw(run: ToolRoute): Record<string, unknown> {
  if ('builtin' in run) return { builtin: run.builtin };
  if ('mcp' in run) return { mcp: run.mcp, tool: run.tool };
  return compact({ command: run.command, timeout: run.timeoutMs });
}

/**
 * A manifest as `memwise-plugin.yaml` text, keys in a fixed order, empty sections left out.
 * `parsePluginManifest(pluginManifestToYaml(m), m.file).value` equals `m`.
 */
export function pluginManifestToYaml(m: PluginManifest): string {
  const requires = compact({
    capabilities: empty(m.requires.capabilities) ? undefined : m.requires.capabilities,
    entities: empty(m.requires.entities) ? undefined : Object.fromEntries(Object.entries(m.requires.entities).map(([name, e]) => [name, {
      fields: Object.fromEntries(Object.entries(e.fields).map(([f, d]) => [f,
        d.required === undefined && d.description === undefined ? d.typeSource : compact({ type: d.typeSource, required: d.required, description: d.description })])),
    }])),
    roles: empty(m.requires.roles) ? undefined : Object.fromEntries(Object.entries(m.requires.roles).map(([id, r]) => [id, compact({ title: r.title, description: r.description })])),
  });
  const tools = Object.fromEntries(Object.values(m.tools).map((t) => [t.name, compact({
    description: t.description,
    effect: t.effect,
    input: t.inputSchema,
    output: t.outputSchema,
    quarantine: t.quarantine,
    idempotent: t.idempotent,
    secrets: t.secrets,
    annotations: t.annotations,
    capability: t.capability,
    run: routeToRaw(t.run),
  })]));
  const records = Object.fromEntries(Object.values(m.records).map((r) => [r.name, compact({
    title: r.title, list: r.list, get: r.get, key: r.key, fields: r.fields,
  })]));
  const doc = compact({
    id: m.id,
    version: m.version,
    title: m.title,
    description: m.description,
    trust: m.trust,
    imported_from: m.importedFrom,
    provides: empty(m.provides.capabilities) ? undefined : { capabilities: m.provides.capabilities },
    requires: empty(requires) ? undefined : requires,
    tools: empty(tools) ? undefined : tools,
    mcp_servers: empty(m.mcpServers) ? undefined : m.mcpServers,
    workflows: m.workflows.length ? m.workflows : undefined,
    skills: m.skills.length ? m.skills : undefined,
    records: empty(records) ? undefined : records,
    policy: m.policy ? policyToRaw(m.policy) : undefined,
    environment: m.environment,
    components: m.components,
    pages: m.pages,
    triggers: m.triggers,
  });
  return stringifyYaml(doc, { lineWidth: 0 });
}
