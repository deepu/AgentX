// Fake Anthropic Messages API for the S4 spike.
//
// - POST /v1/messages: answers with a scripted SSE stream. The reply is chosen by the
//   conversation turn (number of assistant messages in the request), not by a counter,
//   so a repeated request gets the same reply.
// - Every request is appended to <logDir>/requests.jsonl with the raw body bytes and
//   their sha256. This log is the evidence of whether a model call was repeated.
// - Prompt caching is simulated: prefixes up to each cache_control breakpoint are
//   "written"; a later request whose content matches a written prefix reports
//   cache_read_input_tokens. Only a proxy for the real thing: it shows the bytes match.
// - POST /effects/email: a fake external service with Idempotency-Key dedup, logged to
//   <logDir>/effects.jsonl. It stands in for the provider side of an outbound effect.
//
// Env: FAKE_PORT (default 54399), FAKE_LOG_DIR (default data/run), FAKE_SLOW_TURN
// (turn index streamed slowly, for kill-during-model tests), FAKE_SLOW_MS (default 6000).

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.env.FAKE_PORT ?? 54399);
const logDir = process.env.FAKE_LOG_DIR ?? "data/run";
const slowTurn = process.env.FAKE_SLOW_TURN === undefined ? -1 : Number(process.env.FAKE_SLOW_TURN);
const slowMs = Number(process.env.FAKE_SLOW_MS ?? 6000);
mkdirSync(logDir, { recursive: true });

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const log = (file: string, rec: object) => appendFileSync(join(logDir, file), JSON.stringify(rec) + "\n");
let seq = 0;

// ---- scripted conversation -------------------------------------------------------------
type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: object };
const SCRIPT: { blocks: Block[]; stop: "tool_use" | "end_turn" }[] = [
  { stop: "tool_use", blocks: [
    { type: "text", text: "I'll look up the customer first." },
    { type: "tool_use", id: "toolu_t0_lookup", name: "lookup_customer", input: { customer_id: "C-42" } },
  ] },
  { stop: "tool_use", blocks: [ // two parallel tool calls in one turn
    { type: "tool_use", id: "toolu_t1_extract", name: "extract_fields", input: { document: "invoice-7.pdf" } },
    { type: "tool_use", id: "toolu_t1_credit", name: "check_credit", input: { customer_id: "C-42" } },
  ] },
  { stop: "tool_use", blocks: [ // one allowed outbound effect, one call the policy denies
    { type: "text", text: "Recording the invoice and notifying accounts payable." },
    { type: "tool_use", id: "toolu_t2_email", name: "send_email", input: { to: "ap@acme.test", subject: "Invoice INV-7 received", body: "We received invoice INV-7 for 1,250.00 EUR." } },
    { type: "tool_use", id: "toolu_t2_wire", name: "wire_funds", input: { amount: 1250, iban: "DE00 0000" } },
  ] },
  { stop: "end_turn", blocks: [{ type: "text", text: "Done: invoice INV-7 recorded and the client notified. I did not wire funds (blocked by policy)." }] },
];

// ---- cache simulation ------------------------------------------------------------------
// Anthropic caches tools -> system -> messages, up to a block marked with cache_control,
// and on a later request looks back for the longest previously-written prefix.
const written = new Set<string>();
function simulateCache(body: any): { read: number; write: number; uncached: number } {
  const strip = (b: any) => { const { cache_control, ...rest } = b; return rest; };
  const units: { key: string; marked: boolean }[] = [];
  for (const t of body.tools ?? []) units.push({ key: JSON.stringify(strip(t)), marked: !!t.cache_control });
  for (const s of body.system ?? []) units.push({ key: JSON.stringify(strip(s)), marked: !!s.cache_control });
  for (const m of body.messages ?? []) {
    const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    for (const b of content) units.push({ key: m.role + ":" + JSON.stringify(strip(b)), marked: !!b.cache_control });
  }
  const tok = (chars: number) => Math.ceil(chars / 4); // ~4 chars per token
  let acc = "", hitLen = 0, lastMarkLen = 0;
  const prefixes: string[] = [];
  for (const u of units) { acc += u.key + "\u0000"; prefixes.push(acc); }
  for (const p of prefixes) if (written.has(sha(p))) hitLen = p.length;
  units.forEach((u, i) => { if (u.marked) { written.add(sha(prefixes[i])); lastMarkLen = prefixes[i].length; } });
  const read = tok(hitLen);
  const write = Math.max(0, tok(lastMarkLen) - read);
  return { read, write, uncached: Math.max(1, tok(acc.length) - read - write) };
}

// ---- SSE ------------------------------------------------------------------------------
function sseEvents(turn: number, usage: { read: number; write: number; uncached: number }) {
  const step = SCRIPT[Math.min(turn, SCRIPT.length - 1)];
  const ev: [string, object][] = [];
  ev.push(["message_start", { type: "message_start", message: {
    id: `msg_fake_t${turn}`, type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [],
    stop_reason: null, stop_sequence: null,
    usage: { input_tokens: usage.uncached, output_tokens: 1, cache_read_input_tokens: usage.read, cache_creation_input_tokens: usage.write },
  } }]);
  step.blocks.forEach((b, index) => {
    if (b.type === "text") {
      ev.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
      for (const piece of b.text.match(/.{1,12}/gs) ?? []) ev.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: piece } }]);
    } else {
      ev.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } }]);
      for (const piece of JSON.stringify(b.input).match(/.{1,10}/gs) ?? []) ev.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: piece } }]);
    }
    ev.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  ev.push(["message_delta", { type: "message_delta", delta: { stop_reason: step.stop, stop_sequence: null }, usage: { output_tokens: 20 } }]);
  ev.push(["message_stop", { type: "message_stop" }]);
  return ev;
}

// ---- effects service (idempotency-key dedup) --------------------------------------------
const effects = new Map<string, object>();

Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const raw = await req.text();

    if (url.pathname === "/effects/email") {
      const key = req.headers.get("idempotency-key") ?? "";
      const dup = effects.has(key);
      if (!dup) effects.set(key, { messageId: `email-${effects.size + 1}`, acceptedAt: new Date().toISOString() });
      log("effects.jsonl", { at: new Date().toISOString(), key, duplicate: dup, applied: !dup, body: JSON.parse(raw) });
      return Response.json({ ...effects.get(key), duplicate: dup });
    }

    if (url.pathname !== "/v1/messages") return new Response("not found", { status: 404 });
    const body = JSON.parse(raw);
    const turn = (body.messages as any[]).filter((m) => m.role === "assistant").length;
    const usage = simulateCache(body);
    const n = ++seq;
    const headers = Object.fromEntries([...req.headers].filter(([k]) => !["content-length", "host", "connection"].includes(k)));
    log("requests.jsonl", { seq: n, at: new Date().toISOString(), turn, sha256: sha(raw), bytes: raw.length, simulatedUsage: usage, headers, body: raw });
    console.log(`[fake] #${n} turn=${turn} sha=${sha(raw).slice(0, 12)} cache read=${usage.read} write=${usage.write}${turn === slowTurn ? " (slow)" : ""}`);

    const events = sseEvents(turn, usage);
    const delay = turn === slowTurn ? Math.ceil(slowMs / events.length) : 0;
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(ctrl) {
        try {
          for (const [name, data] of events) {
            ctrl.enqueue(enc.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
            if (delay) await Bun.sleep(delay);
          }
          ctrl.close();
          log("responses.jsonl", { seq: n, turn, completed: true });
        } catch {
          log("responses.jsonl", { seq: n, turn, completed: false, note: "client went away mid-stream" });
        }
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "request-id": `req_fake_${n}` } });
  },
});
console.log(`[fake] listening on 127.0.0.1:${port}, logging to ${logDir}, slowTurn=${slowTurn}`);
