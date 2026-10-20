import { describe, expect, test } from 'bun:test';
import { checkProject, checkWorkflow, loadProject, type Diagnostic } from '../src/index.ts';
import { BASE, ENV, makeProject, SAMPLE, SAMPLE_ENV } from './fixture.ts';

const WF = 'workflows/demo/workflow.yaml';
const WORK = 'workflows/demo/steps/work.md';
const brief = (ds: Diagnostic[]) => ds.map((d) => `${d.severity} ${d.code} ${d.file}:${d.line ?? '?'}${d.path ? ` ${d.path}` : ''}`);

async function check(changes: Record<string, string | null> = {}, env = ENV) {
  const { project, diagnostics } = await loadProject(makeProject(changes));
  expect(diagnostics).toEqual([]);
  return brief(checkProject(project, env));
}

const shape = (steps: string) => `workflow: demo\nversion: 1\nstart: work\nsteps:\n${steps}`;
const work = (front: string) => `---\n${front}\n---\nDo it.\n`;
const BASE_WORK = BASE[WORK]!.split('---')[1]!.trim();

describe('checks', () => {
  test('the sample project passes with only the system-step warning', async () => {
    const { project } = await loadProject(SAMPLE);
    expect(brief(checkProject(project, SAMPLE_ENV))).toEqual([
      'warning system-step-phase-2 workflows/client-intake/steps/onboard.md:3 performer',
    ]);
  });

  test('the base fixture is clean', async () => {
    expect(await check()).toEqual([]);
  });

  test('unknown-start', async () => {
    expect(await check({ [WF]: shape('  work: { on: { done: review } }\n  review: { on: { approved: end }, wait: { timeout: 1d -> end } }\n').replace('start: work', 'start: begin') }))
      .toContain(`error unknown-start ${WF}:3 start`);
  });

  test('unknown-target, on a transition and on a timeout', async () => {
    const out = await check({ [WF]: shape('  work: { on: { done: reviw } }\n  review:\n    on: { approved: end }\n    wait: { timeout: 1d -> nowhere }\n') });
    expect(out).toContain(`error unknown-target ${WF}:5 steps.work.on.done`);
    expect(out).toContain(`error unknown-target ${WF}:8 steps.review.wait.timeout`);
    expect(out).toContain(`error unreachable-state ${WF}:6 steps.review`);
  });

  test('unreachable-state', async () => {
    const out = await check({ [WF]: shape('  work: { on: { done: end } }\n  review: { on: { approved: end }, wait: { timeout: 1d -> end } }\n') });
    expect(out).toEqual([`error unreachable-state ${WF}:6 steps.review`]);
  });

  test('no-exit, and wait-without-timeout on a state with no step file', async () => {
    const out = await check({ [WF]: shape('  work: { on: { done: review } }\n  review: { on: { approved: limbo }, wait: { timeout: 1d -> end } }\n  limbo: {}\n') });
    expect(out).toEqual([
      `error no-exit ${WF}:7 steps.limbo`,
      `warning wait-without-timeout ${WF}:7 steps.limbo`,
    ]);
  });

  test('wait-without-timeout on a person step', async () => {
    expect(await check({ [WF]: shape('  work: { on: { done: review } }\n  review: { on: { approved: end } }\n') }))
      .toEqual([`warning wait-without-timeout ${WF}:6 steps.review`]);
  });

  test('missing-model-role and no-outcomes on an agent step', async () => {
    const out = await check({ [WORK]: work('title: W\nperformer: agent\ntools: { allowed: [lookup.customer] }') });
    expect(out).toContain(`error missing-model-role ${WORK}:2`);
    expect(out).toContain(`error no-outcomes ${WORK}:2`);
    expect(out).toContain(`warning unknown-outcome ${WF}:5 steps.work.on.done`);
  });

  test('outcome-without-transition, and unknown-outcome (but needs_person and failed are fine)', async () => {
    const out = await check({
      [WF]: shape('  work: { on: { done: review, oops: end, needs_person: end, failed: end } }\n  review: { on: { approved: end }, wait: { timeout: 1d -> end } }\n'),
      [WORK]: work(BASE_WORK.replace('outcomes: [done]', 'outcomes: [done, needs_info]')),
    });
    expect(out).toEqual([
      `error outcome-without-transition ${WF}:5 steps.work.on`,
      `warning unknown-outcome ${WF}:5 steps.work.on.oops`,
    ]);
  });

  test('reads: unknown case fields, through records and entity refs', async () => {
    const out = await check({ [WORK]: work(BASE_WORK.replace('reads: [case.name]', 'reads: [case.nam, case.owner.name, case.owner.age, case.flags.note]')) });
    expect(out).toEqual([
      `error unknown-case-field ${WORK}:4 reads.0`,
      `error unknown-case-field ${WORK}:4 reads.2`,
    ]);
  });

  test('writes: unknown field, type mismatch, from a tool that is not allowed', async () => {
    const out = await check({
      [WORK]: work(BASE_WORK.replace('  flags: List<Flag>', '  flags: List<Text>\n  extra: Text\n  name: { type: Text, from: tool mail.send }')),
    });
    expect(out).toEqual([
      `error write-type-mismatch ${WORK}:6 writes.flags`,
      `error unknown-case-field ${WORK}:7 writes.extra`,
      `error tool-not-allowed ${WORK}:8 writes.name.from`,
    ]);
  });

  test('unknown-tool and required-not-allowed', async () => {
    const out = await check({ [WORK]: work(BASE_WORK.replace('  allowed: [lookup.customer]', '  allowed: [lookup.customer, web.search]\n  required: [mail.send]')) });
    expect(out).toEqual([
      `error unknown-tool ${WORK}:8 tools.allowed.1`,
      `error required-not-allowed ${WORK}:9 tools.required.0`,
    ]);
  });

  test('unknown-type and unknown-entity in the case type, entities and writes', async () => {
    const out = await check({
      'workflows/demo/case.yaml': 'case: demo\nfields:\n  name: Text\n  flags: List<Flg>\n  owner: Ref<Client>\n',
      'domain/entities/customer.yaml': 'entity: Customer\nfields:\n  name: PersonName\n  best: Ref<Friend>\nrelationships:\n  orders: many Order\n',
    });
    expect(out).toEqual([
      'error unknown-entity domain/entities/customer.yaml:4 fields.best',
      'error unknown-entity domain/entities/customer.yaml:6 relationships.orders',
      'error unknown-type workflows/demo/case.yaml:4 fields.flags',
      'error unknown-entity workflows/demo/case.yaml:5 fields.owner',
      `error write-type-mismatch ${WORK}:6 writes.flags`,
      `error unknown-type ${WORK}:6 writes.flags`,
    ]);
  });

  test('a named type may be an entity type', async () => {
    expect(await check({ 'workflows/demo/case.yaml': BASE['workflows/demo/case.yaml']!.replace('  owner: Ref<Customer>', '  owner: Ref<Customer>\n  snapshot: Customer') })).toEqual([]);
  });

  test('system steps get a warning', async () => {
    expect(await check({ [WORK]: work(BASE_WORK.replace('performer: agent', 'performer: system')) }))
      .toEqual([`warning system-step-phase-2 ${WORK}:3 performer`]);
  });

  test('example cases: states, outcomes, fields, values and tools', async () => {
    const out = await check({
      'workflows/demo/examples/bad.yaml': [
        'startAt: wrk',
        'case: { name: 42, colour: red, flags: [{ note: x, size: 3 }] }',
        'tools: { lookup.customer: {}, web.search: {} }',
        'model:',
        '  worker:',
        '    - toolCalls: [{ name: step.finish, args: {} }, { name: web.search, args: {} }, { name: crm.write, args: {} }]',
        'expect: { outcome: finished, state: nowhere, writes: { owner: "" } }',
      ].join('\n'),
    });
    const EX = 'workflows/demo/examples/bad.yaml';
    expect(out).toEqual([
      `error example-unknown-state ${EX}:1 startAt`,
      `error example-unknown-state ${EX}:7 expect.state`,
      `error example-invalid-value ${EX}:2 case.name`,
      `error example-unknown-field ${EX}:2 case.colour`,
      `error example-invalid-value ${EX}:2 case.flags`,
      `error example-invalid-value ${EX}:7 expect.writes.owner`,
      `error example-unknown-tool ${EX}:3 tools.web.search`,
      `error example-unknown-tool ${EX}:6 model.worker.0.toolCalls.2`,
    ]);
  });

  test('example-unknown-outcome', async () => {
    const out = await check({ 'workflows/demo/examples/e.yaml': 'case: { name: Asha }\nexpect: { outcome: finished }\n' });
    expect(out).toEqual(['error example-unknown-outcome workflows/demo/examples/e.yaml:2 expect.outcome']);
  });

  test('checkWorkflow on a snapshot from the store (no lines) still names file and path', async () => {
    const { project } = await loadProject(makeProject({ [WF]: shape('  work: { on: { done: end } }\n  review: { on: { approved: end }, wait: { timeout: 1d -> end } }\n') }));
    const snapshot = JSON.parse(JSON.stringify(project.workflows.demo));
    expect(checkWorkflow(snapshot, ENV)).toEqual([
      { severity: 'error', code: 'unreachable-state', message: expect.any(String), file: WF, line: undefined, path: 'steps.review' },
    ]);
  });
});
