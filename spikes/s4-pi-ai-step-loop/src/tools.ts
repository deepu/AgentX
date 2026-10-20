// The two chokepoints, in miniature:
//   preToolUse(): the PreToolUse-style policy check that runs before every tool step
//   ToolPool:     the place every tool call goes through (cf. mcp-pool.ts): effect class,
//                 idempotency key, side-effect journal
// In MemWise both would be the shared effect gateway used by the open engine too.

import { Type, validateToolArguments, type Tool, type ToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

export type EffectClass = "read" | "draft" | "outbound" | "irreversible";

export interface ToolContext {
  idempotencyKey: string; // stable across crash/resume: derived from workflow id + tool call id
  signal: AbortSignal;
}

interface PoolEntry {
  tool: Tool;
  effect: EffectClass;
  execute(args: any, ctx: ToolContext): Promise<string>;
}

const logDir = () => process.env.RUN_DIR ?? "data/run";
const fakeBase = () => `http://127.0.0.1:${process.env.FAKE_PORT ?? 54399}`;

/** Side-effect counter: one line per tool execution phase, written outside DBOS. */
function sideEffect(rec: object) {
  appendFileSync(join(logDir(), "tool-executions.jsonl"), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...rec }) + "\n");
}

const entries: PoolEntry[] = [
  {
    effect: "read",
    tool: { name: "lookup_customer", description: "Look up a customer record", parameters: Type.Object({ customer_id: Type.String() }) },
    execute: async (a) => JSON.stringify({ id: a.customer_id, name: "Acme GmbH", ap_email: "ap@acme.test" }),
  },
  {
    effect: "read",
    tool: { name: "extract_fields", description: "Extract invoice fields from a document", parameters: Type.Object({ document: Type.String() }) },
    execute: async () => JSON.stringify({ invoice: "INV-7", amount: "1250.00", currency: "EUR" }),
  },
  {
    effect: "read",
    tool: { name: "check_credit", description: "Check a customer's credit status", parameters: Type.Object({ customer_id: Type.String() }) },
    execute: async () => JSON.stringify({ status: "good", limit: 10000 }),
  },
  {
    effect: "outbound",
    tool: {
      name: "send_email",
      description: "Send an email",
      parameters: Type.Object({ to: Type.String(), subject: Type.String(), body: Type.String() }),
    },
    // The external service dedups on Idempotency-Key, so a re-run after a crash between
    // "sent" and "step checkpointed" does not send twice.
    execute: async (a, ctx) => {
      const res = await fetch(`${fakeBase()}/effects/email`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": ctx.idempotencyKey },
        body: JSON.stringify(a),
        signal: ctx.signal,
      });
      const out = (await res.json()) as { messageId: string; duplicate: boolean };
      sideEffect({ phase: "effect_sent", tool: "send_email", key: ctx.idempotencyKey, duplicate: out.duplicate });
      const slow = Number(process.env.TOOL_SLOW_MS ?? 0); // window for kill -9 during the tool step
      if (slow) await new Promise((r) => setTimeout(r, slow));
      return JSON.stringify({ sent: true, messageId: out.messageId });
    },
  },
  {
    effect: "irreversible",
    tool: { name: "wire_funds", description: "Wire money", parameters: Type.Object({ amount: Type.Number(), iban: Type.String() }) },
    execute: async () => { throw new Error("never reached without approval"); },
  },
];

export class ToolPool {
  private byName = new Map(entries.map((e) => [e.tool.name, e]));
  /** Tools offered to the model, in a fixed order (stable order matters for the cache prefix). */
  get tools(): Tool[] { return entries.map((e) => e.tool); }
  effectOf(name: string): EffectClass { return this.byName.get(name)?.effect ?? "irreversible"; } // unclassified counts as irreversible

  /** Runs one call. Called inside a DBOS step; returns a complete ToolResultMessage so the
   *  timestamp and duration are journaled with it (the workflow body stays deterministic). */
  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResultMessage> {
    const started = Date.now();
    sideEffect({ phase: "start", tool: call.name, toolCallId: call.id, key: ctx.idempotencyKey });
    let text: string, isError = false;
    try {
      const entry = this.byName.get(call.name);
      if (!entry) throw new Error(`unknown tool ${call.name}`);
      text = await entry.execute(validateToolArguments(entry.tool, call), ctx);
    } catch (e) {
      text = String((e as Error).message ?? e); isError = true;
    }
    sideEffect({ phase: "end", tool: call.name, toolCallId: call.id, key: ctx.idempotencyKey, isError });
    return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError, timestamp: started, durationMs: Date.now() - started };
  }
}

export interface PolicyDecision { allow: boolean; effect: EffectClass; reason: string; at: number }

/** PreToolUse chokepoint: policy, effect class, (later) taint and budget checks. Runs as
 *  its own journaled step so a policy edit between crash and resume cannot change a
 *  decision already acted on. */
export async function preToolUse(call: ToolCall, pool: ToolPool): Promise<PolicyDecision> {
  const effect = pool.effectOf(call.name), at = Date.now();
  if (effect === "irreversible") return { allow: false, effect, at, reason: "irreversible effects need a person's approval (would become an inbox item)" };
  return { allow: true, effect, at, reason: "allowed by step policy" };
}

export function deniedResult(call: ToolCall, d: PolicyDecision): ToolResultMessage {
  return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: `Blocked by policy: ${d.reason}` }], isError: true, timestamp: d.at };
}
