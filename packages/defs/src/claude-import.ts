/**
 * Claude plugins as MemWise plugins (D28, 22 §2): the file side of the import. A Claude plugin's
 * `.claude-plugin/plugin.json`, `skills/*\/SKILL.md` and `.mcp.json` become a manifest; its tools
 * are found later by connecting to its servers (`tools/list`, in the kernel), and added here with
 * `withDiscoveredTools`, unclassified.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { splitFrontMatter } from './parse-step.ts';
import { isSemver, mcpServer } from './plugin-manifest.ts';
import { PLUGIN_MANIFEST, type McpServerDef, type McpToolAnnotationsDef, type PluginManifest, type PluginToolDef, type RecordSourceDef } from './plugin-types.ts';
import { asString, isRecord } from './source.ts';

/** `My CRM Tools!` → `my-crm-tools`. */
export function slugifyName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[-.]+$/g, '');
  return slug || 'plugin';
}

/** A skill's front matter `name` and `description`, or nothing when it has none. */
export function skillFrontMatter(text: string): { name?: string; description?: string; body: string } {
  const parts = splitFrontMatter(text);
  if (!parts) return { body: text };
  let data: unknown;
  try { data = parseYaml(parts.yaml); } catch { data = undefined; }
  const fm = isRecord(data) ? data : {};
  return {
    ...(asString(fm.name) ? { name: asString(fm.name) } : {}),
    ...(asString(fm.description) ? { description: asString(fm.description) } : {}),
    body: parts.body,
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

/**
 * Reads a Claude plugin folder into a manifest: id `claude/<name>`, trust `community`, its MCP
 * servers and skills, no tools yet. Server commands, args and env are kept verbatim, including
 * `${CLAUDE_PLUGIN_ROOT}`: the runtime puts the installed plugin folder in its place when it
 * launches the server. `notes` say what was left out (commands, hooks, agents), for the install
 * report. Throws when the folder has no readable `.claude-plugin/plugin.json`.
 */
export async function importClaudePlugin(dir: string): Promise<{ manifest: PluginManifest; notes: string[] }> {
  const pluginJson = join(dir, '.claude-plugin', 'plugin.json');
  if (!existsSync(pluginJson)) throw new Error(`${dir} is not a Claude plugin: it has no .claude-plugin/plugin.json`);
  let meta: unknown;
  try { meta = await readJson(pluginJson); } catch (e) { throw new Error(`.claude-plugin/plugin.json is not valid JSON: ${(e as Error).message}`); }
  if (!isRecord(meta) || typeof meta.name !== 'string' || !meta.name.trim()) throw new Error('.claude-plugin/plugin.json has no name');
  const name = meta.name.trim();
  const notes: string[] = [];

  let version = asString(meta.version) ?? '0.0.0';
  if (!isSemver(version)) {
    notes.push(`the version \`${version}\` is not major.minor.patch, so it was installed as 0.0.0`);
    version = '0.0.0';
  } else if (!asString(meta.version)) notes.push('plugin.json has no version, so it was installed as 0.0.0');

  // Servers: `.mcp.json`, or `mcpServers` in plugin.json (an object, or the path of a JSON file).
  const mcpServers: Record<string, McpServerDef> = {};
  const addServers = (raw: unknown, from: string) => {
    const servers = isRecord(raw) && isRecord(raw.mcpServers) ? raw.mcpServers : isRecord(raw) ? raw : {};
    for (const [server, spec] of Object.entries(servers)) {
      const def = mcpServer(spec);
      if (def) mcpServers[server] = def;
      else notes.push(`the MCP server \`${server}\` in ${from} has neither a command nor a url, so it was left out`);
    }
  };
  if (existsSync(join(dir, '.mcp.json'))) {
    try { addServers(await readJson(join(dir, '.mcp.json')), '.mcp.json'); } catch { notes.push('.mcp.json is not valid JSON, so its servers were left out'); }
  }
  if (isRecord(meta.mcpServers)) addServers({ mcpServers: meta.mcpServers }, 'plugin.json');
  else if (typeof meta.mcpServers === 'string') {
    try { addServers(await readJson(join(dir, meta.mcpServers)), meta.mcpServers); } catch { notes.push(`${meta.mcpServers} (mcpServers in plugin.json) could not be read, so its servers were left out`); }
  }

  const skills: string[] = [];
  if (existsSync(join(dir, 'skills'))) {
    for (const e of (await readdir(join(dir, 'skills'), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.isDirectory() && !e.name.startsWith('.') && existsSync(join(dir, 'skills', e.name, 'SKILL.md'))) skills.push(e.name);
    }
  }

  for (const [part, what] of [['commands', 'slash commands'], ['hooks', 'hooks'], ['agents', 'agents']] as const) {
    if (existsSync(join(dir, part)) || meta[part] !== undefined) notes.push(`${part}/ (${what}) is not used by MemWise and was ignored`);
  }
  if (Object.keys(mcpServers).length) notes.push('its tools are found by connecting to its MCP servers, and stay unclassified until the plugin is bound');

  const manifest: PluginManifest = {
    id: `claude/${slugifyName(name)}`,
    version,
    title: name,
    ...(asString(meta.description) ? { description: asString(meta.description) } : {}),
    trust: 'community',
    provides: { capabilities: {} },
    requires: { capabilities: {}, entities: {}, roles: {} },
    tools: {},
    mcpServers,
    workflows: [],
    skills,
    records: {},
    importedFrom: { kind: 'claude-plugin', name, ...(asString(meta.version) ? { version: asString(meta.version) } : {}) },
    file: PLUGIN_MANIFEST,
  };
  return { manifest, notes };
}

/** A tool as an MCP server lists it (`tools/list`). */
export interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotationsDef & Record<string, unknown>;
}

/** `contacts` → `contact`, `companies` → `company`, `boxes` → `box`. */
export function singular(word: string): string {
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(ss|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word) && !/ss$/.test(word)) return word.slice(0, -1);
  return word;
}

const props = (schema: unknown): Record<string, Record<string, unknown>> => {
  if (!isRecord(schema) || !isRecord(schema.properties)) return {};
  return Object.fromEntries(Object.entries(schema.properties).filter(([, v]) => isRecord(v))) as Record<string, Record<string, unknown>>;
};
const requiredOf = (schema: unknown): string[] =>
  (isRecord(schema) && Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : []);

/** A JSON Schema property as a value type: strings are Text (Email with `format: email`), numbers Number, booleans Boolean. */
function jsonType(p: Record<string, unknown>): string {
  const type = Array.isArray(p.type) ? p.type.find((t) => t !== 'null') : p.type;
  if (type === 'string') return p.format === 'email' ? 'Email' : 'Text';
  if (type === 'number' || type === 'integer') return 'Number';
  if (type === 'boolean') return 'Boolean';
  return 'Text';
}

/**
 * Record sources found in a server's tools: a `list_<plural>` tool whose output schema has a
 * top-level array of objects becomes `records.<singular>`, read one at a time by `get_<singular>`
 * when there is one. Deterministic; the binder can still map or ignore them.
 */
function inferRecords(server: string, tools: DiscoveredTool[]): RecordSourceDef[] {
  const out: RecordSourceDef[] = [];
  const byName = new Map(tools.map((t) => [t.name, t]));
  for (const t of tools) {
    const m = /^list_([a-z0-9_]+)$/i.exec(t.name);
    if (!m) continue;
    const items = Object.entries(props(t.outputSchema)).find(([, p]) => p.type === 'array' && isRecord(p.items) && (p.items.type === 'object' || isRecord(p.items.properties)));
    if (!items) continue;
    const itemSchema = items[1].items as Record<string, unknown>;
    const itemProps = props(itemSchema);
    const fieldNames = Object.keys(itemProps);
    if (!fieldNames.length) continue;
    const name = singular(m[1]!);
    const key = itemProps.id ? 'id'
      : requiredOf(itemSchema).find((f) => jsonType(itemProps[f] ?? {}) !== 'Number' && itemProps[f]?.type === 'string') ?? fieldNames[0]!;
    const fields = Object.fromEntries(fieldNames.map((f) => [f, jsonType(itemProps[f]!)]));
    const getTool = byName.get(`get_${name}`);
    let get: RecordSourceDef['get'];
    if (getTool) {
      const req = requiredOf(getTool.inputSchema);
      const inputs = Object.keys(props(getTool.inputSchema));
      const arg = req.length === 1 ? req[0] : !req.length && inputs.length === 1 ? inputs[0] : undefined;
      const item = isRecord(props(getTool.outputSchema)[name]) && props(getTool.outputSchema)[name]!.type === 'object' ? name : undefined;
      if (arg) get = { tool: `${server}.${getTool.name}`, arg, ...(item ? { item } : {}) };
    }
    out.push({ name, list: { tool: `${server}.${t.name}`, items: items[0] }, ...(get ? { get } : {}), key, fields });
  }
  return out;
}

/**
 * The manifest with a server's discovered tools added as `<server>.<tool>`: the server's
 * description, schemas and annotations, `run: { mcp: server, tool }` and no effect class (D29).
 * Tools found earlier on the same server are replaced. Record sources are inferred from
 * `list_<plural>` tools (see inferRecords), unless the manifest already has one by that name.
 */
export function withDiscoveredTools(manifest: PluginManifest, server: string, tools: DiscoveredTool[]): PluginManifest {
  const ofServer = (t: PluginToolDef) => 'mcp' in t.run && t.run.mcp === server;
  const kept = Object.values(manifest.tools).filter((t) => !ofServer(t));
  const added = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((t): PluginToolDef => {
    const hints: McpToolAnnotationsDef = {};
    for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
      if (typeof t.annotations?.[k] === 'boolean') hints[k] = t.annotations[k];
    }
    return {
      name: `${server}.${t.name}`,
      description: t.description ?? '',
      inputSchema: isRecord(t.inputSchema) ? t.inputSchema : { type: 'object' },
      ...(isRecord(t.outputSchema) ? { outputSchema: t.outputSchema } : {}),
      ...(Object.keys(hints).length ? { annotations: hints } : {}),
      run: { mcp: server, tool: t.name },
    };
  });
  const serverTools = new Set(added.map((t) => t.name));
  const records = Object.fromEntries(Object.entries(manifest.records)
    .filter(([, r]) => !(r.list.tool.startsWith(`${server}.`) && !serverTools.has(r.list.tool))));
  for (const r of inferRecords(server, tools)) if (!records[r.name] || records[r.name]!.list.tool.startsWith(`${server}.`)) records[r.name] = r;
  return {
    ...manifest,
    tools: Object.fromEntries([...kept, ...added].map((t) => [t.name, t])),
    records,
  };
}
