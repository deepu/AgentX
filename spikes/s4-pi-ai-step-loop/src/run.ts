// Entry point. Starts the agent step workflow, or, if it already exists (a previous process
// was killed), lets DBOS recover it on launch and waits for its result.
//
// Env: WF_ID (workflow id), RUN_DIR (log dir), DB_NAME, FAKE_PORT, PAUSE_MS, TOOL_SLOW_MS

import { DBOS } from "@dbos-inc/dbos-sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentStep, type StepOutput } from "./loop.ts";

const wfId = process.env.WF_ID ?? "s4-demo";
const runDir = process.env.RUN_DIR ?? "data/run";
mkdirSync(runDir, { recursive: true });

DBOS.setConfig({
  name: "s4-step-loop",
  systemDatabaseUrl: `postgresql://postgres@127.0.0.1:54324/${process.env.DB_NAME ?? "s4_dbos"}`,
  logLevel: "warn",
});
await DBOS.launch(); // recovers PENDING workflows of this executor

const existing = await DBOS.getWorkflowStatus(wfId);
console.log(`[run] pid=${process.pid} workflow ${wfId}: ${existing ? `found ${existing.status}, resuming via recovery` : "new"}`);
const handle = existing
  ? DBOS.retrieveWorkflow<StepOutput>(wfId)
  : await DBOS.startWorkflow(agentStep, { workflowID: wfId })({
      task: "Invoice INV-7 from customer C-42 arrived as invoice-7.pdf. Record it and notify their accounts payable.",
      startedAt: Date.parse("2026-10-20T10:00:00Z"),
      maxTurns: 8,
    });

const result = await handle.getResult();
console.log(`[run] result: ${JSON.stringify(result)}`);
writeFileSync(join(runDir, "result.json"), JSON.stringify(result, null, 2));
await DBOS.shutdown();
process.exit(0);
