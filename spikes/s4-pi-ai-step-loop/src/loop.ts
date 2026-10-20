// The step loop: one DBOS workflow per step execution; inside it every model call, every
// policy decision and every tool call is a DBOS step (journaled in Postgres).
//
// On resume DBOS replays the workflow function: completed steps return their journaled
// output without running, so the message list is rebuilt from the journal and the next
// request is built from exactly the same data as before the crash.

import { DBOS } from "@dbos-inc/dbos-sdk";
import { createModels, type AssistantMessage, type Message, type Model, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { deniedResult, preToolUse, ToolPool } from "./tools.ts";

// ---- model gateway (thin) ------------------------------------------------------------------
const models = createModels();
models.setProvider(anthropicProvider());
const catalogModel = models.getModel("anthropic", process.env.MODEL_ID ?? "claude-sonnet-4-5")!;
// Same catalog model (same compat flags), pointed at the local fake server.
const model: Model<any> = { ...catalogModel, baseUrl: `http://127.0.0.1:${process.env.FAKE_PORT ?? 54399}` };

const SYSTEM_PROMPT = "You are the invoice intake step. Use tools to record the invoice and notify the client.";
const pool = new ToolPool();

// ---- observability: which steps ran vs. were replayed from the journal ----------------------
const runDir = () => process.env.RUN_DIR ?? "data/run";
function progress(step: string, executed: boolean, extra: object = {}) {
  const rec = { at: new Date().toISOString(), pid: process.pid, step, mode: executed ? "executed" : "replayed", ...extra };
  appendFileSync(join(runDir(), "progress.jsonl"), JSON.stringify(rec) + "\n");
  console.log(`[loop] ${rec.mode.padEnd(8)} ${step}`);
}
const pauseMs = Number(process.env.PAUSE_MS ?? 0); // window between steps for an external kill -9

/** Runs fn as a DBOS step and reports whether it actually executed or came from the journal. */
async function journaled<T>(name: string, fn: () => Promise<T>, cfg: object = {}): Promise<T> {
  let executed = false;
  const out = await DBOS.runStep(async () => { executed = true; return fn(); }, { name, ...cfg });
  progress(name, executed);
  if (executed && pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
  return out;
}

/** Step signal: aborts the provider request when DBOS cancels the workflow or the attempt times out. */
function stepSignal(): AbortSignal {
  const st = DBOS.stepStatus;
  return AbortSignal.any([st?.cancelSignal, st?.timeoutSignal].filter((s): s is AbortSignal => !!s));
}

// ---- the model step: stream consumed inside the step, only the final message journaled -----
/** What the model sees besides the messages. Recorded once per step execution, so a resume
 *  uses exactly the prompt and tool schemas the run started with, even after a deploy. */
interface AssembledContext { systemPrompt: string; tools: Tool[] }

async function callModel(ctx: AssembledContext, messages: Message[]): Promise<AssistantMessage> {
  const signal = stepSignal();
  const attempt = { step: DBOS.stepID, attempt: DBOS.stepStatus?.currentAttempt, abortedAtStart: signal.aborted };
  const s = models.stream(model, { systemPrompt: ctx.systemPrompt, messages, tools: ctx.tools }, {
    apiKey: "sk-fake",
    sessionId: DBOS.workflowID, // stable across resume; providers use it for cache affinity
    cacheRetention: "short",
    maxRetries: 0, // retries belong to one layer: the DBOS step policy
    signal,
  });
  for await (const ev of s) {
    // Live deltas would go to the UI here (not journaled; they are re-derivable from the result).
    if (ev.type === "text_delta" && process.env.SHOW_DELTAS) process.stdout.write(ev.delta);
  }
  const msg = await s.result();
  appendFileSync(join(runDir(), "model-attempts.jsonl"), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...attempt, stopReason: msg.stopReason, error: msg.errorMessage }) + "\n");
  if (msg.stopReason === "error" || msg.stopReason === "aborted") {
    throw new Error(`model call failed (${msg.stopReason}): ${msg.errorMessage}`); // DBOS retries the step
  }
  return msg;
}

export interface StepInput { task: string; startedAt: number; maxTurns: number }
export interface StepOutput { text: string; turns: number; usage: { input: number; cacheRead: number; cacheWrite: number }[] }

async function agentStepImpl(input: StepInput): Promise<StepOutput> {
  const wf = DBOS.workflowID!;
  const messages: Message[] = [{ role: "user", content: input.task, timestamp: input.startedAt }];
  const usage: StepOutput["usage"] = [];
  // Context assembly is itself a step (recorded): prompt + tool schemas as plain JSON.
  const ctx = await journaled("context", async (): Promise<AssembledContext> => ({ systemPrompt: SYSTEM_PROMPT, tools: pool.tools }));

  for (let turn = 0; turn < input.maxTurns; turn++) {
    const assistant = await journaled(`model:${turn}`, () => callModel(ctx, messages), {
      retriesAllowed: true, maxAttempts: 3, intervalSeconds: 1, timeoutMS: 120_000,
    });
    messages.push(assistant);
    usage.push({ input: assistant.usage.input, cacheRead: assistant.usage.cacheRead, cacheWrite: assistant.usage.cacheWrite });

    const calls = assistant.content.filter((b): b is ToolCall => b.type === "toolCall");
    if (calls.length === 0) {
      const text = assistant.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return { text, turns: turn + 1, usage };
    }

    for (const call of calls) {
      // Chokepoint 1: PreToolUse policy check, journaled so the decision is replayed, not re-made.
      const decision = await journaled(`policy:${call.id}`, () => preToolUse(call, pool));
      if (!decision.allow) { messages.push(deniedResult(call, decision)); continue; }
      // Chokepoint 2: the tool pool. Idempotency key = workflow id + tool call id (both journaled).
      const idempotencyKey = `${wf}:${call.id}`;
      const result = await journaled(`tool:${call.name}:${call.id}`, () => pool.execute(call, { idempotencyKey, signal: stepSignal() }));
      messages.push(result);
    }
  }
  throw new Error("turn budget exhausted");
}

export const agentStep = DBOS.registerWorkflow(agentStepImpl, { name: "agentStep" });
