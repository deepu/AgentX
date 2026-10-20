// Plugin tools (22 §2, §3): every tool of every frozen binding, not `off`, as a ToolDefinition
// the gateway binds. Its class is the binding's, else the manifest's, else none (the gateway
// treats an unclassified tool as irreversible, D29). Its route decides how it runs.
import {
  PLUGIN_MANIFEST, pluginsDirOf, type BindingDef, type Diagnostic, type EffectClass, type InstalledPlugin, type PluginManifest, type PluginToolDef,
  type ProjectDefs,
} from '@memwise/defs';
import type { ToolDefinition } from '@memwise/gateway';
import type { PluginPolicy } from '@memwise/policy';
import { resolve } from 'node:path';
import { McpConnections, runCommandTool } from './routes.ts';

/** Tool name prefixes the kernel keeps for itself (22 §2): a plugin may not bind them. */
export const RESERVED_TOOL_PREFIXES = ['domain.', 'recall.', 'playbooks.', 'plugins.', 'identity.', 'step.', 'checkpoint.', 'explain.'];
export const isReservedToolName = (name: string) => RESERVED_TOOL_PREFIXES.some((p) => name.startsWith(p));

/** A binding with the installed plugin version it pins. */
export interface BoundPlugin {
  binding: BindingDef;
  manifest: PluginManifest;
  /** Relative to the project root: `plugins/<slug>/<version>`. */
  dir: string;
  plugin: InstalledPlugin;
}

/**
 * The bindings `loadProject` counted (frozen ones; with `unfrozen`, a draft's too) with the
 * installed version each pins. One whose version is missing is left out (loadProject reports it).
 */
export function boundPlugins(project: Pick<ProjectDefs, 'plugins' | 'bindings' | 'pluginVersions'>): BoundPlugin[] {
  const out: BoundPlugin[] = [];
  for (const binding of Object.values(project.bindings ?? {}).sort((a, b) => a.plugin.localeCompare(b.plugin))) {
    const p = project.pluginVersions?.[binding.plugin]?.[binding.pluginVersion]
      ?? (project.plugins?.[binding.plugin]?.manifest.version === binding.pluginVersion ? project.plugins[binding.plugin] : undefined);
    if (!p) continue;
    out.push({ binding, manifest: p.manifest, dir: p.dir, plugin: p });
  }
  return out;
}

/** A tool's class in this domain and where it came from (the binding's wins, D29). */
export function toolClass(tool: PluginToolDef, binding?: BindingDef): { effect?: EffectClass; from: 'declared' | 'annotations' | 'binding' | 'none'; off?: boolean } {
  const b = binding?.tools[tool.name];
  if (b?.off) return { ...(b.effect ?? tool.effect ? { effect: b.effect ?? tool.effect } : {}), from: b.effect ? 'binding' : tool.effect ? 'declared' : 'none', off: true };
  if (b?.effect) return { effect: b.effect, from: 'binding' };
  if (tool.effect) return { effect: tool.effect, from: 'declared' };
  return { from: 'none' };
}

/** What each bound plugin contributes to policy layers (pluginLayers in @memwise/policy). */
export function pluginPolicies(bound: BoundPlugin[]): PluginPolicy[] {
  return bound.map(({ binding, manifest, dir }) => ({
    plugin: manifest.id,
    ...(manifest.policy ? { policy: manifest.policy, source: `${dir}/${manifest.file || PLUGIN_MANIFEST}` } : {}),
    ...(binding.policy ? { bindingPolicy: binding.policy, bindingSource: binding.file } : {}),
    tools: Object.values(manifest.tools).filter((t) => !binding.tools[t.name]?.off).map((t) => t.name).sort(),
  }));
}

/** The kernel's names for checks: every bound plugin tool with its class and schema, no connection made. */
export function pluginToolEnvironment(bound: BoundPlugin[]): Record<string, { effect?: EffectClass; inputSchema?: Record<string, unknown> }> {
  const out: Record<string, { effect?: EffectClass; inputSchema?: Record<string, unknown> }> = {};
  for (const { binding, manifest } of bound) {
    for (const tool of Object.values(manifest.tools)) {
      const c = toolClass(tool, binding);
      if (c.off || out[tool.name]) continue;
      out[tool.name] = { ...(c.effect ? { effect: c.effect } : {}), inputSchema: tool.inputSchema };
    }
  }
  return out;
}

export interface PluginToolDeps {
  /** Absolute project folder (plugin folders are relative to it). */
  root: string;
  /** Implementations for `run: { builtin }`, by name. */
  builtins: Map<string, ToolDefinition>;
  mcp: McpConnections;
}

/** One plugin tool as the gateway binds it. */
export function pluginTool(tool: PluginToolDef, bp: BoundPlugin, deps: PluginToolDeps): ToolDefinition {
  const { manifest, binding } = bp;
  // A plugin folder is relative to the project (for a draft folder, the project it belongs to).
  const root = resolve(pluginsDirOf(deps.root).base, bp.dir);
  const cls = toolClass(tool, binding);
  const route = tool.run;
  const builtin = 'builtin' in route ? deps.builtins.get(route.builtin) : undefined;
  const quarantine = tool.quarantine ?? builtin?.quarantine;
  const idempotent = tool.idempotent ?? builtin?.idempotent;
  const secrets = tool.secrets ?? builtin?.secrets;
  return {
    name: tool.name,
    description: tool.description || builtin?.description || tool.name,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    ...(cls.effect ? { effect: cls.effect } : {}),
    ...(quarantine ? { quarantine } : {}),
    ...(idempotent ? { idempotent } : {}),
    ...(secrets?.length ? { secrets } : {}),
    ...(builtin?.preview ? { preview: builtin.preview.bind(builtin) } : {}),
    source: {
      plugin: manifest.id,
      ...('mcp' in route ? { mcpServer: route.mcp } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    },
    async execute(args, ctx) {
      if ('builtin' in route) {
        const impl = deps.builtins.get(route.builtin);
        if (!impl) throw new Error(`${tool.name} runs the built-in tool ${route.builtin}, which this app does not have`);
        return impl.execute(args, ctx);
      }
      if ('mcp' in route) {
        const server = manifest.mcpServers[route.mcp];
        if (!server) throw new Error(`${tool.name} runs on the MCP server ${route.mcp}, which ${manifest.id} does not declare`);
        return deps.mcp.call({
          key: `${manifest.id}@${manifest.version}/${route.mcp}`, server, serverName: route.mcp, root, tool: route.tool, args,
          idempotencyKey: ctx.idempotencyKey, ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      }
      return runCommandTool({
        command: route.command, args, root, idempotencyKey: ctx.idempotencyKey, tool: tool.name,
        ...(route.timeoutMs ? { timeoutMs: route.timeoutMs } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    },
  };
}

/**
 * The tools of every bound plugin, given the names already bound (the caller's tools, the
 * kernel's): a plugin tool whose name is reserved or taken is not bound, with a diagnostic;
 * except a `builtin` route whose built-in is the very tool already bound under that name
 * (the sample tools, the kernel's extractor), which stays as it is.
 */
export function pluginTools(bound: BoundPlugin[], taken: Map<string, ToolDefinition>, deps: PluginToolDeps): { tools: ToolDefinition[]; diagnostics: Diagnostic[] } {
  const tools: ToolDefinition[] = [];
  const diagnostics: Diagnostic[] = [];
  const mine = new Map<string, string>();
  for (const bp of bound) {
    for (const tool of Object.values(bp.manifest.tools)) {
      if (toolClass(tool, bp.binding).off) continue;
      if (isReservedToolName(tool.name)) {
        diagnostics.push({ severity: 'error', code: 'tool-name-reserved', file: bp.binding.file, message: `${bp.manifest.id}: \`${tool.name}\` is a name the kernel keeps for itself, so it is not bound` });
        continue;
      }
      const other = mine.get(tool.name);
      if (other) {
        diagnostics.push({ severity: 'error', code: 'tool-name-taken', file: bp.binding.file, message: `${bp.manifest.id}: \`${tool.name}\` is already bound by ${other}, so it is not bound again` });
        continue;
      }
      const existing = taken.get(tool.name);
      if (existing) {
        const sameBuiltin = 'builtin' in tool.run && tool.run.builtin === tool.name;
        if (!sameBuiltin) {
          diagnostics.push({ severity: 'warning', code: 'tool-name-taken', file: bp.binding.file, message: `${bp.manifest.id}: \`${tool.name}\` is already bound${existing.source?.plugin ? ` by ${existing.source.plugin}` : ''}, so the plugin's is not bound` });
        }
        mine.set(tool.name, bp.manifest.id);
        continue;
      }
      mine.set(tool.name, bp.manifest.id);
      tools.push(pluginTool(tool, bp, deps));
    }
  }
  return { tools, diagnostics };
}
