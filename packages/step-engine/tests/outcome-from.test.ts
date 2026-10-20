// Phase 3: a system step's outcome taken from a tool's result (`outcomeFrom`).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { StepDef } from '@memwise/defs';
import { createModelGateway, createToolGateway, type ToolDefinition } from '@memwise/gateway';
import {
  configureStepEngine, outcomeOf, systemStepWorkflow, SYSTEM_STEP_WORKFLOW, type StepResult, type StepRunInput,
} from '../src/index.ts';
import { MemoryLedger, MemoryRecorder, createDatabase, example, launchDbos, stepInput } from './helpers.ts';

let systemStep: (input: StepRunInput) => Promise<StepResult>;
let db: Awaited<ReturnType<typeof createDatabase>>;

beforeAll(async () => {
  systemStep = DBOS.registerWorkflow((i: StepRunInput) => systemStepWorkflow(i), { name: SYSTEM_STEP_WORKFLOW });
  db = await createDatabase('outcome_from');
  await launchDbos(db.url);
});
afterAll(async () => {
  await DBOS.shutdown({ deregister: true });
  await db.drop();
});

const clean = example('clean-application');

/** A check tool that answers whatever the test sets. */
let answer: unknown = { outcome: 'passed', errors: 0 };
const checkTool: ToolDefinition = {
  name: 'playbooks.check_draft', description: 'Check a draft.', effect: 'read',
  inputSchema: { type: 'object', properties: { draft: { type: 'string' } }, required: ['draft'], additionalProperties: false },
  async execute() { return structuredClone(answer); },
};

function checkStep(id: string): StepRunInput {
  return stepInput(id, clean, (s): StepDef => ({
    ...s, id: 'check', title: 'Check the draft', performer: 'system', model: undefined, checkpoint: [], outcomes: ['passed', 'failed'],
    reads: ['case.client_name'],
    tools: { allowed: ['playbooks.check_draft'], required: ['playbooks.check_draft'] },
    map: { 'playbooks.check_draft': { draft: { case: 'client_name' } } },
    outcomeFrom: { tool: 'playbooks.check_draft', field: 'outcome' },
    writes: {},
  }));
}

async function run(input: StepRunInput): Promise<StepResult> {
  configureStepEngine({
    tools: createToolGateway({ tools: [checkTool], ledger: new MemoryLedger() }),
    models: createModelGateway({ roles: {}, providers: [] }),
    recorder: new MemoryRecorder(),
  });
  return (await DBOS.startWorkflow(systemStep, { workflowID: input.stepRunId })(input)).getResult();
}

describe('outcomeFrom', () => {
  test('the outcome is the named field of the tool result', async () => {
    answer = { outcome: 'passed' };
    expect(await run(checkStep('of-passed'))).toMatchObject({ status: 'completed', outcome: 'passed' });
    answer = { outcome: 'failed', errors: 2 };
    expect(await run(checkStep('of-failed'))).toMatchObject({ status: 'completed', outcome: 'failed' });
  });

  test('a missing or undeclared value ends the step for a person, saying what came back', async () => {
    answer = { errors: 0 };
    const missing = await run(checkStep('of-missing'));
    expect(missing).toMatchObject({ status: 'needs_person', outcome: 'needs_person' });
    expect(missing.reason).toContain('returned no outcome');
    answer = { outcome: 'maybe' };
    const unknown = await run(checkStep('of-unknown'));
    expect(unknown).toMatchObject({ status: 'needs_person' });
    expect(unknown.reason).toContain('"maybe"');
    expect(unknown.reason).toContain('passed, failed');
  });

  test('outcomeOf: without outcomeFrom the only outcome; a tool that was not called', () => {
    const step = checkStep('pure').step;
    expect(outcomeOf({ ...step, outcomeFrom: undefined, outcomes: ['done'] }, {})).toEqual({ outcome: 'done' });
    expect(outcomeOf(step, {})).toEqual({ reason: expect.stringContaining('did not call') });
    expect(outcomeOf({ ...step, outcomeFrom: { tool: 'playbooks.check_draft', field: 'result.outcome' } }, { 'playbooks.check_draft': { result: { result: { outcome: 'failed' } } } }))
      .toEqual({ outcome: 'failed' });
  });
});
