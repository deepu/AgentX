// Literature (docs/memwise/25-literature-poc.md §3, §4) in the step engine: quotes on judgement
// writes (D81), checked deterministically before a step finishes, with a repair round when a
// quote isn't in a source; and system steps that call a tool once per item of a list (`each`),
// with `item.<path>`, `{ today }` and `{ now }` arguments.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { ScriptedTurn, StepDef, WriteDef } from '@memwise/defs';
import { createModelGateway, createToolGateway, type ToolDefinition } from '@memwise/gateway';
import {
  AGENT_STEP_WORKFLOW, agentStepWorkflow, assembleContext, configureStepEngine, finishToolParameters, localDate, mapArgs, quoteProblem,
  structuralChecks, systemStepWorkflow, SYSTEM_STEP_WORKFLOW, type Evidence, type StepEngineDeps, type StepResult, type StepRunInput,
} from '../src/index.ts';
import { FakeTools, MemoryLedger, MemoryRecorder, createDatabase, example, intakeTools, launchDbos, realGateways, stepInput } from './helpers.ts';

let agentStep: (input: StepRunInput) => Promise<StepResult>;
let systemStep: (input: StepRunInput) => Promise<StepResult>;
let db: Awaited<ReturnType<typeof createDatabase>>;

beforeAll(async () => {
  agentStep = DBOS.registerWorkflow((i: StepRunInput) => agentStepWorkflow(i), { name: AGENT_STEP_WORKFLOW });
  systemStep = DBOS.registerWorkflow((i: StepRunInput) => systemStepWorkflow(i), { name: SYSTEM_STEP_WORKFLOW });
  db = await createDatabase('literature');
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

const ABSTRACT = 'Between Aug 2021 and Mar 2023, 1613 (757 [46·9%] female) were randomly assigned. Weight fell by −6·7 kg (95% CI −7·2 to −6·1).';
const judged = (field: string, typeSource: 'Text' | 'Number'): WriteDef => ({ field, type: { kind: 'scalar', name: typeSource }, typeSource, from: { kind: 'judgement' } });

/** An agent step that reads a paper (`paper.get`) and writes what it read, with quotes. */
function reader(id: string, quotes?: 'required'): StepRunInput {
  return stepInput(id, clean, (s): StepDef => ({
    ...s, id: 'extract', title: 'Read the paper', checkpoint: [], outcomes: ['read'], ...(quotes ? { quotes } : {}),
    tools: { allowed: ['paper.get'], required: ['paper.get'] },
    writes: { n: judged('n', 'Number'), sponsor: judged('sponsor', 'Text') },
  }));
}
const paper: ToolDefinition = {
  name: 'paper.get', description: 'Read a paper.', effect: 'read',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async execute() { return { content: [{ type: 'text', text: JSON.stringify({ pmid: '1', abstract: ABSTRACT }) }] }; },
};
const evidence: Evidence[] = [{ tool: 'paper.get', callId: 'c1', args: {}, result: { pmid: '1', abstract: ABSTRACT } }];

describe('quotes on judgement writes (D81)', () => {
  test('a quote in a tool result passes, normalised: NFKC, case, whitespace, · as ., dashes as -', () => {
    expect(quoteProblem('1613 (757 [46.9%] FEMALE)  were\nrandomly assigned', evidence)).toBeUndefined();
    expect(quoteProblem('fell by -6.7 kg (95% CI -7.2 to -6.1)', evidence)).toBeUndefined();
    // Inside JSON text, as MCP tools return it.
    expect(quoteProblem('were randomly assigned', [{ ...evidence[0]!, result: { content: [{ type: 'text', text: JSON.stringify({ abstract: ABSTRACT }) }] } }])).toBeUndefined();
    expect(quoteProblem('1600 were randomly assigned', evidence)).toContain('is not in any tool result this step saw');
    expect(quoteProblem('  ', evidence)).toContain('empty');
    expect(quoteProblem('anything', [])).toContain('saw no tool results');
  });

  test('structural checks: the quote goes on the provenance; a wrong one fails `writes.<field>: the quote is in a source`', () => {
    const input = reader('q-pure');
    const ok = structuralChecks(input, { outcome: 'read', writes: { n: 1613 }, quotes: { n: '1613 (757 [46·9%] female) were randomly assigned' } }, evidence, ['paper.get'], 'T');
    expect(ok.passed).toBe(true);
    expect(ok.checks).toContainEqual({ rule: 'writes.n: the quote is in a source', kind: 'structural', passed: true });
    expect(ok.writes.n!.provenance).toMatchObject({ kind: 'judgement', quote: '1613 (757 [46·9%] female) were randomly assigned' });

    const bad = structuralChecks(input, { outcome: 'read', writes: { n: 1613 }, quotes: { n: '1613 patients were enrolled' } }, evidence, ['paper.get'], 'T');
    expect(bad.passed).toBe(false);
    expect(bad.checks.find((c) => !c.passed)).toMatchObject({ rule: 'writes.n: the quote is in a source', reason: expect.stringContaining('"1613 patients were enrolled"') });

    // Without `quotes: required` a value may come without one; a quote for a value not written fails.
    expect(structuralChecks(input, { outcome: 'read', writes: { n: 1613 } }, evidence, ['paper.get'], 'T').passed).toBe(true);
    const stray = structuralChecks(input, { outcome: 'read', writes: { n: 1613 }, quotes: { sponsor: 'randomly assigned' } }, evidence, ['paper.get'], 'T');
    expect(stray.checks.find((c) => !c.passed)).toMatchObject({ rule: 'writes.sponsor: the quote is in a source', reason: expect.stringContaining("isn't written") });
  });

  test('a quote on a value that comes from a tool fails the quote rule for that field', () => {
    const input = reader('q-tool');
    input.step.writes.pmid = { field: 'pmid', type: { kind: 'scalar', name: 'Text' }, typeSource: 'Text', from: { kind: 'tool', tool: 'paper.get', field: 'pmid' } };
    const r = structuralChecks(input, { outcome: 'read', writes: { n: 1613, pmid: '1' }, quotes: { n: '1613 (757 [46·9%] female)', pmid: '1613' } }, evidence, ['paper.get'], 'T');
    expect(r.passed).toBe(false);
    expect(r.checks.filter((c) => !c.passed)).toEqual([
      { rule: 'writes.pmid: the quote is in a source', kind: 'structural', passed: false, reason: 'this value comes from a tool; quote only judgement writes' },
    ]);
    // The value itself is still taken from the tool, without a quote.
    expect(r.writes.pmid!.provenance).toMatchObject({ kind: 'tool', tool: 'paper.get' });
    expect(r.writes.pmid!.provenance).not.toHaveProperty('quote');
  });

  test('`quotes: required`: a value without a quote fails the same check; an empty value needs none', () => {
    const input = reader('q-required', 'required');
    const r = structuralChecks(input, { outcome: 'read', writes: { n: 1613, sponsor: '' } }, evidence, ['paper.get'], 'T');
    expect(r.checks.filter((c) => !c.passed)).toEqual([
      { rule: 'writes.n: the quote is in a source', kind: 'structural', passed: false, reason: expect.stringContaining('add quotes.n') },
    ]);
  });

  test('step.finish and the prompt tell the model about quotes', () => {
    const optional = reader('q-ctx');
    const params = finishToolParameters(optional.step, optional.recordTypes) as any;
    expect(Object.keys(params.properties.quotes.properties)).toEqual(['n', 'sponsor']);
    expect(params.properties.quotes.description).toContain('Optional');
    expect(params.required).toEqual(['outcome', 'writes', 'rationale']);

    const required = reader('q-ctx2', 'required');
    const req = finishToolParameters(required.step, required.recordTypes) as any;
    expect(req.required).toEqual(['outcome', 'writes', 'rationale', 'quotes']);
    expect(req.properties.quotes.description).toContain('Required');
    const ctx = assembleContext(required, { tools: new FakeTools([paper]) });
    expect(ctx.systemPrompt).toContain('- quotes: { <write>: "<exact words>" }. Required');
    expect(ctx.tools.find((t) => t.tool === 'step.finish')!.description).toContain('the exact words each value was read from (quotes)');

    // A step whose writes all come from tools is told nothing about quotes.
    const fromTools = finishToolParameters(stepInput('q-ctx3', clean).step, {}) as any;
    expect(fromTools.properties.quotes?.properties ?? {}).not.toHaveProperty('gstin_ok');
  });

  test('a run: a quote not in the abstract is sent back, the repaired one is kept on the provenance', async () => {
    const recorder = new MemoryRecorder();
    const finish = (quote: string): ScriptedTurn => ({ toolCalls: [{ name: 'step.finish', args: { outcome: 'read', writes: { n: 1613 }, quotes: { n: quote }, rationale: 'From the abstract.' } }] });
    const g = realGateways(clean, { extra: [paper], script: { checker: [{ toolCalls: [{ name: 'paper.get', args: {} }] }, finish('1613 were enrolled'), finish('1613 (757 [46·9%] female) were randomly assigned')] } });
    const input = reader('q-run', 'required');
    const result = await run(agentStep, input, { tools: g.tools, models: g.models, recorder });
    expect(result.status).toBe('completed');
    expect(result.writes.n).toMatchObject({ value: 1613, provenance: { kind: 'judgement', quote: '1613 (757 [46·9%] female) were randomly assigned' } });
    const first = recorder.entry(input.stepRunId, 'checkpoint:1:structural')!.response as { rule: string; passed: boolean }[];
    expect(first.find((c) => !c.passed)).toMatchObject({ rule: 'writes.n: the quote is in a source' });
    expect(recorder.keys(input.stepRunId)).toContain('checkpoint:2:structural');
  });
});

// ---------------------------------------------------------------- system steps over lists and dates

describe('system steps: each, item, today and now (25 §3)', () => {
  test('mapArgs: item paths, the whole item, today plus days in local time, now', () => {
    const snap = { id: 'c', caseType: 't', seq: 1, values: { topic: { value: 'top_1', provenance: { kind: 'input' as const, at: '' } } } };
    const at = new Date(2026, 9, 21, 23, 30); // local time, late in the day
    expect(mapArgs({ topic: { case: 'topic' }, article: { item: 'article' }, whole: { item: '' }, next: { today: 7 }, on: { today: 0 }, at: { now: true }, gone: { item: 'nope' } },
      snap, { item: { article: 'art_1', decision: 'include' }, at }))
      .toEqual({ topic: 'top_1', article: 'art_1', whole: { article: 'art_1', decision: 'include' }, next: '2026-10-28', on: '2026-10-21', at: at.toISOString() });
    expect(localDate(new Date(2026, 11, 30), 3)).toBe('2027-01-02');
  });

  const made: { args: Record<string, unknown>; key: string }[] = [];
  const createScreening: ToolDefinition<Record<string, unknown>> = {
    name: 'lit.screening.create', description: 'Create a screening.', effect: 'write', idempotent: true,
    inputSchema: { type: 'object', properties: { topic: { type: 'string' }, article: { type: 'string' }, decision: { type: 'string' } }, additionalProperties: false },
    async execute(args, ctx) { made.push({ args, key: ctx.idempotencyKey }); return { id: `scr_${made.length}` }; },
  };
  const updated: Record<string, unknown>[] = [];
  const updateTopic: ToolDefinition<Record<string, unknown>> = {
    name: 'lit.topic.update', description: 'Change a topic.', effect: 'write', idempotent: true,
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, next_check: { type: 'string' }, last_checked: { type: 'string' } }, additionalProperties: false },
    async execute(args) { updated.push(args); return { id: args.id, changed: Object.keys(args).filter((k) => k !== 'id') }; },
  };

  function record(id: string, rows: unknown): StepRunInput {
    const input = stepInput(id, clean, (s) => ({
      ...s, id: 'record', title: 'Record the screening', performer: 'system', model: undefined, checkpoint: [], outcomes: ['done'],
      reads: ['case.client_name', 'case.rows'],
      tools: { allowed: ['lit.screening.create', 'lit.topic.update'], required: ['lit.screening.create', 'lit.topic.update'] },
      each: { 'lit.screening.create': 'rows' },
      map: {
        'lit.screening.create': { topic: { case: 'client_name' }, article: { item: 'article' }, decision: { item: 'decision' } },
        'lit.topic.update': { id: { case: 'client_name' }, next_check: { today: 7 }, last_checked: { now: true } },
      },
      writes: {
        screenings: {
          field: 'screenings', type: { kind: 'list', of: { kind: 'scalar', name: 'Text' } }, typeSource: 'List<Text>',
          from: { kind: 'tool', tool: 'lit.screening.create', field: 'id' },
        },
      },
    }));
    if (rows !== undefined) input.case.values.rows = { value: rows, provenance: { kind: 'input', at: '' } };
    return input;
  }
  const deps = (recorder = new MemoryRecorder()) => ({
    tools: createToolGateway({ tools: [createScreening, updateTopic], ledger: new MemoryLedger() }),
    models: createModelGateway({ roles: {}, providers: [] }), recorder,
  });

  test('one call per item, in order, keyed `${stepRunId}:${tool}:${index}`; the write is the list of results', async () => {
    made.length = 0;
    updated.length = 0;
    const recorder = new MemoryRecorder();
    const input = record('each-ok', [{ article: 'art_1', decision: 'include' }, { article: 'art_2', decision: 'exclude' }]);
    const result = await run(systemStep, input, deps(recorder));
    expect(result).toMatchObject({ status: 'completed', outcome: 'done', usage: { toolCalls: 3 } });
    expect(made).toEqual([
      { args: { topic: 'Asha Rao', article: 'art_1', decision: 'include' }, key: `${input.stepRunId}:lit.screening.create:0` },
      { args: { topic: 'Asha Rao', article: 'art_2', decision: 'exclude' }, key: `${input.stepRunId}:lit.screening.create:1` },
    ]);
    expect(result.writes.screenings).toMatchObject({ value: ['scr_1', 'scr_2'], provenance: { kind: 'tool', tool: 'lit.screening.create' } });
    // Dates come from the step run's start, so a replay maps the same arguments.
    const started = new Date(input.startedAt);
    expect(updated).toEqual([{ id: 'Asha Rao', next_check: localDate(started, 7), last_checked: started.toISOString() }]);
    expect(recorder.keys(input.stepRunId)).toEqual([
      'policy:lit.screening.create:0', 'tool:lit.screening.create:0', 'policy:lit.screening.create:1', 'tool:lit.screening.create:1',
      'policy:lit.topic.update', 'tool:lit.topic.update',
    ]);
  });

  test('an empty or unset list makes no calls and writes an empty list; a value that is not a list goes to a person', async () => {
    made.length = 0;
    const none = await run(systemStep, record('each-none', undefined), deps());
    expect(none).toMatchObject({ status: 'completed', writes: { screenings: { value: [] } } });
    expect(made).toEqual([]);
    const odd = await run(systemStep, record('each-odd', 'not a list'), deps());
    expect(odd).toMatchObject({ status: 'needs_person' });
    expect(odd.reason).toContain('is not a list');
  });
});

void intakeTools;
