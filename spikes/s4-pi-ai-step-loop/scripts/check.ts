// Compares each crash scenario against the uncrashed baseline using the fake server's
// request log, the tool side-effect log, the effects service log and the loop's progress log.
//   [SUFFIX=-opus] bun scripts/check.ts [scenario...]

import { existsSync, readFileSync } from "node:fs";

const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const suffix = process.env.SUFFIX ?? "";
const load = (name: string) => {
  const d = `data/${name}${suffix}`;
  return {
    requests: read(`${d}/requests.jsonl`),
    responses: read(`${d}/responses.jsonl`),
    tools: read(`${d}/tool-executions.jsonl`),
    effects: read(`${d}/effects.jsonl`),
    progress: read(`${d}/progress.jsonl`),
    // Compare what the step produced; usage legitimately differs when a call was repeated.
    result: existsSync(`${d}/result.json`) ? (({ text, turns }) => JSON.stringify({ text, turns }))(JSON.parse(readFileSync(`${d}/result.json`, "utf8"))) : "(none)",
  };
};

const base = load("baseline");
const baseShaByTurn = new Map(base.requests.map((r: any) => [r.turn, r.sha256]));
let allOk = true;

for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["baseline", "kill-between", "kill-after-tool", "kill-in-tool", "kill-in-model", "cancel-in-model"]) {
  const s = load(name);
  const pids = [...new Set(s.progress.map((p: any) => p.pid))];
  if (!s.requests.length) { console.log(`\n=== ${name}${suffix}: no data, skipped`); continue; }
  console.log(`\n=== ${name}${suffix}  (processes: ${pids.join(" -> ")})`);

  console.log("model requests received by the fake server:");
  for (const r of s.requests) {
    const same = baseShaByTurn.get(r.turn) === r.sha256;
    const resp = s.responses.find((x: any) => x.seq === r.seq);
    console.log(`  #${r.seq} turn=${r.turn} sha256=${r.sha256.slice(0, 16)} bytes=${r.bytes} ${same ? "== baseline" : "!= BASELINE"} stream=${resp ? (resp.completed ? "completed" : "cut") : "?"} simCache(read=${r.simulatedUsage.read},write=${r.simulatedUsage.write})`);
  }
  const perTurn = new Map<number, number>();
  for (const r of s.requests) perTurn.set(r.turn, (perTurn.get(r.turn) ?? 0) + 1);
  const repeatedTurns = [...perTurn].filter(([, n]) => n > 1).map(([t, n]) => `turn ${t} x${n}`);
  const bodiesMatch = s.requests.every((r: any) => baseShaByTurn.get(r.turn) === r.sha256);

  const starts = s.tools.filter((t: any) => t.phase === "start");
  const perCall = new Map<string, number>();
  for (const t of starts) perCall.set(t.toolCallId, (perCall.get(t.toolCallId) ?? 0) + 1);
  const repeatedTools = [...perCall].filter(([, n]) => n > 1).map(([id, n]) => `${id} x${n}`);
  const applied = s.effects.filter((e: any) => e.applied).length;
  const dups = s.effects.filter((e: any) => e.duplicate).length;

  console.log("steps by process (executed / replayed from journal):");
  for (const pid of pids) {
    const ps = s.progress.filter((p: any) => p.pid === pid);
    console.log(`  pid ${pid}: executed [${ps.filter((p: any) => p.mode === "executed").map((p: any) => p.step).join(", ")}]`);
    const rep = ps.filter((p: any) => p.mode === "replayed").map((p: any) => p.step);
    if (rep.length) console.log(`  pid ${pid}: replayed [${rep.join(", ")}]`);
  }
  console.log(`summary: model requests=${s.requests.length} (baseline ${base.requests.length}); repeated: ${repeatedTurns.join(", ") || "none"}; all bodies byte-identical to baseline: ${bodiesMatch}`);
  console.log(`         tool executions=${starts.length} (baseline ${base.tools.filter((t: any) => t.phase === "start").length}); repeated: ${repeatedTools.join(", ") || "none"}; emails applied=${applied}, deduped=${dups}`);
  const sameResult = s.result === base.result;
  console.log(`         final result equals baseline: ${sameResult}`);
  allOk &&= bodiesMatch && applied === 1 && sameResult;
}
console.log(`\nOVERALL: ${allOk ? "OK" : "MISMATCH"}`);

// ---- prefix stability across turns (what prompt caching depends on) ----------------------
// For each consecutive pair of baseline requests: tools and system must be identical, and the
// earlier request's messages (cache_control markers aside) must be a prefix of the later one's.
// A string message content is shorthand for one text block (the API treats them the same; pi-ai
// switches to the block form when it puts cache_control on that message), so normalize it.
const norm = (b: any) => ({ ...b, messages: b.messages.map((m: any) => typeof m.content === "string" ? { ...m, content: [{ type: "text", text: m.content }] } : m) });
const strip = (v: any): any => Array.isArray(v) ? v.map(strip) : v && typeof v === "object"
  ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "cache_control").map(([k, x]) => [k, strip(x)])) : v;
const markers = (b: any) => {
  const out: string[] = [];
  (b.tools ?? []).forEach((t: any, i: number) => t.cache_control && out.push(`tools[${i}]`));
  (b.system ?? []).forEach((s: any, i: number) => s.cache_control && out.push(`system[${i}]`));
  b.messages.forEach((m: any, i: number) => Array.isArray(m.content) && m.content.forEach((c: any, j: number) => c.cache_control && out.push(`messages[${i}].content[${j}]`)));
  return out.join(", ");
};
console.log(`\nprefix stability across turns (baseline${suffix}):`);
const bodies = base.requests.map((r: any) => norm(JSON.parse(r.body)));
bodies.forEach((b: any, i: number) => console.log(`  turn ${i}: ${b.messages.length} messages; cache_control at ${markers(b)}`));
for (let i = 1; i < bodies.length; i++) {
  const [a, b] = [strip(bodies[i - 1]), strip(bodies[i])];
  const toolsSame = JSON.stringify(a.tools) === JSON.stringify(b.tools);
  const systemSame = JSON.stringify(a.system) === JSON.stringify(b.system);
  const prefix = a.messages.every((m: any, k: number) => JSON.stringify(m) === JSON.stringify(b.messages[k]));
  console.log(`  turn ${i - 1} -> ${i}: tools identical=${toolsSame}, system identical=${systemSame}, earlier messages are a prefix=${prefix}`);
}
