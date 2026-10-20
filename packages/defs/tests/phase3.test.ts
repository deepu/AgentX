// Phase 3 definition additions (engine, outcomeFrom), example YAML, `memwise init` and `memwise convert`.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkProject, checkWorkflow, convertTaskYaml, exampleToYaml, initProject, isConversationStep, loadProject, parseExampleFile, parseStepFile,
  type Diagnostic,
} from '../src/index.ts';
import { BASE, ENV, makeProject, SAMPLE, SAMPLE_ENV } from './fixture.ts';

const WF = 'workflows/demo/workflow.yaml';
const WORK = 'workflows/demo/steps/work.md';
const ROLES = { 'domain/roles.yaml': 'roles:\n  staff: Staff\n  manager: Manager\n' };
const brief = (ds: Diagnostic[]) => ds.map((d) => `${d.severity} ${d.code} ${d.file}:${d.line ?? '?'}${d.path ? ` ${d.path}` : ''}`);

async function check(changes: Record<string, string | null>) {
  const { project, diagnostics } = await loadProject(makeProject({ ...ROLES, ...changes }));
  expect(brief(diagnostics)).toEqual([]);
  return brief(checkProject(project, ENV));
}

const shape = (work: string) => `workflow: demo\nversion: 1\nstart: work\nsteps:\n  work: ${work}\n  review:\n    on: { approved: end }\n    wait: { timeout: 2d -> end }\n`;
const step = (front: string) => `---\n${front}\n---\nDo it.\n`;
const REVIEW = { 'workflows/demo/steps/review.md': BASE['workflows/demo/steps/review.md']!.replace('performer: person', 'performer: person\nassignee: manager') };
const CONVERSATION = 'title: Talk\nperformer: agent\nengine: open\nstrictness: open\nassignee: staff\noutcomes: [done]';

describe('conversation steps (engine: open)', () => {
  test('parse: engine and outcomeFrom', () => {
    const s = parseStepFile(step(`${CONVERSATION}`), 'workflows/demo/steps/work.md');
    expect(s.diagnostics).toEqual([]);
    expect(s.value).toMatchObject({ performer: 'agent', engine: 'open', strictness: 'open' });
    expect(isConversationStep(s.value!)).toBe(true);
    const sys = parseStepFile(step('title: C\nperformer: system\noutcomeFrom: { tool: t.x, field: outcome }'), 'x/steps/c.md');
    expect(sys.value!.outcomeFrom).toEqual({ tool: 't.x', field: 'outcome' });
    expect(sys.value!.engine).toBeUndefined();
    const bad = parseStepFile(step('title: C\nperformer: agent\nengine: chat\noutcomeFrom: { tool: t.x }'), 'x/steps/c.md');
    expect(bad.diagnostics.map((d) => `${d.code} ${d.path}`)).toEqual(['invalid-format engine', 'invalid-format outcomeFrom.field']);
  });

  test('a conversation step needs no model role, and passes with an assignee and a timeout', async () => {
    expect(await check({ ...REVIEW, [WF]: shape('{ on: { done: review }, wait: { timeout: 30d -> end } }'), [WORK]: step(CONVERSATION) })).toEqual([]);
  });

  test('it waits like a person step: assignee required, and a timeout', async () => {
    const out = await check({ ...REVIEW, [WF]: shape('{ on: { done: review } }'), [WORK]: step(CONVERSATION.replace('assignee: staff\n', '')) });
    expect(out).toEqual([`warning wait-without-timeout ${WF}:5 steps.work`, `error missing-assignee ${WORK}:2`]);
    const unknown = await check({ ...REVIEW, [WF]: shape('{ on: { done: review }, wait: { timeout: 1d -> end } }'), [WORK]: step(CONVERSATION.replace('assignee: staff', 'assignee: boss')) });
    expect(unknown).toEqual([`error unknown-role ${WORK}:6 assignee`]);
  });

  test('open-engine-needs-open-step: only agent steps with strictness open', async () => {
    const guided = await check({ ...REVIEW, [WF]: shape('{ on: { done: review }, wait: { timeout: 1d -> end } }'), [WORK]: step(CONVERSATION.replace('strictness: open', 'strictness: guided')) });
    expect(guided).toEqual([`error open-engine-needs-open-step ${WORK}:4 engine`]);
    const person = await check({ ...REVIEW, [WF]: shape('{ on: { done: review }, wait: { timeout: 1d -> end } }'), [WORK]: step('title: P\nperformer: person\nengine: open\nassignee: staff\noutcomes: [done]') });
    expect(person).toEqual([`error open-engine-needs-open-step ${WORK}:4 engine`]);
    // engine: step on an ordinary agent step is just the default.
    expect(await check({ ...REVIEW, [WORK]: BASE[WORK]!.replace('model: worker', 'model: worker\nengine: step') })).toEqual([]);
  });

  test('examples may answer a conversation step with submit:, but not an agent step on our engine', async () => {
    const example = 'case: { name: Ann }\nsubmit:\n  work: { outcome: done }\n  review: { outcome: approved }\nexpect: { state: end }\n';
    expect(await check({
      ...REVIEW, [WF]: shape('{ on: { done: review }, wait: { timeout: 1d -> end } }'), [WORK]: step(CONVERSATION),
      'workflows/demo/examples/talk.yaml': example,
    })).toEqual([]);
    expect(await check({ ...REVIEW, 'workflows/demo/examples/talk.yaml': example }))
      .toEqual(['error example-unknown-state workflows/demo/examples/talk.yaml:3 submit.work']);
  });
});

describe('outcomeFrom', () => {
  const SYSTEM = 'title: Look up\nperformer: system\ntools: { allowed: [lookup.customer], required: [lookup.customer] }\noutcomes: [done, needs_info]\noutcomeFrom: { tool: lookup.customer, field: status }';
  const SHAPE = shape('{ on: { done: review, needs_info: end } }');

  test('a system step with outcomeFrom may declare several outcomes', async () => {
    expect(await check({ ...REVIEW, [WF]: SHAPE, [WORK]: step(SYSTEM) })).toEqual([]);
    // Without outcomeFrom a system step finishes with one outcome.
    expect(await check({ ...REVIEW, [WF]: SHAPE, [WORK]: step(SYSTEM.replace(/\noutcomeFrom.*/, '')) }))
      .toEqual([`error system-step-outcomes ${WORK}:5 outcomes`]);
    // With outcomeFrom it must declare what the tool may give.
    expect(await check({ ...REVIEW, [WF]: shape('{ on: { done: review } }'), [WORK]: step(SYSTEM.replace('outcomes: [done, needs_info]\n', '')) }))
      .toContain(`error no-outcomes ${WORK}:2`);
  });

  test('outcome-from-not-required and outcome-from-system-only', async () => {
    const notRequired = await check({ ...REVIEW, [WF]: SHAPE, [WORK]: step(SYSTEM.replace('tool: lookup.customer, field', 'tool: mail.send, field')) });
    expect(notRequired).toEqual([`error outcome-from-not-required ${WORK}:6 outcomeFrom.tool`]);
    const agent = await check({ ...REVIEW, [WORK]: BASE[WORK]!.replace('outcomes: [done]', 'outcomes: [done]\noutcomeFrom: { tool: lookup.customer, field: x }') });
    expect(agent).toEqual([`error outcome-from-system-only ${WORK}:11 outcomeFrom`]);
  });

  test('the sample project still passes', async () => {
    const { project } = await loadProject(SAMPLE);
    expect(brief(checkProject(project, SAMPLE_ENV))).toEqual([]);
  });
});

describe('exampleToYaml', () => {
  test('every sample example case round-trips', async () => {
    const { project } = await loadProject(SAMPLE);
    const examples = Object.values(project.workflows).flatMap((w) => w.examples);
    expect(examples.length).toBeGreaterThan(3);
    for (const ex of examples) {
      const { file, ...rest } = ex;
      const back = parseExampleFile(exampleToYaml(ex), file);
      expect(back.diagnostics).toEqual([]);
      const { file: _f, ...again } = back.value!;
      expect(again).toEqual(rest);
    }
  });

  test('every field, odd strings included, round-trips', () => {
    const ex = {
      name: 'everything',
      description: 'yes: a "quoted" string\nover two lines',
      startAt: 'check',
      case: { pan: 'ABCDE1234F', amount: { amount: 10.5, currency: 'INR' }, flags: [{ note: '123' }], on: true, empty: null, date: '2026-01-02' },
      tools: { 'gst.validate_gstin': { results: [{ valid: true }, { valid: false }] }, 'email.send': { id: 'x' } },
      model: { checker: [{ text: 'thinking' }, { toolCalls: [{ name: 'step.finish', args: { outcome: 'checked', values: { n: 1 } } }] }] },
      approvals: { 'email.send': 'approve' as const },
      submit: { verify: [{ outcome: 'sent_back', comment: 'no' }, { outcome: 'approved', values: { ok: 'yes' } }], fill: { outcome: 'submitted' } },
      expect: { outcome: 'checked', state: 'end', writes: { flags: [] }, effects: { 'email.send': 1 }, entities: { Customer: [{ name: 'x' }], Engagement: 0 } },
    };
    const back = parseExampleFile(exampleToYaml(ex), 'w/examples/everything.yaml');
    expect(back.diagnostics).toEqual([]);
    expect(back.value).toEqual({ ...ex, file: 'w/examples/everything.yaml' });
  });
});

describe('initProject', () => {
  const fresh = () => join(mkdtempSync(join(tmpdir(), 'memwise-init-')), 'proj');

  test('empty: roles, policy, workflows/; it checks clean', async () => {
    const dir = fresh();
    const files = await initProject(dir, { template: 'empty', source: join(tmpdir(), 'no-such-template') });
    expect(files).toEqual(['domain/policy.yaml', 'domain/roles.yaml']);
    expect(readdirSync(join(dir, 'workflows'))).toEqual([]);
    const { project, diagnostics } = await loadProject(dir);
    expect(diagnostics).toEqual([]);
    expect(Object.keys(project.roles)).toEqual(['staff', 'manager']);
    expect(project.domainPolicy?.effects).toEqual({ outbound: 'approve' });
    expect(checkProject(project, { tools: {} })).toEqual([]);
  });

  test('empty copies the meta playbooks from the source when it has them', async () => {
    const src = mkdtempSync(join(tmpdir(), 'memwise-src-'));
    mkdirSync(join(src, 'workflows/create-playbook'), { recursive: true });
    writeFileSync(join(src, 'workflows/create-playbook/workflow.yaml'), 'workflow: create-playbook\n');
    mkdirSync(join(src, 'workflows/client-intake'), { recursive: true });
    writeFileSync(join(src, 'workflows/client-intake/workflow.yaml'), 'workflow: client-intake\n');
    const dir = fresh();
    expect(await initProject(dir, { source: src })).toContain('workflows/create-playbook/workflow.yaml');
    expect(readdirSync(join(dir, 'workflows'))).toEqual(['create-playbook']);
  });

  test('intake: a copy of the sample; a non-empty folder is refused', async () => {
    const dir = fresh();
    const files = await initProject(dir, { template: 'intake' });
    expect(files).toContain('workflows/client-intake/workflow.yaml');
    expect(files.some((f) => f.startsWith('drafts/'))).toBe(false);
    const { project, diagnostics } = await loadProject(dir);
    expect(diagnostics).toEqual([]);
    expect(project.workflows['client-intake']?.hash).toBe((await loadProject(SAMPLE)).project.workflows['client-intake']!.hash);
    await expect(initProject(dir)).rejects.toThrow(/not empty/);
  });
});

describe('convertTaskYaml', () => {
  async function asProject(files: Record<string, string>) {
    const root = makeProject({ ...ROLES });
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(join(root, p, '..'), { recursive: true });
      writeFileSync(join(root, p), text);
    }
    return loadProject(root);
  }

  test('a chain: session nodes become agent steps, depends_on becomes done, approval adds a person step', async () => {
    const { workflowId, files } = convertTaskYaml(`
id: research-brief
title: Research brief
goal: Write a short brief
params:
  - { name: topic, type: string }
  - { name: depth, type: number }
nodes:
  - id: gather
    prompt: Find sources about \${params.topic}
  - id: write
    type: session
    depends_on: [gather]
    approval: true
    prompt: Write the brief from \${nodes.gather.output}
  - id: polish
    depends_on: [write]
    prompt: Polish it
`, { roles: ['manager', 'staff'] });
    expect(workflowId).toBe('research-brief');
    const dir = 'workflows/research-brief';
    expect(Object.keys(files).sort()).toEqual([
      `${dir}/case.yaml`, `${dir}/steps/gather.md`, `${dir}/steps/polish.md`, `${dir}/steps/write.md`, `${dir}/steps/write_approval.md`, `${dir}/workflow.yaml`,
    ]);
    expect(files[`${dir}/steps/write.md`]).toContain('Write the brief from `case.gather_result`');
    expect(files[`${dir}/steps/gather.md`]).toContain('Find sources about `case.topic`');
    const { project, diagnostics } = await asProject(files);
    expect(diagnostics).toEqual([]);
    const wf = project.workflows['research-brief']!;
    expect(wf.start).toBe('gather');
    expect(wf.owner).toBe('manager');
    expect(Object.fromEntries(Object.entries(wf.states).map(([n, s]) => [n, s.on]))).toEqual({
      gather: { done: 'write' },
      write: { done: 'write_approval' },
      write_approval: { approved: 'polish', sent_back: 'write' },
      polish: { done: 'end' },
    });
    expect(wf.steps.gather).toMatchObject({ performer: 'agent', strictness: 'guided', model: 'worker', outcomes: ['done'], reads: ['case.topic', 'case.depth'] });
    expect(wf.steps.write_approval).toMatchObject({ performer: 'person', assignee: 'manager', outcomes: ['approved', 'sent_back'] });
    expect(Object.fromEntries(Object.entries(wf.caseType.fields).map(([n, f]) => [n, f.typeSource]))).toEqual({
      topic: 'Text', depth: 'Number', gather_result: 'Text', write_result: 'Text', polish_result: 'Text',
    });
    // Only the person step's missing timeout is left to decide.
    expect(brief(checkWorkflow(wf, { tools: {}, roles: ['manager', 'staff'] }))).toEqual([`warning wait-without-timeout ${dir}/workflow.yaml:14 steps.write_approval`]);
    expect(files[`${dir}/workflow.yaml`]).not.toContain('not a simple chain');
  });

  test('fan-out and fan-in are run one after another, and say so', async () => {
    const { files } = convertTaskYaml(`
id: fan
title: Fan
goal: g
nodes:
  - { id: a, prompt: A }
  - { id: c, prompt: C, depends_on: [a, b] }
  - { id: b, prompt: B, depends_on: [a] }
`, { modelRole: 'checker' });
    const text = files['workflows/fan/workflow.yaml']!;
    expect(text).toContain('not a simple chain');
    expect(text).toContain('#   c came after a, b');
    const { project, diagnostics } = await asProject(files);
    expect(diagnostics).toEqual([]);
    const wf = project.workflows.fan!;
    expect(Object.fromEntries(Object.entries(wf.states).map(([n, s]) => [n, s.on]))).toEqual({ a: { done: 'b' }, b: { done: 'c' }, c: { done: 'end' } });
    expect(wf.steps.c!.reads).toEqual(['case.notes', 'case.a_result', 'case.b_result']);
    expect(wf.steps.a!.model).toBe('checker');
    expect(checkWorkflow(wf, { tools: {}, roles: ['staff'] })).toEqual([]);
  });

  test('loops, unknown dependencies and missing ids are refused in plain words', () => {
    expect(() => convertTaskYaml('id: x\nnodes:\n  - { id: a, prompt: A, depends_on: [b] }\n  - { id: b, prompt: B, depends_on: [a] }\n')).toThrow(/loop/);
    expect(() => convertTaskYaml('id: x\nnodes:\n  - { id: a, prompt: A, depends_on: [ghost] }\n')).toThrow(/ghost/);
    expect(() => convertTaskYaml('title: no id\nnodes: []\n')).toThrow(/needs an `id`/);
    expect(() => convertTaskYaml('id: x\nnodes: []\n')).toThrow(/no nodes/);
  });
});

