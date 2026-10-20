// createKernel: wires the stores, gateways, step engine and run driver onto one database, and
// launches DBOS in this process (D35). DBOS state is process-wide, so one kernel per process;
// shutdown() deregisters everything so a test can create the next one.
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk';
import { NodePostgresDataSource } from '@dbos-inc/node-pg-datasource';
import {
  createPool, migrate, PgApprovalStore, PgCaseStore, PgDefinitionStore, PgEffectLedger, PgStepRecorder,
  PgStepRecordReader, withTransaction,
} from '@memwise/db';
import { indexProject, loadProject, type ApprovalRequest, type CaseValue } from '@memwise/defs';
import { createModelGateway, createToolGateway, type ToolDefinition } from '@memwise/gateway';
import { AGENT_STEP_WORKFLOW, agentStepWorkflow, approvalTopic, configureStepEngine, recallTools } from '@memwise/step-engine';
import { initialTransition } from 'xstate';
import { applyTimerActions, registerRunDriver } from './driver.ts';
import { driverIdOf, newCaseId, newRunId } from './ids.ts';
import { compileMachine, type RunEvent } from './machine.ts';
import { getRunRecord, getTransitions, latestWorkflowDef, loadWorkflowDef } from './runs.ts';
import { ensureSandbox, SAMPLE_PLUGIN } from './sample-tools.ts';
import type { Kernel, KernelOptions, RunRecord } from './types.ts';

export const DEFAULT_ENGINE_VERSION = 'memwise-kernel-1';
/** Schema of the DBOS data source's commit records (spike S5). */
const TX_SCHEMA = 'dbos_tx';

/** Our schema, DBOS's system schema and its data-source schema. Run once before workers start (D35). */
export async function migrateAll(databaseUrl: string, pool = createPool(databaseUrl, { max: 2 }), opts: { sandbox?: boolean } = {}) {
  await migrate(pool);
  await NodePostgresDataSource.initializeDBOSSchema({ connectionString: databaseUrl }, TX_SCHEMA);
  await DBOS.migrate(databaseUrl);
  if (opts.sandbox) await ensureSandbox(pool);
}

/** Tools by name; later entries don't replace earlier ones (the caller's own tools win). */
function uniqueTools(tools: ToolDefinition[]): ToolDefinition[] {
  const seen = new Map<string, ToolDefinition>();
  for (const t of tools) if (!seen.has(t.name)) seen.set(t.name, t);
  return [...seen.values()];
}

export async function createKernel(options: KernelOptions): Promise<Kernel> {
  if (DBOS.isInitialized()) throw new Error('a kernel is already running in this process (DBOS is process-wide)');
  const url = options.databaseUrl;
  const pool = createPool(url, { max: 10, applicationName: 'memwise-kernel' });
  await migrateAll(url, pool, { sandbox: options.tools.some((t) => t.source?.plugin === SAMPLE_PLUGIN) });

  const reader = new PgStepRecordReader(pool);
  const approvals = new PgApprovalStore(pool);
  const cases = new PgCaseStore();
  const tools = createToolGateway({
    tools: uniqueTools([...options.tools, ...recallTools(reader)]),
    ledger: new PgEffectLedger(pool),
    secrets: options.secrets,
  });
  const models = createModelGateway({ roles: options.modelRoles, providers: options.providers });
  configureStepEngine({ tools, models, recorder: new PgStepRecorder(pool), records: reader });

  DBOS.setConfig({
    name: 'memwise',
    systemDatabaseUrl: url, // same database as our tables, so inbox rows and messages commit together
    applicationVersion: options.engineVersion ?? DEFAULT_ENGINE_VERSION,
    executorID: options.executorId ?? 'local',
    logLevel: options.logLevel ?? process.env.DBOS_LOG ?? 'warn',
    runMigrations: false, // done above, once, before launch (D35)
  });
  const dataSource = new NodePostgresDataSource('memwise', { connectionString: url, max: 5 }, TX_SCHEMA);
  const stepWorkflow = DBOS.registerWorkflow(options.stepExecutor ?? agentStepWorkflow, { name: AGENT_STEP_WORKFLOW });
  const { driver } = registerRunDriver({ pool, dataSource, stepWorkflow });
  await DBOS.launch(); // also recovers this executor's pending drivers and steps
  const client = await DBOSClient.create({ systemDatabaseUrl: url });

  const getRun = (runId: string) => getRunRecord(pool, runId);

  const kernel: Kernel = {
    pool,

    async index() {
      if (!options.projectDir) throw new Error('createKernel({ projectDir }) is needed to index');
      const { project, diagnostics } = await loadProject(options.projectDir);
      await indexProject(project, new PgDefinitionStore(pool));
      return diagnostics;
    },

    async startRun(input) {
      const workflow = input.workflowHash
        ? await loadWorkflowDef(pool, input.workflowId, input.workflowHash)
        : await latestWorkflowDef(pool, input.workflowId);
      if (!workflow) throw new Error(`workflow ${input.workflowId} is not indexed`);
      const runId = input.runId ?? newRunId();
      const caseId = await withTransaction(pool, async (db) => {
        const existing = await db.query('select case_id from mw.runs where id = $1', [runId]);
        if (existing.rows[0]) return existing.rows[0].case_id as string;
        const id = newCaseId();
        const at = new Date().toISOString();
        const values: Record<string, CaseValue> = {};
        for (const [k, v] of Object.entries(input.case)) {
          values[k] = { value: v, provenance: { kind: 'input', at, ...(input.by ? { by: input.by } : {}) } };
        }
        await cases.create(db, { id, caseType: workflow.caseType.id, workflowId: workflow.id, workflowHash: workflow.hash, values });
        // Entering the first state can arm timers, exactly like any later entry.
        const machine = compileMachine(workflow, input.startAt ?? workflow.start);
        const [snap, actions] = initialTransition(machine);
        await db.query(
          `insert into mw.runs (id, workflow_id, workflow_version, workflow_hash, case_id, state, status, snapshot, driver_wf_id)
           values ($1, $2, $3, $4, $5, $6, 'active', $7, $8)`,
          [runId, workflow.id, workflow.version, workflow.hash, id, String(snap.value),
            JSON.stringify(machine.getPersistedSnapshot(snap)), driverIdOf(runId)]);
        await applyTimerActions(db, runId, 0, actions);
        return id;
      });
      // Fixed workflow id: starting twice returns the same driver.
      await DBOS.startWorkflow(driver, { workflowID: driverIdOf(runId) })(runId);
      return { runId, caseId };
    },

    async sendEvent(runId, event, { idemKey, forSeq }) {
      const ev: RunEvent = typeof event === 'string' ? { type: event } : { ...event };
      if (forSeq !== undefined) ev.for = forSeq;
      return withTransaction(pool, async (db) => {
        const ins = await db.query(
          `insert into mw.inbox (run_id, idem_key, event, for_seq) values ($1, $2, $3, $4) on conflict do nothing`,
          [runId, idemKey, JSON.stringify(ev), forSeq ?? null]);
        // Same database as DBOS's system schema: the message commits with the inbox row.
        if (ins.rowCount) await client.sendInTransaction(db, driverIdOf(runId), ev, 'events', `${runId}:${idemKey}`);
        return { sent: !!ins.rowCount };
      });
    },

    async decideApproval(decision) {
      return withTransaction(pool, async (db) => {
        const store = new PgApprovalStore(db);
        const current = await store.get(decision.id);
        if (!current) return { applied: false, status: 'missing' as const };
        if (!(await store.decide(db, decision))) return { applied: false, status: current.status };
        await client.sendInTransaction(db, current.stepRunId, decision, approvalTopic(decision.id), `approval:${decision.id}`);
        return { applied: true, status: decision.status };
      });
    },

    async waitForRun(runId, { until, timeoutMs }) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const run = await getRun(runId);
        if (run && until(run)) return run;
        if (Date.now() > deadline) {
          throw new Error(`timed out after ${timeoutMs} ms waiting for run ${runId} (now ${run ? `${run.state}/${run.status}` : 'missing'})`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    },

    getRun,
    getTransitions: (runId) => getTransitions(pool, runId),
    getCase: (caseId) => cases.get(pool, caseId),
    getStepRecord: (stepRunId) => reader.get(stepRunId),

    async pendingApprovals(): Promise<ApprovalRequest[]> {
      return (await approvals.pending()).map(({ status, decidedBy, comment, decidedAt, ...request }) => request);
    },

    async shutdown() {
      await DBOS.shutdown({ deregister: true });
      await client.destroy();
      await pool.end();
    },
  };
  return kernel;
}

export type { RunRecord };
