// Phase 2 in the step engine: system (mechanical) steps, money budgets, and taint on writes.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { CaseValue, StepDef } from '@memwise/defs';
import { createModelGateway, createToolGateway, scriptedProvider, type ToolDefinition } from '@memwise/gateway';
import {
  AGENT_STEP_WORKFLOW, agentStepWorkflow, configureStepEngine, mapArgs, structuralChecks, systemStepWorkflow, SYSTEM_STEP_WORKFLOW,
  type StepEngineDeps, type StepResult, type StepRunInput,
} from '../src/index.ts';
import { MemoryLedger, MemoryRecorder, createDatabase, example, intakeTools, launchDbos, stepInput } from './helpers.ts';

// Registered per file and deregistered after it, so other files in the same process (a kernel) can use the names.
let agentStep: (input: StepRunInput) => Promise<StepResult>;
let systemStep: (input: StepRunInput) => Promise<StepResult>;
let db: Awaited<ReturnType<typeof createDatabase>>;

beforeAll(async () => {
  agentStep = DBOS.registerWorkflow((i: StepRunInput) => agentStepWorkflow(i), { name: AGENT_STEP_WORKFLOW });
  systemStep = DBOS.registerWorkflow((i: StepRunInput) => systemStepWorkflow(i), { name: SYSTEM_STEP_WORKFLOW });
  db = await createDatabase('phase2');
  await launchDbos(db.url);
});
afterAll(async () => {
  await DBOS.shutdown({ deregister: true });
  await db.drop();
});

const clean = example('clean-application');

async function run(body: typeof agentStep, input: StepRunInput, deps: StepEngineDeps): Promise<StepResult> {
  configureStepEngine(deps);
  return (await DBOS.startWorkflow(body, { workflowID: input.stepRunId })(input)).getResult();
}

// ---------------------------------------------------------------- system steps

const created: { args: unknown; key: string }[] = [];
const createCustomer: ToolDefinition<Record<string, unknown>> = {
  name: 'domain.customer.create', description: 'Create a customer.', effect: 'write', idempotent: true,
  inputSchema: { type: 'object', properties: { name: { type: 'string' }, gstin: { type: 'string' }, region: { type: 'string' } }, required: ['name'], additionalProperties: false },
  async execute(args, ctx) {
    created.push({ args, key: ctx.idempotencyKey });
    return { id: `cust_${created.length}` };
  },
};
const failing: ToolDefinition = { ...createCustomer, name: 'crm.broken', async execute() { throw new Error('CRM is down'); } };
const extractor: ToolDefinition = {
  name: 'docs.read', description: 'Read a document.', effect: 'read', quarantine: true,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false }, async execute() { return { legal_name: 'Acme Traders' }; },
};

function onboard(id: string, change: (s: StepDef) => StepDef = (s) => s): StepRunInput {
  const input = stepInput(id, clean, (s) => change({
    ...s, id: 'onboard', title: 'Create the customer', performer: 'system', model: undefined, checkpoint: [], outcomes: ['done'],
    reads: ['case.client_name', 'case.gstin'],
    tools: { allowed: ['domain.customer.create'], required: ['domain.customer.create'] },
    map: { 'domain.customer.create': { name: { case: 'client_name' }, gstin: { case: 'gstin' }, region: { value: 'south' } } },
    writes: { customer: { field: 'customer', type: { kind: 'ref', entity: 'Customer' }, typeSource: 'Ref<Customer>', from: { kind: 'tool', tool: 'domain.customer.create', field: 'id' } } },
  }));
  return input;
}

const systemDeps = (tools: ToolDefinition[], recorder = new MemoryRecorder()) => ({
  tools: createToolGateway({ tools, ledger: new MemoryLedger() }),
  models: createModelGateway({ roles: {}, providers: [] }),
  recorder,
});

describe('system steps', () => {
  test('maps the arguments from the case, calls each required tool once and writes from its result', async () => {
    created.length = 0;
    const recorder = new MemoryRecorder();
    const input = onboard('sys-ok');
    const result = await run(systemStep, input, systemDeps([createCustomer], recorder));
    expect(result).toMatchObject({ status: 'completed', outcome: 'done', tainted: false, usage: { modelCalls: 0, toolCalls: 1 } });
    expect(created).toEqual([{ args: { name: 'Asha Rao', gstin: '29AAACA1234A1Z5', region: 'south' }, key: `${input.stepRunId}:domain.customer.create` }]);
    expect(result.writes.customer).toEqual({
      value: 'cust_1',
      provenance: { kind: 'tool', at: expect.any(String), stepRunId: input.stepRunId, tool: 'domain.customer.create', callId: 'domain.customer.create' },
    });
    expect(recorder.keys(input.stepRunId)).toEqual(['policy:domain.customer.create', 'tool:domain.customer.create']);
    expect(recorder.records.get(input.stepRunId)).toMatchObject({ performer: 'system', status: 'completed', outcome: 'done' });
  });

  test('a refused or failing call ends the step for a person', async () => {
    // The caller compiles the policy into the input; deny the tool there.
    const input = onboard('sys-deny2');
    input.policy = { ...input.policy, tools: { ...input.policy.tools, denied: [{ value: 'domain.customer.create', origin: { layer: 'domain', name: 'domain' } }] } };
    const refused = await run(systemStep, input, systemDeps([createCustomer]));
    expect(refused).toMatchObject({ status: 'needs_person', outcome: 'needs_person' });
    expect(refused.reason).toContain('refused by policy');

    const broken = onboard('sys-broken', (s) => ({ ...s, tools: { allowed: ['crm.broken'], required: ['crm.broken'] }, map: { 'crm.broken': { name: { case: 'client_name' } } }, writes: {} }));
    const r = await run(systemStep, broken, systemDeps([failing]));
    expect(r).toMatchObject({ status: 'needs_person' });
    expect(r.reason).toContain('CRM is down');
  });

  test('a value read from untrusted content is written tainted', async () => {
    const input = onboard('sys-taint', (s) => ({
      ...s, tools: { allowed: ['docs.read'], required: ['docs.read'] }, map: {},
      writes: { legal_name: { field: 'legal_name', type: { kind: 'scalar', name: 'Text' }, typeSource: 'Text', from: { kind: 'tool', tool: 'docs.read', field: 'legal_name' } } },
    }));
    const r = await run(systemStep, input, systemDeps([extractor]));
    expect(r).toMatchObject({ status: 'completed', tainted: true });
    expect(r.writes.legal_name!.provenance).toMatchObject({ kind: 'tool', tool: 'docs.read', tainted: true });
  });

  test('mapArgs: case paths and literals; unset fields are left out', () => {
    const snap = { id: 'c', caseType: 't', seq: 1, values: { a: { value: { b: 2 }, provenance: { kind: 'input', at: '' } } } as Record<string, CaseValue> };
    expect(mapArgs({ x: { case: 'a.b' }, y: { value: 'lit' }, z: { case: 'missing' } }, snap)).toEqual({ x: 2, y: 'lit' });
  });
});

// ---------------------------------------------------------------- money budgets

const priced = (price: { inputPerMTok: number; outputPerMTok: number; currency: string }) => createModelGateway({
  roles: { checker: { provider: 'scripted', model: 'c', price }, verifier: { provider: 'scripted', model: 'v' } },
  providers: [scriptedProvider(clean.model!)],
});
const tools = () => createToolGateway({ tools: intakeTools(clean), ledger: new MemoryLedger() });
const money = (amount: number, currency: string, layer: 'step' | 'workflow') => ({ value: { amount, currency }, origin: { layer, name: 'test' } as const });

describe('money budgets', () => {
  // The scripted provider reports 100 tokens a call: at 1,000,000 per million that is 100 INR a call.
  const rupees = { inputPerMTok: 1_000_000, outputPerMTok: 1_000_000, currency: 'INR' };

  test('a step budget stops the step for a person once spent', async () => {
    const input = stepInput('money-step', clean);
    input.policy = { ...input.policy, budgets: { ...input.policy.budgets, money: money(150, 'INR', 'step') } };
    const r = await run(agentStep, input, { tools: tools(), models: priced(rupees), recorder: new MemoryRecorder() });
    expect(r).toMatchObject({ status: 'needs_person' });
    expect(r.reason).toBe('budget exceeded: money (limit 150 INR for the step, spent 200 INR)');
    expect(r.usage.cost).toEqual({ amount: 200, currency: 'INR' });
  });

  test('a run budget counts what earlier steps spent', async () => {
    const input = stepInput('money-run', clean);
    const rule = money(1000, 'INR', 'workflow');
    input.policy = { ...input.policy, budgets: { ...input.policy.budgets, money: rule }, runBudgets: { ...(input.policy.runBudgets ?? {}), money: rule } };
    input.runSpent = { tokens: 0, modelCalls: 0, elapsedMs: 0, money: { amount: 950, currency: 'INR' } };
    const r = await run(agentStep, input, { tools: tools(), models: priced(rupees), recorder: new MemoryRecorder() });
    expect(r.reason).toBe('budget exceeded: money (limit 1000 INR for the run, spent 1050 INR)');
    expect(r.usage.modelCalls).toBe(1);
  });

  test('spend in another currency is not compared', async () => {
    const input = stepInput('money-usd', clean);
    input.policy = { ...input.policy, budgets: { ...input.policy.budgets, money: money(0.01, 'USD', 'step') } };
    const r = await run(agentStep, input, { tools: tools(), models: priced(rupees), recorder: new MemoryRecorder() });
    expect(r.status).toBe('completed');
  });
});

// ---------------------------------------------------------------- taint on writes

describe('taint on writes', () => {
  test('values from a quarantined tool, and judgement after reading one, are tainted', () => {
    const input = stepInput('taint', clean);
    const evidence = [
      { tool: 'gst.validate_gstin', callId: 'c1', args: {}, result: { valid: true, legal_name: 'Acme Traders Private Limited' } },
      { tool: 'intake.extract_fields', callId: 'c2', args: {}, result: { fields: [] }, tainted: true },
    ];
    const r = structuralChecks(input, { outcome: 'checked', writes: { gstin_ok: true, legal_name: 'Acme Traders Private Limited', flags: [] } }, evidence, ['gst.validate_gstin'], 'now');
    expect(r.passed).toBe(true);
    expect((r.writes.gstin_ok!.provenance as { tainted?: boolean }).tainted).toBeUndefined();
    expect(r.writes.flags!.provenance).toMatchObject({ kind: 'judgement', tainted: true });
  });
});
