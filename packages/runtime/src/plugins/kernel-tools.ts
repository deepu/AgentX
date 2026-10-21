// The kernel's `plugins.*` and `identity.resolve` tools (22 §8): what the bind-plugin meta
// playbook's steps call. Without a kernel (checks, example cases that stub them) they are
// definitions only: names, classes and schemas; executing one says why it can't.
import type { EffectClass } from '@memwise/defs';
import type { ToolContext, ToolDefinition } from '@memwise/gateway';
import { AUTHORING_PLUGIN } from '../authoring-tools.ts';

export const INSTALL_CHECK_TOOL = 'plugins.install_check';
export const PROPOSE_BINDING_TOOL = 'plugins.propose_binding';
export const CLASSIFY_TOOLS_TOOL = 'plugins.classify_tools';
export const DRY_RUN_TOOL = 'plugins.dry_run';
export const FREEZE_TOOL = 'plugins.freeze';
export const RESOLVE_IDENTITY_TOOL = 'identity.resolve';

export interface InstallCheckResult { outcome: 'ok' | 'missing'; missing: string[]; summary: string; version?: string }
export interface ProposeBindingResult {
  outcome: 'classified' | 'unclassified';
  draft: string;
  /** The tools still unclassified, one per line with what the binder needs: description, annotations, arguments. */
  unclassified?: string;
  /** Tool names still unclassified. */
  unclassified_tools: string[];
  gaps: number;
  summary: string;
  version: string;
}
export interface ClassifyToolsResult { draft: string; classified: string[]; refused: { tool: string; reason: string }[]; unclassified: string[] }
export interface DryRunResult { outcome: 'passed' | 'failed'; hash: string; errors: number; examples_failed: number; summary: string }
export interface FreezeResult { outcome: 'frozen' | 'stale'; version?: number; message?: string }
export interface ResolveIdentityResult { linked: number; candidates: number; unmatched: number; created: number; refreshed?: number }

/** What the tools call; the kernel's plugin service implements it. */
export interface BindingOps {
  installCheck(plugin: string): Promise<InstallCheckResult>;
  propose(plugin: string, ctx: ToolContext): Promise<ProposeBindingResult>;
  classify(input: { draft?: string; classes: Record<string, EffectClass>; reasons?: Record<string, string> }, ctx: ToolContext): Promise<ClassifyToolsResult>;
  dryRun(draft: string, ctx: ToolContext): Promise<DryRunResult>;
  freeze(input: { draft: string; hash: string }, ctx: ToolContext): Promise<FreezeResult>;
  resolveIdentity(plugin: string): Promise<ResolveIdentityResult>;
}

const str = { type: 'string' } as const;
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const EFFECTS = ['read', 'draft', 'write', 'outbound', 'irreversible'];

export function bindingTools(ops?: () => BindingOps | undefined): ToolDefinition[] {
  const source = { plugin: AUTHORING_PLUGIN };
  const need = (): BindingOps => {
    const o = ops?.();
    if (!o) throw new Error('plugins tools need a kernel with a project folder');
    return o;
  };
  const plugin = { ...str, description: 'The plugin id, e.g. memwise/client-intake' };
  const draft = { ...str, description: 'The binding draft id' };

  const installCheck: ToolDefinition<{ plugin: string }, InstallCheckResult> = {
    name: INSTALL_CHECK_TOOL,
    description: 'Check that a plugin can be bound: it is installed, the capabilities it requires have providers, its tool names are free. Says what it can reach.',
    inputSchema: object({ plugin }, ['plugin']),
    effect: 'read',
    source,
    execute: ({ plugin: id }) => need().installCheck(id),
  };

  const propose: ToolDefinition<{ plugin: string }, ProposeBindingResult> = {
    name: PROPOSE_BINDING_TOOL,
    description: 'Propose a binding for the plugin (deterministic: classes, entities, fields, roles, capabilities, record mappings) and write it into a binding draft. An existing binding is the starting point of an upgrade.',
    inputSchema: object({ plugin }, ['plugin']),
    effect: 'draft',
    idempotent: true,
    source,
    execute: ({ plugin: id }, ctx) => need().propose(id, ctx),
  };

  const classify: ToolDefinition<{ draft?: string; classes: Record<string, EffectClass>; reasons?: Record<string, string> }, ClassifyToolsResult> = {
    name: CLASSIFY_TOOLS_TOOL,
    description: 'Set the effect class of plugin tools in a binding draft, with a reason for each. A class looser than the one the plugin declares is refused.',
    inputSchema: object({
      draft: { ...draft, description: "The binding draft id; default the draft this case's run is making" },
      classes: { type: 'object', additionalProperties: { type: 'string', enum: EFFECTS }, description: 'Tool name → read | draft | write | outbound | irreversible' },
      reasons: { type: 'object', additionalProperties: str, description: 'Tool name → why, in one plain sentence' },
    }, ['classes']),
    effect: 'draft',
    idempotent: true,
    source,
    execute: (args, ctx) => need().classify(args, ctx),
  };

  const dryRun: ToolDefinition<{ draft: string }, DryRunResult> = {
    name: DRY_RUN_TOOL,
    description: "Dry-run a binding draft: the domain's checks with the binding applied, the plugin's example cases through it, its mappings on sample records, and for an upgrade how each workflow changes. Writes report.json.",
    inputSchema: object({ draft }, ['draft']),
    effect: 'read',
    source,
    execute: ({ draft: id }, ctx) => need().dryRun(id, ctx),
  };

  const freeze: ToolDefinition<{ draft: string; hash: string }, FreezeResult> = {
    name: FREEZE_TOOL,
    description: 'Freeze a reviewed binding draft as the next binding version, if it has not changed since its dry run; its tools and workflows go live.',
    inputSchema: object({ draft, hash: { ...str, description: 'The content hash the dry run passed' } }, ['draft', 'hash']),
    effect: 'write',
    idempotent: true,
    source,
    execute: (args, ctx) => need().freeze(args, ctx),
  };

  const resolveIdentity: ToolDefinition<{ plugin: string }, ResolveIdentityResult> = {
    name: RESOLVE_IDENTITY_TOOL,
    description: "Link the plugin's records to domain records: confident matches link, uncertain ones go to a person, the rest are created or left unlinked.",
    inputSchema: object({ plugin }, ['plugin']),
    effect: 'write',
    idempotent: true,
    source,
    execute: ({ plugin: id }) => need().resolveIdentity(id),
  };

  return [installCheck, propose, classify, dryRun, freeze, resolveIdentity];
}

/** The definitions alone, for checks (`memwise check`) and for stubbing in example cases. */
export function bindingToolDefinitions(): ToolDefinition[] {
  return bindingTools();
}
