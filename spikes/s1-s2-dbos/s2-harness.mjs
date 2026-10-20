// S2 harness shared by the definition files (s2-def-*.mjs). Each definition file registers a
// workflow named 'caseWorkflow' with different step code, then calls startWorker().
//
//   <runtime> s2-def-X.mjs worker [caseID ...]
// env: DBOS_SYSTEM_DATABASE_URL, LEDGER, SLEEP_MS
//      EXECUTOR_ID  (default 'local', DBOS's default)
//      APP_VERSION  (override the version the file declares; used to show a mislabelled deploy)
//      PATCHING=1   (enablePatching: version becomes the constant 'PATCHING_ENABLED')
// The worker stays up (like a server) until killed; the driver kills it.
import { DBOS } from '@dbos-inc/dbos-sdk';
import { appendFileSync } from 'node:fs';

export const SLEEP_MS = Number(process.env.SLEEP_MS ?? 8000);
const LEDGER = process.env.LEDGER ?? 'out/s2.ledger';
let CODE = '?';

export const log = (line) => appendFileSync(LEDGER,
  `${new Date().toISOString().slice(11, 23)} code=${CODE} ver=${DBOS.applicationVersion} exec=${DBOS.executorID} ` +
  `${(DBOS.workflowID ?? '-').padEnd(7)} ${line}\n`);

export const step = (name) => DBOS.runStep(async () => {
  log(`STEP  ${name}`);
  await new Promise((r) => setTimeout(r, 300));
  return name;
}, { name });

export const sleep = async () => { log('SLEEP begin'); await DBOS.sleep(SLEEP_MS); };

export async function startWorker(code, workflowFn, declaredVersion) {
  CODE = code;
  const wf = DBOS.registerWorkflow(workflowFn, { name: 'caseWorkflow' });
  const patching = process.env.PATCHING === '1';
  DBOS.setConfig({
    name: 's2',
    systemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL,
    applicationVersion: patching ? undefined : (process.env.APP_VERSION ?? declaredVersion),
    enablePatching: patching,
    executorID: process.env.EXECUTOR_ID ?? 'local',
    logLevel: 'info',
  });
  await DBOS.launch();
  log(`WORKER up (latest version in DB: ${(await DBOS.getLatestApplicationVersion()).versionName})`);
  for (const id of process.argv.slice(3)) {
    const h = await DBOS.startWorkflow(wf, { workflowID: id })(id);
    h.getResult().then((r) => log(`DONE  ${id} ${JSON.stringify(r)}`), (e) => log(`ERROR ${id} ${e.message.split('\n')[0]}`));
  }
  setInterval(() => {}, 1 << 30); // stay up
}
