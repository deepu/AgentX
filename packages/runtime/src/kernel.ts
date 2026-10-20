// createKernel: wires the stores, gateways, step engine and run driver onto one database, and
// launches DBOS in this process (D35). DBOS state is process-wide, so one kernel per process;
// shutdown() deregisters everything so a test can create the next one.
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk';
import { NodePostgresDataSource } from '@dbos-inc/node-pg-datasource';
import {
  actorLabel, applyDomainSchema, createPool, domainCreators, entityTableName, migrate, PgApprovalStore, PgCaseStore,
  PgDefinitionStore, PgEffectLedger, PgEntityStore, PgExplanationStore, PgFileStore, PgPeopleStore, PgRateCounter,
  PgStepRecorder, PgStepRecordReader, PgVersionStore, withActor, withTransaction,
} from '@memwise/db';
import {
  indexProject, loadProject, type ApprovalRequest, type CaseValue, type Diagnostic, type EntityTypeDef, type ProjectDefs,
} from '@memwise/defs';
import {
  createModelGateway, createToolGateway, quarantinedRead, type ToolDefinition, type ToolGateway,
} from '@memwise/gateway';
import {
  AGENT_STEP_WORKFLOW, agentStepWorkflow, approvalTopic, configureStepEngine, recallTools, SYSTEM_STEP_WORKFLOW, systemStepWorkflow, type StepRunInput,
} from '@memwise/step-engine';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { initialTransition } from 'xstate';
import { createAuthoring } from './authoring.ts';
import { authoringTools } from './authoring-tools.ts';
import { ChangeFeed } from './changes.ts';
import { domainTools } from './domain-tools.ts';
import { applyTimerActions, outsideEventRefusal, registerRunDriver } from './driver.ts';
import { EXPLAINER_ROLE, explainStep } from './explain.ts';
import { EXTRACTOR_ROLE, quarantinedExtractTool } from './extract.ts';
import { driverIdOf, newCaseId, newRunId } from './ids.ts';
import { compileMachine, type RunEvent } from './machine.ts';
import { caseToExample } from './replay.ts';
import { getRunRecord, getTransitions, latestWorkflowDef, loadWorkflowDef } from './runs.ts';
import { ensureSandbox, SAMPLE_PLUGIN } from './sample-tools.ts';
import { startValueErrors, StartRunError } from './start.ts';
import { submitStep } from './submit.ts';
import { defaultTestRunner } from './test-runner.ts';
import type { Actor, Authoring, EntityRow, Explanation, Kernel, KernelOptions, RunRecord, StartRunInput } from './types.ts';
import { approverRoles, DefinitionCache, getCaseView, inbox, listCases, liveCounts, mayApprove } from './views.ts';

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

/** The default object store for uploads (19 §5). */
export function defaultFilesDir(): string {
  return process.env.MEMWISE_FILES_DIR ?? join(homedir(), '.memwise', 'files');
}

/** Identifies a set of entity definitions: names and content, so any edit changes it. */
function entitiesKey(entities: Record<string, EntityTypeDef>): string {
  return JSON.stringify(Object.keys(entities).sort().map((name) => [name, entities[name]]));
}

/** Entity types as last indexed, for a kernel started without a project folder. */
async function indexedEntities(pool: import('pg').Pool): Promise<Record<string, EntityTypeDef>> {
  const { rows } = await pool.query(
    `select distinct on (id) id, body from mw.definitions where kind = 'entity_type' order by id, indexed_at desc`);
  return Object.fromEntries(rows.map((r) => [r.id, r.body]));
}

export async function createKernel(options: KernelOptions): Promise<Kernel> {
  if (DBOS.isInitialized()) throw new Error('a kernel is already running in this process (DBOS is process-wide)');
  const url = options.databaseUrl;
  const pool = createPool(url, { max: 10, applicationName: 'memwise-kernel' });
  await migrateAll(url, pool, { sandbox: options.tools.some((t) => t.source?.plugin === SAMPLE_PLUGIN) });

  const reader = new PgStepRecordReader(pool);
  const approvals = new PgApprovalStore(pool);
  const cases = new PgCaseStore();
  const people = new PgPeopleStore(pool);
  const files = new PgFileStore(options.filesDir ?? defaultFilesDir());
  const entityStore = new PgEntityStore();
  const explanations = new PgExplanationStore();
  const defs = new DefinitionCache(pool);
  const feed = new ChangeFeed(url);
  const models = createModelGateway({ roles: options.modelRoles, providers: options.providers });

  // The project as last indexed (or loaded at start), for the domain tools and the app.
  let indexed: { project: ProjectDefs; diagnostics: Diagnostic[] } | undefined;
  if (options.projectDir) indexed = await loadProject(options.projectDir);
  let entities = indexed ? indexed.project.entities : await indexedEntities(pool);

  // The real extractor, unless the caller binds its own `intake.extract_fields` (e.g. the stub).
  const extractor = quarantinedExtractTool({
    role: options.extractorRole ?? EXTRACTOR_ROLE,
    readFile: (id) => files.read(pool, id),
    getCase: (caseId) => cases.get(pool, caseId),
    async read({ role, file, fields, sessionId }) {
      const schema = Object.fromEntries(Object.entries(fields).map(([k, description]) => [k, { type: 'string', description }]));
      const r = await quarantinedRead({ models, role, text: file.text, fields: schema, sessionId, label: file.name });
      return r.values;
    },
  });

  // Drafts and change control (Phase 3), when the kernel has a project folder; its `playbooks.*`
  // tools are bound after the caller's, so an example case's stubs win.
  let authoring: Authoring | undefined;
  const playbookTools = options.projectDir ? authoringTools(() => authoring, () => pool) : [];

  // Rebuilt when indexing changes the entity types; the step engine always calls the current one.
  const buildTools = () => createToolGateway({
    tools: uniqueTools([...options.tools, ...recallTools(reader), ...domainTools(entities, () => pool), extractor, ...playbookTools]),
    ledger: new PgEffectLedger(pool),
    secrets: options.secrets,
    rates: new PgRateCounter(pool),
  });
  let gateway = buildTools();
  const tools: ToolGateway = {
    bound: () => gateway.bound(),
    get: (name) => gateway.get(name),
    check: (req, policy, state) => gateway.check(req, policy, state),
    execute: (req, decision) => gateway.execute(req, decision),
  };
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
  // DBOS marks a function object as registered and keeps the mark after deregistering, so a
  // second kernel in the same process registers fresh wrappers, never the shared bodies themselves.
  const agentBody = options.stepExecutor ?? agentStepWorkflow;
  const stepWorkflow = DBOS.registerWorkflow((input: StepRunInput) => agentBody(input), { name: AGENT_STEP_WORKFLOW });
  const systemWorkflow = DBOS.registerWorkflow((input: StepRunInput) => systemStepWorkflow(input), { name: SYSTEM_STEP_WORKFLOW });
  const { driver } = registerRunDriver({ pool, dataSource, stepWorkflow, systemWorkflow });
  await DBOS.launch(); // also recovers this executor's pending drivers and steps
  // startRun commits the run before it starts the driver; a crash in between leaves an active run
  // with no driver. Start one for every active run: the id is fixed, so an existing driver
  // (recovered above, or owned by another executor) is returned, never run twice.
  const active = await pool.query(`select id from mw.runs where status = 'active' order by created_at, id`);
  for (const { id } of active.rows) await DBOS.startWorkflow(driver, { workflowID: driverIdOf(id) })(id);
  const client = await DBOSClient.create({ systemDatabaseUrl: url });

  const getRun = (runId: string) => getRunRecord(pool, runId);
  const versionStore = new PgVersionStore();

  /**
   * Records live hashes the version index hasn't seen as `files` (first start, or a file edited
   * outside MemWise), and warns when one reuses a version number another hash already had.
   */
  async function recordVersions(project: ProjectDefs): Promise<Diagnostic[]> {
    const live = Object.values(project.workflows);
    await versionStore.recordFound(pool, live.map((w) => ({ workflowId: w.id, version: w.version, hash: w.hash })));
    const { rows } = await pool.query(
      `select workflow_id, version, hash from mw.workflow_versions where workflow_id = any($1::text[])`, [live.map((w) => w.id)]);
    const out: Diagnostic[] = [];
    for (const w of live) {
      const reused = rows.find((r) => r.workflow_id === w.id && r.version === w.version && r.hash !== w.hash);
      if (!reused) continue;
      out.push({
        severity: 'warning', code: 'version-not-bumped', file: `${w.dir}/workflow.yaml`, path: 'version',
        message: `${w.id} changed outside review without a new version: version ${w.version} was already published with different content; set \`version: ${Math.max(...rows.filter((r) => r.workflow_id === w.id).map((r) => r.version as number)) + 1}\``,
      });
    }
    return out;
  }

  /** startRun; `internal`: the kernel itself starting a case may set any field (a change run's draft). */
  async function start(input: StartRunInput, internal = false): Promise<{ runId: string; caseId: string }> {
    const workflow = input.workflowHash
      ? await loadWorkflowDef(pool, input.workflowId, input.workflowHash)
      : await latestWorkflowDef(pool, input.workflowId);
    if (!workflow) throw new Error(`workflow ${input.workflowId} is not indexed`);
    const errors = startValueErrors(workflow, input.case, { ...entities, ...workflow.caseType.types }, input.startAt, { anyField: internal });
    if (Object.keys(errors).length) throw new StartRunError(errors);
    const runId = input.runId ?? newRunId();
    const caseId = await withTransaction(pool, async (db) => {
      const existing = await db.query('select case_id from mw.runs where id = $1', [runId]);
      if (existing.rows[0]) return existing.rows[0].case_id as string;
      const id = newCaseId();
      const at = new Date().toISOString();
      const values: Record<string, CaseValue> = {};
      for (const [k, v] of Object.entries(input.case)) {
        if (v === null || v === undefined) continue;
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
  }
  const entityDef = (name: string): EntityTypeDef | undefined =>
    entities[name] ?? Object.values(entities).find((e) => entityTableName(e.entity) === name || e.entity.toLowerCase() === name.toLowerCase());

  const kernel: Kernel = {
    pool,
    people,

    async index() {
      if (!options.projectDir) throw new Error('createKernel({ projectDir }) is needed to index');
      const loaded = await loadProject(options.projectDir);
      const { project } = loaded;
      await indexProject(project, new PgDefinitionStore(pool));
      await people.syncRoles(project.roles);
      const notes = await applyDomainSchema(pool, project.entities, { creators: domainCreators(project.entities, project.workflows) });
      const diagnostics = [
        ...loaded.diagnostics, ...notes.map((message): Diagnostic => ({ severity: 'warning', code: 'domain-column-type', message })),
        ...(await recordVersions(project)),
      ];
      indexed = { project, diagnostics };
      // The domain tools capture each entity's definition (its fields, the create tool's schema):
      // rebuild them when any entity type is added, removed or changed, not only added.
      const changed = entitiesKey(project.entities) !== entitiesKey(entities);
      entities = project.entities;
      if (changed) gateway = buildTools();
      feed.emit({ kind: 'definitions' });
      return diagnostics;
    },

    startRun: (input) => start(input),

    async sendEvent(runId, event, { idemKey, forSeq, by }) {
      const ev: RunEvent = typeof event === 'string' ? { type: event } : { ...event };
      return withTransaction(pool, async (db) => {
        // Every outside event names the state entry it answers; by default the one current now,
        // so an event queued while the driver is busy can never move a later state too.
        const run = await db.query('select entered_seq, state, workflow_id, workflow_hash from mw.runs where id = $1 for update', [runId]);
        const r = run.rows[0];
        if (!r) throw new Error(`no run ${runId}`);
        // Checked against the state now, under the run's lock: a person step only through submitStep.
        const refused = outsideEventRefusal(await defs.workflow(r.workflow_id, r.workflow_hash), r.state, by);
        if (refused) return { sent: false, ...refused };
        // The sender, never what the caller wrote in the event: the transition row records who decided.
        if (by?.kind === 'person') ev.by = by.personId;
        ev.for = forSeq ?? (r.entered_seq as number);
        const ins = await db.query(
          `insert into mw.inbox (run_id, idem_key, event, for_seq) values ($1, $2, $3, $4) on conflict do nothing`,
          [runId, idemKey, JSON.stringify(ev), ev.for]);
        // Same database as DBOS's system schema: the message commits with the inbox row.
        if (ins.rowCount) await client.sendInTransaction(db, driverIdOf(runId), ev, 'events', `${runId}:${idemKey}`);
        return { sent: !!ins.rowCount };
      });
    },

    async decideApproval(decision, by?: Actor) {
      return withTransaction(pool, async (db) => {
        const store = new PgApprovalStore(db);
        const current = await store.get(decision.id);
        if (!current) return { applied: false, status: 'missing' as const };
        if (current.status !== 'pending') return { applied: false, status: current.status };
        // Only a step still waiting can take the answer; one that timed out or stopped has moved
        // on (the driver marks its approvals expired when it commits the step's result).
        const step = await db.query('select status, workflow_id, workflow_hash, step_id from mw.step_runs where id = $1 for update', [current.stepRunId]);
        if (step.rows[0]?.status !== 'waiting') return { applied: false, status: 'expired' as const };
        if (by) {
          const s = step.rows[0];
          const wf = await defs.workflow(s.workflow_id, s.workflow_hash);
          if (!mayApprove(by, approverRoles(await defs.policy(wf, s.step_id), wf, s.step_id))) {
            return { applied: false, status: 'forbidden' as const };
          }
        }
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
      const pending = await approvals.pending();
      // Only approvals a waiting step can still act on.
      const { rows } = await pool.query(`select id from mw.step_runs where status = 'waiting' and id = any($1)`,
        [pending.map((a) => a.stepRunId)]);
      const waiting = new Set(rows.map((r) => r.id as string));
      return pending.filter((a) => waiting.has(a.stepRunId)).map(({ status, decidedBy, comment, decidedAt, ...request }) => request);
    },

    // ---------------------------------------------------------------- Phase 2

    submitStep: (input) => submitStep({
      withTransaction: (fn) => withTransaction(pool, fn),
      workflow: (id, hash) => defs.workflow(id, hash),
      entities: () => entities,
      client,
    }, input),

    inbox: (actor) => inbox(pool, defs, actor),
    listCases: (filter, actor) => listCases(pool, defs, filter, actor),
    getCaseView: (caseId, actor) => getCaseView(pool, defs, caseId, actor),
    liveCounts: (workflowId) => liveCounts(pool, workflowId),

    async explain({ stepRunId, question, by }): Promise<Explanation> {
      const record = await reader.get(stepRunId);
      if (!record) throw new Error(`no step record ${stepRunId}`);
      const extra = await pool.query('select decided_by, comment from mw.step_runs where id = $1', [stepRunId]);
      const workflow = await defs.workflow(record.workflowId, record.workflowHash).catch(() => undefined);
      const roles = Object.keys(options.modelRoles);
      const stepRole = workflow?.steps[record.stepId]?.model;
      const role = roles.includes(EXPLAINER_ROLE) ? EXPLAINER_ROLE : stepRole && roles.includes(stepRole) ? stepRole : roles[0];
      if (!role) throw new Error('no model role is configured to explain a step (add an `explainer` role)');
      const r = await explainStep(models, role, {
        ...record, ...(extra.rows[0]?.decided_by ? { decidedBy: extra.rows[0].decided_by } : {}),
        ...(extra.rows[0]?.comment ? { comment: extra.rows[0].comment } : {}),
      }, workflow, question, by);
      const saved = await explanations.save(pool, { ...r, by: actorLabel(by) });
      return { id: saved.id, stepRunId: saved.stepRunId, question: saved.question, answer: saved.answer, cites: saved.cites, grounded: saved.grounded, at: saved.at };
    },

    async listEntities(entity, actor): Promise<EntityRow[]> {
      const def = entityDef(entity);
      if (!def) throw new Error(`no entity type ${entity}`);
      const rows = await withActor(pool, actor, (db) => entityStore.list(db, def));
      return rows.map((r) => ({ id: r.id, values: r.values, hidden: r.hidden, createdAt: r.createdAt }));
    },

    saveFile: (input, actor) => withActor(pool, actor, (db) => files.save(db, input, actorLabel(actor))),
    readFile: (id, actor) => withActor(pool, actor, (db) => files.read(db, id)),

    async project() {
      if (!indexed) {
        if (!options.projectDir) throw new Error('createKernel({ projectDir }) is needed for the project');
        indexed = await loadProject(options.projectDir);
      }
      return indexed;
    },

    async effectivePolicy(workflowId, stepId) {
      const wf = await defs.latest(workflowId);
      if (!wf) throw new Error(`workflow ${workflowId} is not indexed`);
      if (!wf.steps[stepId]) throw new Error(`workflow ${workflowId} has no step ${stepId}`);
      return defs.policy(wf, stepId);
    },

    onChange: (listener) => feed.subscribe(listener),

    // ---------------------------------------------------------------- Phase 3

    async versions(workflowId) {
      const rows = await versionStore.list(pool, workflowId);
      const open = await pool.query(
        `select workflow_hash, count(*)::int as n from mw.runs where workflow_id = $1 and status = 'active' group by workflow_hash`, [workflowId]);
      const openBy = new Map(open.rows.map((r) => [r.workflow_hash as string, r.n as number]));
      const liveHash = indexed?.project.workflows[workflowId]?.hash ?? (await latestWorkflowDef(pool, workflowId))?.hash;
      return rows.map((v) => ({ ...v, openCases: openBy.get(v.hash) ?? 0, live: v.hash === liveHash }));
    },

    get authoring() { return authoring; },

    caseToExample: (caseId, opts) => caseToExample(pool, defs, caseId, opts),

    async shutdown() {
      await feed.close();
      await DBOS.shutdown({ deregister: true });
      await client.destroy();
      await pool.end();
    },
  };
  if (options.projectDir) {
    authoring = createAuthoring({
      projectDir: options.projectDir,
      pool,
      tools: () => gateway,
      project: () => kernel.project(),
      index: () => kernel.index(),
      startRun: (input) => start(input, true),
      getRun,
      caseToExample: (caseId, opts) => kernel.caseToExample(caseId, opts),
      testRunner: options.testRunner ?? defaultTestRunner({ adminUrl: options.testDatabaseUrl }),
      emit: (change) => feed.emit(change),
    });
  }
  return kernel;
}

export type { RunRecord };
