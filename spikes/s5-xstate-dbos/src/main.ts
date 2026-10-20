// CLI for the spike.
//   init                                   create our tables and the DBOS data-source schema
//   serve [--start <run> [--timeout-ms N]] [--until-done <run>]
//                                          launch DBOS (recovers pending workflows), optionally start a run
//   send <run> <event> <idemKey> [by] [--for <entered_seq>]  external event: inbox row + DBOS message in one transaction
//   show <run>                             our tables + DBOS journal for the run
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk';
import { readFileSync } from 'node:fs';
import { configureDbos, createRun, DB_URL, driverId, log, migrate, pool } from './runtime.ts';

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

async function serve() {
  configureDbos();
  await DBOS.launch();
  log(`DBOS launched (runtime: ${typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`})`);
  const start = flag('--start');
  if (start) await createRun(start, flag('--timeout-ms') ? Number(flag('--timeout-ms')) : undefined);
  const until = flag('--until-done');
  if (!until) return; // keep serving
  for (;;) {
    const { rows } = await pool.query('select status from mw.runs where id = $1', [until]);
    const wf = await DBOS.getWorkflowStatus(driverId(until));
    if (rows[0]?.status === 'done' && wf?.status === 'SUCCESS') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  log(`run ${until} done; shutting down`);
  await DBOS.shutdown();
  await pool.end();
  process.exit(0);
}

async function send(runId: string, type: string, key: string, by = 'manager', forEntry?: string) {
  const client = await DBOSClient.create({ systemDatabaseUrl: DB_URL });
  const db = await pool.connect();
  const event = { type, by, ...(forEntry ? { for: Number(forEntry) } : {}) };
  try {
    await db.query('begin');
    const ins = await db.query('insert into mw.inbox(run_id, idem_key, event) values ($1,$2,$3) on conflict do nothing', [runId, key, event]);
    // Same database as DBOS's system schema, so the message commits with our inbox row.
    if (ins.rowCount) await client.sendInTransaction(db, driverId(runId), event, 'events', key);
    await db.query('commit');
    log(ins.rowCount ? `sent ${JSON.stringify(event)} to ${driverId(runId)} key=${key}` : `duplicate key ${key}: not sent again`);
  } finally { db.release(); await client.destroy(); await pool.end(); }
}

const fmt = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));

async function show(runId: string) {
  const q = async (title: string, sql: string, params: unknown[] = [runId]) => {
    const { rows } = await pool.query(sql, params);
    console.log(`-- ${title}`);
    if (!rows.length) console.log('   (none)');
    if (rows.length) console.log('   ' + Object.keys(rows[0]).join(' | '));
    for (const r of rows) console.log('   ' + Object.values(r).map(fmt).join(' | '));
  };
  await q('mw.runs', `select id, state, status, seq, entered_seq, snapshot from mw.runs where id = $1`);
  await q('mw.transitions', `select seq, from_state, to_state, event, source, accepted, note, step_wf_id from mw.transitions where run_id = $1 order by seq`);
  await q('mw.timers', `select timer_id, armed_seq, fire_at, status from mw.timers where run_id = $1 order by armed_seq`);
  await q('mw.effects (executions per step workflow)', `select step_wf_id, name, count(*)::int as executions, array_agg(distinct pid) as pids from mw.effects where run_id = $1 group by 1,2 order by min(id)`);
  await q('mw.inbox', `select idem_key, event, at from mw.inbox where run_id = $1 order by at`);
  await q('dbos.workflow_status', `select workflow_uuid, name, status, recovery_attempts from dbos.workflow_status where workflow_uuid = 'run:' || $1 or workflow_uuid like $1 || '/%' order by created_at`);
  await q('dbos.operation_outputs: durable sleeps / recv deadlines of the driver',
    `select function_id, function_name, output as deadline_epoch_ms, to_timestamp(output::bigint / 1000.0) as deadline
       from dbos.operation_outputs where workflow_uuid = 'run:' || $1 and function_name = 'DBOS.sleep' order by function_id`);
  await q('driver journal: dbos.operation_outputs', `select function_id, function_name, child_workflow_id from dbos.operation_outputs where workflow_uuid = 'run:' || $1 order by function_id`);
  await q('driver journal: dbos_tx.transaction_completion (commit outputs written in the same tx as our rows; deleted by DBOS once the workflow finishes)',
    `select function_num, left(output, 60) as output from dbos_tx.transaction_completion where workflow_id = 'run:' || $1 order by function_num`);
  await q('invariants', `select (select count(*) from mw.transitions where run_id = $1)::int as transition_rows,
      (select coalesce(max(seq), 0) from mw.transitions where run_id = $1) as max_seq,
      (select seq from mw.runs where id = $1) as run_seq,
      (select coalesce(max(n), 0) from (select count(*) n from mw.effects where run_id = $1 group by step_wf_id, name) x)::int as max_executions_per_effect`);
  await pool.end();
}

switch (cmd) {
  case 'init': await migrate(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')); await pool.end(); log('migrated'); break;
  case 'serve': await serve(); break;
  case 'send': await send(args[0], args[1], args[2], args[3], flag('--for')); break;
  case 'show': await show(args[0]); break;
  default: console.log('usage: main.ts init | serve [--start r --timeout-ms n] [--until-done r] | send r event key [by] [--for n] | show r'); process.exit(1);
}
