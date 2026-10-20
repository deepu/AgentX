/**
 * Effect classes of tools (docs/memwise/06-plugins-and-tools.md §3, D29).
 */
import { EFFECT_CLASSES, type EffectClass } from '@memwise/defs';
import type { McpToolAnnotations, ToolDefinition } from './types.ts';

/**
 * Seed a class from MCP tool annotations, conservatively. Only explicit hints count, because
 * the MCP defaults (destructive and open-world unless said otherwise) say nothing about what
 * a tool really does:
 *
 *   destructiveHint: true                   -> irreversible (wins over a contradictory readOnlyHint)
 *   readOnlyHint: true                      -> read
 *   openWorldHint: true (not read-only)     -> outbound
 *   anything else                           -> undefined (unclassified, treated as irreversible)
 *
 * A seed is a proposal: a person confirms the class at binding (06 §4), so `resolveEffect`
 * does not read annotations. `@memwise/shared` keeps an identical copy (`src/mcp/mcp-pool.ts`)
 * because it must not depend on kernel packages; change both together.
 */
export function effectFromAnnotations(a: McpToolAnnotations | undefined): EffectClass | undefined {
  if (!a) return undefined;
  if (a.destructiveHint === true) return 'irreversible';
  if (a.readOnlyHint === true) return 'read';
  if (a.openWorldHint === true) return 'outbound';
  return undefined;
}

const isEffectClass = (v: unknown): v is EffectClass => (EFFECT_CLASSES as readonly unknown[]).includes(v);

/**
 * The class of one call: the declared class, or the declared function of the arguments.
 * Undeclared (or a function that throws or returns nonsense) is `irreversible`, unclassified.
 */
export function resolveEffect(tool: Pick<ToolDefinition, 'effect'>, args: unknown): { effect: EffectClass; classified: boolean } {
  const declared = tool.effect;
  if (typeof declared === 'function') {
    try {
      const effect = declared(args);
      if (isEffectClass(effect)) return { effect, classified: true };
    } catch {
      // Arguments the function cannot classify: fall through to the strictest class.
    }
    return { effect: 'irreversible', classified: false };
  }
  if (isEffectClass(declared)) return { effect: declared, classified: true };
  return { effect: 'irreversible', classified: false };
}
