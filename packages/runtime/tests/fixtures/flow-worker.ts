// A kernel on the flow test project in its own process, so the Phase 6 crash tests can SIGKILL it
// (MEMWISE_CRASH_AT) and start it again.
//
//   bun flow-worker.ts trigger <databaseUrl> <projectDir> <filesDir> <siteNumber>
//       creates the Site (once) and moves it to activating; waits for the dispatcher
//   bun flow-worker.ts handoff <databaseUrl> <projectDir> <filesDir> <runId> <workflowId>
//       starts the run (a no-op when it exists); waits for the dispatcher
//
// Each prints `RESULT {...}` once the dispatcher has settled.
import { PgEntityStore, withActor } from '@memwise/db';
import { createKernel } from '../../src/kernel.ts';

const [mode, databaseUrl, projectDir, filesDir, arg, workflowId] = process.argv.slice(2);
if (!mode || !databaseUrl || !projectDir || !filesDir || !arg) throw new Error('usage: flow-worker.ts trigger|handoff <databaseUrl> <projectDir> <filesDir> <arg> [workflowId]');

const kernel = await createKernel({ databaseUrl, projectDir, tools: [], modelRoles: {}, providers: [], filesDir, logLevel: 'error' });
await kernel.index();
const pool = kernel.pool;

if (mode === 'trigger') {
  const def = (await kernel.project()).project.entities['etmf.Site']!;
  const store = new PgEntityStore();
  const found = await pool.query(`select id from domain.etmf__site where site_number = $1`, [arg]);
  if (!found.rows[0]) {
    await withActor(pool, { kind: 'system' }, async (db) => {
      const id = await store.create(db, def, { site_number: arg, name: `Site ${arg}` });
      await store.transition(db, def, id, { to: 'activating', transition: 'picked' });
    });
  }
  await kernel.triggers.settle(60_000);
  const site = (await pool.query(`select id from domain.etmf__site where site_number = $1`, [arg])).rows[0].id;
  const firings = await pool.query(`select key, status, run_id, case_id from mw.trigger_firings where record = $1`, [site]);
  const runs = await pool.query(
    `select r.id from mw.runs r join mw.cases c on c.id = r.case_id where r.workflow_id = 'activate-site' and c.values -> 'site' ->> 'value' = $1`, [site]);
  process.stdout.write(`RESULT ${JSON.stringify({ firings: firings.rows, runs: runs.rows.length })}\n`);
} else {
  await kernel.startRun({ workflowId: workflowId!, case: { document: 'crash-doc' }, runId: arg });
  await kernel.triggers.settle(60_000);
  if (workflowId === 'hand-on') await kernel.waitForRun(arg, { until: (r) => r.state !== 'start_fix', timeoutMs: 30_000 });
  const links = await pool.query(`select child_run_id, child_case_id from mw.case_links where parent_run_id = $1`, [arg]);
  const run = await kernel.getRun(arg);
  const started = (await kernel.getTransitions(arg)).filter((t) => t.event.type === 'started').length;
  process.stdout.write(`RESULT ${JSON.stringify({ links: links.rows, state: run?.state, started })}\n`);
}
await kernel.shutdown();
process.exit(0);
