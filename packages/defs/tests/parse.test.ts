import { describe, expect, test } from 'bun:test';
import {
  loadProject, loadWorkflow, parseCaseFile, parseEntityFile, parseExampleFile, parsePolicyFile, parseStepFile, parseWorkflowFile,
} from '../src/index.ts';
import { rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { makeProject, SAMPLE } from './fixture.ts';

describe('the sample project (examples/intake)', () => {
  test('loads with no diagnostics', async () => {
    const { project, diagnostics } = await loadProject(SAMPLE);
    expect(diagnostics).toEqual([]);
    expect(Object.keys(project.entities).sort()).toEqual(['Customer', 'Engagement']);
    // Phase 4 adds `binder` (the bind-plugin playbook's classify step).
    expect(project.domainPolicy?.modelRoles).toEqual(expect.arrayContaining(['checker', 'verifier', 'extractor', 'explainer']));
    expect(Object.keys(project.roles).sort()).toEqual(['finance', 'manager', 'staff']);
    expect(project.roles.manager).toEqual({ id: 'manager', title: 'Manager', description: 'Approves onboarding' });

    const wf = project.workflows['client-intake']!;
    expect(wf).toMatchObject({ id: 'client-intake', version: 1, title: 'Client intake', start: 'fill', dir: 'workflows/client-intake' });
    expect(wf.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(wf.steps).sort()).toEqual(['check', 'fill', 'onboard', 'verify']);
    expect(wf.states.needs_person!.step).toBeUndefined();
    expect(wf.states.check!.step).toBe('check');
    expect(wf.owner).toBe('manager');
    expect(wf.states.needs_person!.assignee).toBe('manager');
    expect(wf.steps.verify!.assignee).toBe('manager');
    expect(wf.steps.onboard!.map).toEqual({
      'domain.customer.create': { name: { case: 'client_name' }, email: { case: 'client_email' }, gstin: { case: 'gstin' }, pan: { case: 'pan' } },
    });
    expect(wf.steps.onboard!.writes.customer!.from).toEqual({ kind: 'tool', tool: 'domain.customer.create', field: 'id' });
    expect(wf.states.fill!.wait).toEqual({ remindMs: 3 * 86_400_000, timeout: { afterMs: 7 * 86_400_000, target: 'needs_person' } });
    expect(wf.caseType.id).toBe('client_intake');
    expect(wf.caseType.types.Flag!.fields.document!.typeSource).toBe('Text');
    expect(wf.policy).toEqual({ name: 'client-intake', effects: { irreversible: 'deny' }, budgets: { tokens: 100000 }, file: 'workflows/client-intake/policy.yaml' });
    expect(wf.examples.map((e) => e.name).sort()).toEqual(['clean-application', 'full-intake', 'onboard-creates-customer', 'pan-mismatch']);

    const check = wf.steps.check!;
    expect(check.budget).toEqual({ tokens: 40_000, timeMs: 600_000, modelCalls: 12 });
    expect(check.writes.gstin_ok!.from).toEqual({ kind: 'tool', tool: 'gst.validate_gstin', field: 'valid' });
    expect(check.writes.flags).toEqual({ field: 'flags', type: { kind: 'list', of: { kind: 'named', name: 'Flag' } }, typeSource: 'List<Flag>', from: { kind: 'judgement' } });
    expect(check.tools.required).toEqual(['gst.validate_gstin']);
    expect(check.instructions.startsWith('## What to do')).toBe(true);
    expect(wf.steps.fill!.writes.pan!.from).toEqual({ kind: 'person' });
    expect(wf.steps.verify!.tools).toEqual({ allowed: [], required: [] });

    const customer = project.entities.Customer!;
    expect(customer.fields.bank_account).toEqual({ type: { kind: 'scalar', name: 'Text' }, typeSource: 'Text', access: ['finance'] });
    expect(customer.relationships.engagements).toEqual({ cardinality: 'many', target: 'Engagement' });
    expect(customer.ownership).toEqual({ email: 'crm' });
  });

  test('the loaded workflow is plain JSON (it is the run snapshot)', async () => {
    const { project } = await loadProject(SAMPLE);
    const wf = project.workflows['client-intake']!;
    expect(JSON.parse(JSON.stringify(wf))).toEqual(wf);
  });
});

describe('workflow.yaml', () => {
  test('-> works like →, and steps become states', () => {
    const { value, diagnostics } = parseWorkflowFile('workflow: w\nversion: 2\nstart: a\nsteps:\n  a:\n    on: { go: end }\n    wait: { remind: 1h30m, timeout: 2d -> a }\n', 'w.yaml');
    expect(diagnostics).toEqual([]);
    expect(value!.states.a).toEqual({ name: 'a', on: { go: 'end' }, wait: { remindMs: 5_400_000, timeout: { afterMs: 172_800_000, target: 'a' } } });
  });

  test('bad timeout, bad remind and unknown keys are reported with lines', () => {
    const text = 'workflow: w\nversion: 1\nstart: a\nsteps:\n  a:\n    on: { go: end }\n    wait: { remind: soon, timeout: 7 days }\n    colour: red\n';
    const { value, diagnostics } = parseWorkflowFile(text, 'workflows/w/workflow.yaml');
    expect(value).toBeDefined();
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'invalid-format', line: 7, path: 'steps.a.wait.remind', file: 'workflows/w/workflow.yaml' }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'invalid-format', line: 7, path: 'steps.a.wait.timeout' }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'unknown-key', line: 8, path: 'steps.a.colour' }));
  });

  test('a timeout with a bad duration in arrow form', () => {
    const { diagnostics } = parseWorkflowFile('workflow: w\nversion: 1\nstart: a\nsteps:\n  a: { wait: { timeout: soon → end } }\n', 'w.yaml');
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'invalid-format', line: 5, message: expect.stringContaining('`soon` is not a duration') })]);
  });

  test('missing keys and `end` as a state', () => {
    const { diagnostics } = parseWorkflowFile('version: 1\nsteps:\n  end: {}\n', 'w.yaml');
    expect(diagnostics.map((d) => d.code).sort()).toEqual(['invalid-format', 'invalid-format', 'reserved-state']);
  });

  test('YAML syntax errors become diagnostics, never exceptions', () => {
    const { diagnostics } = parseWorkflowFile('workflow: w\nsteps:\n  a: { on: [\n', 'w.yaml');
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]).toMatchObject({ code: 'yaml-syntax', file: 'w.yaml', severity: 'error' });
    expect(typeof diagnostics[0]!.line).toBe('number');
    expect(parseWorkflowFile('', 'w.yaml').diagnostics[0]!.code).toBe('invalid-format');
    expect(parseWorkflowFile('- a\n- b\n', 'w.yaml').value).toBeUndefined();
  });

  test('duplicate keys are a syntax error', () => {
    const { diagnostics } = parseWorkflowFile('workflow: w\nworkflow: v\n', 'w.yaml');
    expect(diagnostics[0]).toMatchObject({ code: 'yaml-syntax', line: 2 });
  });
});

describe('steps/*.md', () => {
  const step = (front: string, body = 'Do it.') => parseStepFile(`---\n${front}\n---\n${body}\n`, 'workflows/w/steps/s.md');

  test('writes: shorthand, from tool, from tool field, from person, defaults by performer', () => {
    const { value, diagnostics } = step([
      'title: S', 'performer: agent', 'model: m', 'outcomes: [done]',
      'writes:',
      '  a: Text',
      '  b: { type: Boolean, from: tool gst.validate_gstin }',
      '  c: { type: Text, from: { tool: gst.validate_gstin, field: result.legal_name }, required: true }',
      '  d: { type: Text, from: person }',
      '  e: { type: Text, from: judgement }',
    ].join('\n'));
    expect(diagnostics).toEqual([]);
    expect(value!.id).toBe('s');
    expect(value!.writes.a!.from).toEqual({ kind: 'judgement' });
    expect(value!.writes.b!.from).toEqual({ kind: 'tool', tool: 'gst.validate_gstin' });
    expect(value!.writes.c).toMatchObject({ from: { kind: 'tool', tool: 'gst.validate_gstin', field: 'result.legal_name' }, required: true });
    expect(value!.writes.d!.from).toEqual({ kind: 'person' });
    expect(value!.writes.e!.from).toEqual({ kind: 'judgement' });
    expect(value!.strictness).toBe('guided');
    expect(value!.tools).toEqual({ allowed: [], required: [] });
    expect(value!.checkpoint).toEqual([]);
    expect(value!.instructions).toBe('Do it.');
  });

  test('person and external steps default to from: person', () => {
    expect(step('title: S\nperformer: external\nwrites: { a: Text }').value!.writes.a!.from).toEqual({ kind: 'person' });
    expect(step('title: S\nperformer: person\nwrites: { a: Text }').value!.writes.a!.from).toEqual({ kind: 'person' });
  });

  test('budget forms and an inline policy', () => {
    const { value, diagnostics } = step('title: S\nperformer: agent\nbudget: { tokens: 1.5m, time: 1h30m, modelCalls: 5 }\npolicy:\n  effects: { outbound: deny }\n  tools: { rules: { mail.send: { rateLimit: 3/h } } }');
    expect(diagnostics).toEqual([]);
    expect(value!.budget).toEqual({ tokens: 1_500_000, timeMs: 5_400_000, modelCalls: 5 });
    expect(value!.policy).toEqual({ effects: { outbound: 'deny' }, tools: { rules: { 'mail.send': { rateLimit: { count: 3, perMs: 3_600_000 } } } }, file: 'workflows/w/steps/s.md' });
  });

  test('errors carry the line in the .md file (front matter starts on line 2)', () => {
    const { diagnostics } = step('title: S\nperformer: robot\nwrites:\n  a: List<Flag\nbudget: { tokens: lots }');
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'invalid-format', line: 3, path: 'performer' }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'invalid-type', line: 5, path: 'writes.a' }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'invalid-format', line: 6, path: 'budget.tokens', message: expect.stringContaining('40k') }));
  });

  test('a read that is not a case path, and an unknown from', () => {
    const { diagnostics } = step('title: S\nperformer: agent\nreads: [pan]\nwrites: { a: { type: Text, from: magic } }');
    expect(diagnostics.map((d) => d.path).sort()).toEqual(['reads.0', 'writes.a.from']);
  });

  test('no front matter', () => {
    const { value, diagnostics } = parseStepFile('Just prose.\n', 'steps/s.md');
    expect(value).toBeUndefined();
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'missing-front-matter', line: 1 })]);
  });

  test('the hash is sha256 of the file', () => {
    const text = '---\ntitle: S\nperformer: agent\n---\nx\n';
    const h = new Bun.CryptoHasher('sha256').update(text).digest('hex');
    expect(parseStepFile(text, 's.md').value!.hash).toBe(h);
  });
});

describe('case, entity, policy and example files', () => {
  test('case: types, field objects, bad types', () => {
    const { value, diagnostics } = parseCaseFile('case: c\nfields:\n  a: { type: Money, required: true, description: Turnover }\n  b: Lst<X>\ntypes:\n  Flag: { note: Text }\n  Text: { x: Text }\n', 'c.yaml');
    expect(value!.fields.a).toEqual({ type: { kind: 'scalar', name: 'Money' }, typeSource: 'Money', required: true, description: 'Turnover' });
    expect(value!.fields.b).toBeUndefined();
    expect(value!.types.Flag!.fields.note!.typeSource).toBe('Text');
    expect(diagnostics.map((d) => [d.code, d.line])).toEqual([['invalid-type-name', 7], ['invalid-type', 4]]);
  });

  test('entity: bad relationship', () => {
    const { value, diagnostics } = parseEntityFile('entity: E\nfields: { a: Text }\nrelationships:\n  x: several Things\n  y: one E\n', 'e.yaml');
    expect(value!.relationships).toEqual({ y: { cardinality: 'one', target: 'E' } });
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'invalid-format', line: 4, path: 'relationships.x' })]);
  });

  test('policy: every section, with 40k, 10m and 30/min forms', () => {
    const { value, diagnostics } = parsePolicyFile([
      'policy: p',
      'effects: { write: preview, outbound: approve }',
      'tools:',
      '  allow: [a, b]',
      '  deny: [c]',
      '  require: [a]',
      '  rules: { b: { treatment: approve, rateLimit: 30/min } }',
      'budgets: { tokens: 40k, time: 10m, modelCalls: 12, money: { amount: 50, currency: INR } }',
      'modelRoles: [checker]',
      'taint: { enabled: true, outboundWhenTainted: deny }',
    ].join('\n'), 'p.yaml');
    expect(diagnostics).toEqual([]);
    expect(value).toEqual({
      name: 'p',
      effects: { write: 'preview', outbound: 'approve' },
      tools: { allow: ['a', 'b'], deny: ['c'], require: ['a'], rules: { b: { treatment: 'approve', rateLimit: { count: 30, perMs: 60_000 } } } },
      budgets: { tokens: 40_000, timeMs: 600_000, modelCalls: 12, money: { amount: 50, currency: 'INR' } },
      modelRoles: ['checker'],
      taint: { enabled: true, outboundWhenTainted: 'deny' },
      file: 'p.yaml',
    });
  });

  test('policy: bad treatment and an empty file', () => {
    const { value, diagnostics } = parsePolicyFile('effects: { outbound: maybe, telepathy: allow }\n', 'p.yaml');
    expect(value!.effects).toEqual({});
    expect(diagnostics.map((d) => d.code).sort()).toEqual(['invalid-format', 'unknown-key']);
    expect(parsePolicyFile('', 'p.yaml')).toEqual({ value: { file: 'p.yaml' }, diagnostics: [] });
  });

  test('example: name defaults to the file name', () => {
    const { value, diagnostics } = parseExampleFile('case: { a: 1 }\nexpect: { state: end }\nmodel:\n  r:\n    - text: hi\n', 'workflows/w/examples/happy-path.yaml');
    expect(diagnostics).toEqual([]);
    expect(value).toEqual({ name: 'happy-path', case: { a: 1 }, model: { r: [{ text: 'hi' }] }, expect: { state: 'end' }, file: 'workflows/w/examples/happy-path.yaml' });
  });
});

describe('loadWorkflow and loadProject', () => {
  test('a step file without a state, a missing case file, an id that differs from the folder', async () => {
    const root = makeProject({
      'workflows/demo/workflow.yaml': 'workflow: other\nversion: 1\ncase: ./missing.yaml\nstart: work\nsteps:\n  work: { on: { done: end } }\n  review: { on: { approved: end } }\n',
      'workflows/demo/steps/stray.md': '---\ntitle: S\nperformer: person\n---\n',
    });
    const { workflow, diagnostics } = await loadWorkflow(`${root}/workflows/demo`, root);
    expect(workflow!.id).toBe('other');
    expect(workflow!.steps.stray).toBeUndefined();
    expect(diagnostics.map((d) => `${d.code}@${d.file}:${d.line}`).sort()).toEqual([
      'missing-case-file@workflows/demo/workflow.yaml:3',
      'step-without-state@workflows/demo/steps/stray.md:1',
      'workflow-id-mismatch@workflows/demo/workflow.yaml:1',
    ]);
  });

  test('a folder without workflow.yaml, and a duplicate workflow id', async () => {
    const root = makeProject({
      'workflows/empty/README.md': 'nothing here',
      'workflows/copy/workflow.yaml': 'workflow: demo\nversion: 1\nstart: a\nsteps: { a: { on: { x: end } } }\n',
      'workflows/copy/case.yaml': 'case: c\nfields: {}\n',
    });
    const { project, diagnostics } = await loadProject(root);
    expect(Object.keys(project.workflows)).toEqual(['demo']);
    expect(diagnostics.map((d) => d.code).sort()).toEqual(['duplicate-workflow', 'missing-workflow-file', 'workflow-id-mismatch']);
  });

  test('a case file outside the workflow folder is loaded and hashed', async () => {
    const root = makeProject({
      'workflows/demo/workflow.yaml': BASE_SHAPE.replace('start:', 'case: ../../shared/case.yaml\nstart:'),
      'workflows/demo/case.yaml': null,
      'shared/case.yaml': 'case: shared\nfields: { name: Text, flags: List<Flag> }\ntypes: { Flag: { note: Text } }\n',
    });
    const { workflow, diagnostics } = await loadWorkflow(`${root}/workflows/demo`, root);
    expect(diagnostics).toEqual([]);
    expect(workflow!.caseType).toMatchObject({ id: 'shared', file: 'shared/case.yaml' });
  });

  test('case and policy paths outside the project folder are errors and are never read', async () => {
    const root = makeProject({ 'workflows/demo/case.yaml': null });
    // A real file just outside the root: it must not be loaded even though it exists.
    const outside = `${basename(root)}-case.yaml`;
    writeFileSync(join(root, '..', outside), 'case: leaked\nfields: {}\n');
    writeFileSync(join(root, 'workflows/demo/workflow.yaml'),
      BASE_SHAPE.replace('start:', `case: ../../../${outside}\npolicy: /etc/hostname\nstart:`));
    try {
      const { workflow, diagnostics } = await loadWorkflow(`${root}/workflows/demo`, root);
      expect(diagnostics.map((d) => `${d.code}@${d.line}`).sort()).toEqual(['path-outside-project@3', 'path-outside-project@4']);
      expect(workflow!.caseType.id).toBe('');
      expect(workflow!.policy).toBeUndefined();
    } finally { rmSync(join(root, '..', outside), { force: true }); }
  });

  test('a missing project folder', async () => {
    const { diagnostics } = await loadProject('/nonexistent/memwise');
    expect(diagnostics[0]!.code).toBe('missing-project');
  });
});

const BASE_SHAPE = 'workflow: demo\nversion: 1\nstart: work\nsteps:\n  work: { on: { done: review } }\n  review:\n    on: { approved: end }\n    wait: { timeout: 2d -> end }\n';
