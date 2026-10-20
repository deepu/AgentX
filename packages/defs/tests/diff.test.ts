import { describe, expect, test } from 'bun:test';
import { describeStructuralDiff, lineDiff, loadProject, structuralDiff, type DiffHunk, type WorkflowDef } from '../src/index.ts';
import { BASE, makeProject } from './fixture.ts';

/** Applies hunks to `a`; must give `b` for any correct diff. */
function patch(a: string, hunks: DiffHunk[]): string[] {
  const old = a ? a.replace(/\n$/, '').split('\n') : [];
  const out: string[] = [];
  let at = 0;
  for (const h of hunks) {
    const start = h.oldLines ? h.oldStart - 1 : h.oldStart;
    out.push(...old.slice(at, start));
    at = start;
    for (const l of h.lines) {
      if (l.kind === 'added') out.push(l.text);
      else { expect(old[at]).toBe(l.text); at++; if (l.kind === 'same') out.push(l.text); }
    }
  }
  out.push(...old.slice(at));
  return out;
}

describe('lineDiff', () => {
  test('equal texts have no hunks', () => {
    expect(lineDiff('a\nb\n', 'a\nb\n')).toEqual([]);
    expect(lineDiff('', '')).toEqual([]);
  });

  test('additions, removals and changes with context', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nB\nc\n', 1)).toEqual([{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [
      { kind: 'same', text: 'a' }, { kind: 'removed', text: 'b' }, { kind: 'added', text: 'B' }, { kind: 'same', text: 'c' },
    ] }]);
    expect(lineDiff('', 'x\ny\n')).toEqual([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: [{ kind: 'added', text: 'x' }, { kind: 'added', text: 'y' }] }]);
    expect(lineDiff('x\n', '')).toEqual([{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: [{ kind: 'removed', text: 'x' }] }]);
  });

  test('far-apart changes make separate hunks; close ones share one', () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n');
    const far = a.replace('l2\n', 'L2\n').replace('l18\n', 'L18\n');
    const hunks = lineDiff(a, far, 2);
    expect(hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([[1, 4, 1, 4], [16, 5, 16, 5]]);
    const near = a.replace('l5\n', 'L5\n').replace('l9\n', 'L9\n');
    expect(lineDiff(a, near, 2).length).toBe(1);
    expect(lineDiff(a, near, 1).length).toBe(2);
  });

  test('hunks always patch a into b', () => {
    const cases: [string, string][] = [
      ['a\nb\nc\nd\ne\nf\ng\n', 'a\nc\nd\nX\ne\ng\nh\n'],
      ['one\ntwo\nthree\n', 'zero\none\nthree\nfour\n'],
      ['x\nx\nx\ny\n', 'y\nx\nx\n'],
      ['', 'new\nfile\n'],
      ['gone\n', ''],
    ];
    for (const [a, b] of cases) {
      for (const ctx of [0, 1, 3]) expect(patch(a, lineDiff(a, b, ctx))).toEqual(b ? b.replace(/\n$/, '').split('\n') : []);
    }
  });
});

const WORK = 'workflows/demo/steps/work.md';

async function demo(changes: Record<string, string | null> = {}): Promise<{ workflow: WorkflowDef; roles: string[] }> {
  const { project } = await loadProject(makeProject(changes));
  return { workflow: project.workflows.demo!, roles: Object.keys(project.roles) };
}

describe('structuralDiff', () => {
  test('no change is an empty diff', async () => {
    const { workflow } = await demo();
    expect(structuralDiff(workflow, workflow)).toEqual({
      workflowId: 'demo', states: {}, transitions: [], steps: {}, caseFields: { added: [], removed: [], changed: [] },
      tools: { added: [], removed: [] }, requiredTools: [], roles: { added: [], removed: [] },
      examples: { added: [], removed: [], changed: [] }, version: { from: 1, to: 1 }, playbook: [],
    });
  });

  test('states, transitions, steps and their parts, case fields, tools, roles, examples, playbook', async () => {
    const before = await demo({ 'domain/roles.yaml': 'roles:\n  staff: Staff\n  clerk: Clerk\n', 'workflows/demo/examples/a.yaml': 'case: { name: A }\nexpect: { outcome: done }\n', 'workflows/demo/examples/b.yaml': 'case: {}\nexpect: {}\n' });
    const after = await demo({
      'domain/roles.yaml': 'roles:\n  staff: Staff\n  manager: Manager\n',
      'workflows/demo/workflow.yaml': `workflow: demo
version: 2
title: Demo
start: work
steps:
  work: { on: { done: review, failed: fix } }
  fix: { on: { done: review } }
  review:
    on: { approved: end }
    wait: { timeout: 3d -> end }
`,
      'workflows/demo/case.yaml': BASE['workflows/demo/case.yaml']!.replace('  name: Text\n', '  name: { type: Text, required: true }\n  email: Email\n').replace('  owner: Ref<Customer>\n', ''),
      [WORK]: BASE[WORK]!.replace('allowed: [lookup.customer]', 'allowed: [mail.send]\n  required: [mail.send]').replace('Look the customer up', 'Look them up'),
      'workflows/demo/steps/fix.md': '---\ntitle: Fix\nperformer: agent\nmodel: worker\noutcomes: [done]\n---\nFix it.\n',
      'workflows/demo/examples/a.yaml': 'case: { name: B }\nexpect: { outcome: done }\n',
      'workflows/demo/examples/c.yaml': 'case: {}\nexpect: {}\n',
    });
    const s = structuralDiff(before.workflow, after.workflow, { before: before.roles, after: after.roles });
    expect(s.states).toEqual({ work: 'changed', fix: 'added', review: 'changed' });
    // review's timeout is longer now (a changed state) but still goes to end (the same transition).
    expect(s.transitions).toEqual([
      { from: 'work', event: 'failed', to: 'fix', change: 'added' },
      { from: 'fix', event: 'done', to: 'review', change: 'added' },
    ]);
    expect(s.steps).toEqual({ work: { change: 'changed', parts: ['instructions', 'tools'] }, fix: { change: 'added', parts: [] } });
    expect(s.caseFields).toEqual({ added: ['email'], removed: ['owner'], changed: ['name'] });
    expect(s.tools).toEqual({ added: ['mail.send'], removed: ['lookup.customer'] });
    expect(s.requiredTools).toEqual([{ step: 'work', tool: 'mail.send', change: 'added' }]);
    expect(s.roles).toEqual({ added: ['manager'], removed: ['clerk'] });
    expect(s.examples).toEqual({ added: ['c'], removed: ['b'], changed: ['a'] });
    expect(s.version).toEqual({ from: 1, to: 2 });
    expect(s.playbook).toEqual(['title']);
    const words = describeStructuralDiff(s);
    expect(words).toContain('Version 1 → 2.');
    expect(words).toContain('Step `work`: instructions, tools changed.');
    expect(words).toContain('Step `work` must now call `mail.send`.');
    // Named for people (a review card): whatever the caller says, no code formatting.
    const named = describeStructuralDiff(s, { name: (kind, id) => `“${kind}:${id}”` });
    expect(named).toContain('Step “state:work” must now call “tool:mail.send”.');
    expect(named).toContain('New case fields “field:email”.');
    expect(named.join(' ')).not.toContain('`');
  });

  test('each step part is told apart', async () => {
    const base = await demo();
    const front = (extra: string) => BASE[WORK]!.replace('outcomes: [done]', `outcomes: [done]\n${extra}`);
    const cases: [string, string][] = [
      ['title', BASE[WORK]!.replace('title: Do the work', 'title: Work')],
      ['strictness', front('strictness: strict')],
      ['model', BASE[WORK]!.replace('model: worker', 'model: checker')],
      ['reads', BASE[WORK]!.replace('reads: [case.name]', 'reads: []')],
      ['writes', BASE[WORK]!.replace('  flags: List<Flag>\n', '')],
      ['budget', front('budget: { tokens: 10k }')],
      ['checkpoint', front('checkpoint: [All flags explained]')],
      ['policy', front('policy: { effects: { write: deny } }')],
      ['assignee', front('assignee: staff')],
      ['engine', front('engine: open\nstrictness: guided').replace('strictness: guided', '')],
    ];
    for (const [part, text] of cases) {
      const after = await demo({ [WORK]: text });
      expect(structuralDiff(base.workflow, after.workflow).steps.work?.parts).toEqual([part as never]);
    }
  });

  test('a new playbook: everything added, no version before', async () => {
    const { workflow } = await demo();
    const s = structuralDiff(undefined, workflow);
    expect(s.states).toEqual({ work: 'added', review: 'added' });
    expect(s.steps).toEqual({ work: { change: 'added', parts: [] }, review: { change: 'added', parts: [] } });
    expect(s.caseFields.added).toEqual(['flags', 'name', 'owner']);
    expect(s.version).toEqual({ to: 1 });
    expect(s.playbook).toEqual([]);
    expect(describeStructuralDiff(s)[0]).toBe('New playbook `demo`, version 1.');
  });
});
