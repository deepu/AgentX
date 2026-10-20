// Operator actions through DBOSClient (no workflow code loaded).
//   s2-admin.mjs migrate | resume <id> | cancel <id> | fork <id> <startStep> <version> <newId> | versions
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk';

// Create the database and system tables once, before several workers launch at the same time
// (concurrent first launches race on the migrations table; see RESULT.md).
if (process.argv[2] === 'migrate') {
  await DBOS.migrate(process.env.DBOS_SYSTEM_DATABASE_URL);
  console.log('[admin] migrate ok');
  process.exit(0);
}

const client = await DBOSClient.create({ systemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL, applicationName: 's2' });
const [cmd, id, ...rest] = process.argv.slice(2);
if (cmd === 'resume') await client.resumeWorkflow(id);
else if (cmd === 'cancel') await client.cancelWorkflow(id);
else if (cmd === 'fork') {
  const [startStep, applicationVersion, forkedWorkflowID] = rest;
  const newId = await client.forkWorkflow(id, Number(startStep), { applicationVersion, newWorkflowID: forkedWorkflowID });
  console.log(`[admin] forked ${id} from step ${startStep} as ${newId} on ${applicationVersion}`);
} else if (cmd === 'versions') {
  for (const v of await client.listApplicationVersions()) console.log(`[admin] version ${JSON.stringify(v)}`);
}
console.log(`[admin] ${cmd} ${id ?? ''} ok`);
await client.destroy();
