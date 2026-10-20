/**
 * The tool and effect gateway (docs/memwise/07-agent-runtime.md §2, §4): classify, ask policy,
 * preview, then run through the effect ledger with secrets injected.
 */
import { crashPoint, type EffectClass, type EffectPreview } from '@memwise/defs';
import { decide, type EffectivePolicy } from '@memwise/policy';
import { resolveEffect } from './effects.ts';
import { redactSecrets } from './redact.ts';
import type {
  GatewayCallResult, GatewayDecision, ToolCallRequest, ToolDefinition, ToolGateway, ToolGatewayOptions,
} from './types.ts';
import { validateArgs } from './validate.ts';

/** Effect classes whose calls go through the ledger. Reads change nothing, so a repeat is harmless. */
const LEDGERED = new Set<EffectClass>(['draft', 'write', 'outbound', 'irreversible']);

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function summarizeArgs(args: unknown, max = 200): string {
  const text = JSON.stringify(args) ?? String(args);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** For tools without their own preview. */
export const genericPreview = (tool: string, args: unknown): EffectPreview => ({
  summary: `${tool} with ${summarizeArgs(args)}`,
  detail: args,
});

export function createToolGateway({ tools, ledger, secrets }: ToolGatewayOptions): ToolGateway {
  const byName = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error(`tool "${tool.name}" is bound twice`);
    byName.set(tool.name, tool);
  }

  async function preview(tool: ToolDefinition, args: unknown): Promise<EffectPreview> {
    if (!tool.preview) return genericPreview(tool.name, args);
    try {
      return await tool.preview(args);
    } catch (e) {
      // A broken preview must not hide the call from the approver.
      const fallback = genericPreview(tool.name, args);
      return { ...fallback, summary: `${fallback.summary} (preview failed: ${errorText(e)})` };
    }
  }

  async function injectSecrets(tool: ToolDefinition, req: ToolCallRequest): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const name of tool.secrets ?? []) {
      const value = secrets ? await secrets.get(name, req.token) : undefined;
      if (value === undefined) throw new Error(`secret "${name}" is not configured for ${tool.name}`);
      out[name] = value;
    }
    return out;
  }

  /** Runs the tool; never throws. Secret values are redacted from the result and from errors. */
  async function run(tool: ToolDefinition, req: ToolCallRequest): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    let injected: Record<string, string> = {};
    try {
      injected = await injectSecrets(tool, req);
      const result = await tool.execute(req.args, { idempotencyKey: req.idempotencyKey, token: req.token, secrets: injected, signal: req.signal });
      return { ok: true, result: redactSecrets(result, Object.values(injected)) };
    } catch (e) {
      return { ok: false, error: redactSecrets(errorText(e), Object.values(injected)) };
    }
  }

  return {
    bound() {
      return Object.fromEntries(tools.map((t) => [t.name, { effect: typeof t.effect === 'string' ? t.effect : undefined }]));
    },

    get: (name) => byName.get(name),

    async check(req, policy: EffectivePolicy, state): Promise<GatewayDecision> {
      const tool = byName.get(req.tool);
      if (!tool) {
        return {
          tool: req.tool, effect: 'irreversible', classified: false,
          decision: { verdict: 'deny', reason: `unknown tool "${req.tool}"; bound tools: ${[...byName.keys()].join(', ') || 'none'}`, origins: [] },
        };
      }
      const { effect, classified } = resolveEffect(tool, req.args);
      const decision = decide(policy, { tool: tool.name, effect, classified, tainted: state.tainted });
      const out: GatewayDecision = { tool: tool.name, effect, classified, decision };
      if (decision.verdict === 'preview' || decision.verdict === 'approve') out.preview = await preview(tool, req.args);
      return out;
    },

    async execute(req, decision): Promise<GatewayCallResult> {
      if (decision.decision.verdict === 'deny') return { status: 'denied', reason: decision.decision.reason };
      const tool = byName.get(req.tool);
      if (!tool) return { status: 'error', error: `unknown tool "${req.tool}"` };

      const problems = validateArgs(tool.inputSchema, req.args);
      if (problems.length > 0) return { status: 'error', error: `invalid arguments for ${tool.name}: ${problems.join('; ')}` };

      // The class journaled with the decision, not a fresh one: the call does what was approved.
      const effect = decision.effect;
      if (!LEDGERED.has(effect)) {
        const r = await run(tool, req);
        return r.ok ? { status: 'ok', result: r.result, effect, replayed: false } : { status: 'error', error: r.error };
      }

      const key = req.idempotencyKey;
      const state = await ledger.begin(key, { stepRunId: req.token.stepRunId, tool: tool.name, effect, args: req.args });
      if (state.status === 'done') return { status: 'ok', result: state.result, effect, replayed: true };
      if (state.status === 'pending' && !tool.idempotent) {
        // 07 §2: the effect may have happened; the provider cannot dedupe a retry, so do not repeat it blindly.
        return { status: 'unknown', reason: `${tool.name} started at ${state.startedAt} and its result was lost; it is not idempotent, so it was not run again` };
      }
      // new, failed, or pending on an idempotent tool (the provider dedupes on the same key).
      const r = await run(tool, req);
      if (!r.ok) {
        await ledger.fail(key, r.error);
        return { status: 'error', error: r.error };
      }
      crashPoint('after-tool-effect', tool.name);
      await ledger.complete(key, r.result);
      crashPoint('after-ledger-complete', tool.name);
      return { status: 'ok', result: r.result, effect, replayed: false };
    },
  };
}
