// Cancels (or resumes) the workflow from outside the worker, as an operator or the run
// engine would. Used to check that DBOS's step cancelSignal reaches pi-ai's abort signal.
//   bun scripts/cancel.ts cancel|resume
import { DBOSClient } from "@dbos-inc/dbos-sdk";

const client = await DBOSClient.create({ systemDatabaseUrl: `postgresql://postgres@127.0.0.1:54324/${process.env.DB_NAME}` });
const id = process.env.WF_ID ?? "s4-invoice-intake";
if (process.argv[2] === "resume") await client.resumeWorkflow(id);
else await client.cancelWorkflow(id);
console.log(`[cancel.ts] ${process.argv[2] ?? "cancel"} ${id} at ${new Date().toISOString()}`);
await client.destroy();
