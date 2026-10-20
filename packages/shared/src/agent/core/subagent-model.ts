/**
 * Model choice for Claude subagents.
 *
 * Subagents re-read their whole context on every step, and without a `model` on the Agent call
 * they run on the session's model (often Opus with a 1M window). MemWise fills in the call's `model`
 * from the decision model's pick for that task (toggle `subagentModels`) or, without an answer,
 * from the user's Settings default — and only ever with a model cheaper than the session's.
 */

import type { SubagentModel } from '../../config/storage.ts';

/** Claude model families, cheapest first. */
const FAMILY_RANK = { haiku: 0, sonnet: 1, opus: 2, fable: 3 } as const;
type ClaudeFamily = keyof typeof FAMILY_RANK;

/**
 * Built-in agent types that run on the session's model (`model: inherit` in the bundled CLI; an
 * Agent call without `subagent_type` runs general-purpose). Every other type is left alone: a
 * call's `model` takes precedence over the agent definition's own model, so filling it would move
 * custom agents (`.claude/agents`) and pinned built-ins (statusline-setup) off the model they chose.
 */
const INHERITING_AGENT_TYPES = new Set(['general-purpose', 'Explore', 'Plan']);

/** The family of a Claude model id (`claude-opus-5-5[1m]` → `opus`), or undefined for other models. */
export function claudeModelFamily(model: string | undefined): ClaudeFamily | undefined {
  const id = model?.toLowerCase() ?? '';
  if (!id.includes('claude')) return undefined;
  return (Object.keys(FAMILY_RANK) as ClaudeFamily[]).find(family => id.includes(family));
}

/** One subagent task, as the Agent call describes it. */
export interface SubagentTask {
  description?: string;
  prompt: string;
  subagentType?: string;
}

/**
 * Host-installed choice for one task: a model, `'session'` to keep the session's model (a hard
 * task), or `null` without an answer (feature off, unsure, failed) so the Settings default applies.
 */
export type SubagentModelPicker = (task: SubagentTask, context: { configured?: SubagentModel }) => Promise<SubagentModel | 'session' | null>;

/**
 * The `model` to set on an Agent call, or undefined to leave the call as it is. Only calls to the
 * built-in agents that inherit the session's model are changed (not forks, custom agents or calls
 * that name a model), and nothing is set unless it is cheaper than the session's model.
 */
export async function chooseSubagentModel(
  input: Record<string, unknown>,
  sessionModel: string | undefined,
  options: { configured?: SubagentModel; picker?: SubagentModelPicker | null },
): Promise<SubagentModel | undefined> {
  if (input.model !== undefined || typeof input.prompt !== 'string') return undefined;
  if (!INHERITING_AGENT_TYPES.has(typeof input.subagent_type === 'string' ? input.subagent_type : 'general-purpose')) return undefined;
  const sessionFamily = claudeModelFamily(sessionModel);
  if (!sessionFamily || sessionFamily === 'haiku') return undefined;

  let picked: SubagentModel | 'session' | null = null;
  if (options.picker) {
    try {
      picked = await options.picker({
        prompt: input.prompt,
        ...(typeof input.description === 'string' ? { description: input.description } : {}),
        ...(typeof input.subagent_type === 'string' ? { subagentType: input.subagent_type } : {}),
      }, { configured: options.configured });
    } catch {
      picked = null;
    }
  }
  if (picked === 'session') return undefined;
  const model = picked ?? options.configured;
  return model && FAMILY_RANK[model] < FAMILY_RANK[sessionFamily] ? model : undefined;
}
