// S1 · DBOS under Bun (and Node for comparison).
//
//   <runtime> s1.mjs worker [workflowID]   launch DBOS; recovers pending workflows of this
//                                          executor+version; if workflowID is given, starts it.
//                                          Waits for the workflow result, then exits.
//   <runtime> s1.mjs send <workflowID>     DBOSClient (outside any workflow): read the
//                                          'progress' event, then send the 'approval' message.
//
// Every step appends START/END lines to $LEDGER (a plain file outside the DB), so
// re-execution after a crash is visible: completed steps must not appear twice.
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk';
import { appendFileSync } from 'node:fs';

const DB_URL = process.env.DBOS_SYSTEM_DATABASE_URL;
const LEDGER = process.env.LEDGER ?? 'out/ledger.log';
const RUNTIME = typeof Bun !== 'undefined' ? `bun-${Bun.version}` : `node-${process.versions.node}`;
const SLEEP_MS = Number(process.env.SLEEP_MS ?? 10_000);

const log = (line) => appendFileSync(LEDGER, `${new Date().toISOString()} pid=${process.pid} ${RUNTIME} ${line}\n`);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// A step: logs START, works for `ms`, logs END. A kill between START and END means the step
// never checkpointed, so it runs again on recovery (at-least-once for the in-flight step).
const step = (name, ms) => DBOS.runStep(async () => {
  log(`START ${name}`);
  await pause(ms);
  log(`END   ${name}`);
  return `${name}-ok`;
}, { name });

async function orderWorkflow(orderId) {
  log(`BODY  enter workflow ${DBOS.workflowID}`); // re-runs on every replay (not a step)
  const a = await step('reserve', 500);
  const b = await step('charge', 500);
  await DBOS.setEvent('progress', { stage: 'charged', a, b });

  const t0 = await DBOS.now(); // durable clock read: replays the original value
  log(`SLEEP begin (durable ${SLEEP_MS} ms, first started at ${new Date(t0).toISOString()})`);
  await DBOS.sleep(SLEEP_MS); // wake-up time is checkpointed; a restart sleeps only the remainder
  log(`SLEEP end (${Date.now() - t0} ms after original start)`);

  await DBOS.setEvent('progress', { stage: 'awaiting-approval' });
  const approval = await DBOS.recv('approval', { timeoutSeconds: 300 });
  log(`RECV  approval=${JSON.stringify(approval)}`);

  const c = await step('ship', 4000); // long enough to kill mid-step
  await DBOS.setEvent('progress', { stage: 'done' });
  return { orderId, a, b, c, approval };
}
const orderWf = DBOS.registerWorkflow(orderWorkflow, { name: 'orderWorkflow' });

const [cmd, wfid] = process.argv.slice(2);
if (cmd === 'send') {
  const client = await DBOSClient.create({ systemDatabaseUrl: DB_URL, applicationName: 's1' });
  const ev = await client.getEvent(wfid, 'progress', 5);
  console.log(`[send] progress event before send: ${JSON.stringify(ev)}`);
  await client.send(wfid, { by: 'manager', ok: true }, 'approval', `approve-${wfid}`);
  console.log('[send] approval sent');
  await client.destroy();
} else if (cmd === 'worker') {
  DBOS.setConfig({ name: 's1', systemDatabaseUrl: DB_URL, applicationVersion: 's1-v1', logLevel: 'info' });
  await DBOS.launch(); // recovery of PENDING workflows happens here
  console.log(`[worker ${RUNTIME}] launched, version=${DBOS.applicationVersion} executor=${DBOS.executorID}`);
  if (wfid) await DBOS.startWorkflow(orderWf, { workflowID: wfid })('order-42');
  const pending = await DBOS.listWorkflows({ status: ['PENDING', 'ENQUEUED'], applicationVersion: DBOS.applicationVersion });
  for (const w of pending) {
    const res = await DBOS.retrieveWorkflow(w.workflowID).getResult();
    console.log(`[worker] ${w.workflowID} result: ${JSON.stringify(res)}`);
  }
  await DBOS.shutdown();
} else {
  console.error('usage: s1.mjs worker [workflowID] | send <workflowID>');
  process.exit(1);
}
