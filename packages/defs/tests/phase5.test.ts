// Phase 5 (23 §3, §5): `extract:` on external and person steps, its checks, and the kernel's
// `external.` tool names.
import { describe, expect, test } from 'bun:test';
import { checkProject, DEFAULT_MIN_CONFIDENCE, loadProject, parseStepFile, RESERVED_TOOL_PREFIXES, type Diagnostic } from '../src/index.ts';
import { ENV, makeProject } from './fixture.ts';

const WF = 'workflows/demo/workflow.yaml';
const WORK = 'workflows/demo/steps/work.md';
const brief = (ds: Diagnostic[]) => ds.map((d) => `${d.severity} ${d.code} ${d.file}:${d.line ?? '?'}${d.path ? ` ${d.path}` : ''}`);

const CASE = `case: demo
fields:
  name: Text
  owner: Ref<Customer>
  docs: List<Document>
  photo: Image
  flags: List<Flag>
types:
  Flag:
    note: Text
`;
const SHAPE = 'workflow: demo\nversion: 1\nstart: work\nsteps:\n  work:\n    on: { done: review }\n    wait: { timeout: 2d -> end }\n  review:\n    on: { approved: end }\n    wait: { timeout: 2d -> end }\n';
const FORM = (extract: string, extra = '') => `---
title: The client fills the form
performer: external
assignee: staff
writes:
  name: { type: Text, from: person }
  docs: { type: List<Document>, from: person }
${extra}extract:
${extract}
outcomes: [done]
---
Fill it in.
`;
const GOOD = '  tool: lookup.customer\n  documents: docs\n  fields: [name]';

async function check(work: string, env = ENV) {
  const { project, diagnostics } = await loadProject(makeProject({ 'workflows/demo/case.yaml': CASE, [WF]: SHAPE, [WORK]: work }));
  return brief([...diagnostics, ...checkProject(project, env)]);
}

describe('extract:', () => {
  test('parses a list, a map and `as:` items into result name -> write, with a default min_confidence', () => {
    const list = parseStepFile(FORM(GOOD), WORK).value!;
    expect(list.extract).toEqual({ tool: 'lookup.customer', documents: 'docs', fields: { name: 'name' }, minConfidence: DEFAULT_MIN_CONFIDENCE });
    expect(DEFAULT_MIN_CONFIDENCE).toBe(0.8);
    const map = parseStepFile(FORM('  tool: lookup.customer\n  documents: docs\n  fields: { legal_name: name }\n  min_confidence: 0.9'), WORK).value!;
    expect(map.extract).toEqual({ tool: 'lookup.customer', documents: 'docs', fields: { legal_name: 'name' }, minConfidence: 0.9 });
    const as = parseStepFile(FORM('  tool: lookup.customer\n  documents: docs\n  fields: [{ legal_name: { as: name } }]'), WORK).value!;
    expect(as.extract!.fields).toEqual({ legal_name: 'name' });
  });

  test('a valid extract checks clean', async () => {
    expect(await check(FORM(GOOD))).toEqual([]);
  });

  test('only on external and person steps', async () => {
    const agent = FORM(GOOD).replace('performer: external\nassignee: staff', 'performer: agent\nmodel: worker\ntools: { allowed: [lookup.customer] }');
    expect(await check(agent)).toContain(`error extract-not-on-form-step ${WORK}:9 extract`);
  });

  test('documents must be a Document write of the step; every field a write', async () => {
    expect(await check(FORM('  tool: lookup.customer\n  documents: photo\n  fields: [name]'))).toEqual([`error extract-documents-not-written ${WORK}:10 extract.documents`]);
    expect(await check(FORM('  tool: lookup.customer\n  documents: name\n  fields: [name]'))).toEqual([
      `error extract-documents-not-document ${WORK}:10 extract.documents`,
      `error extract-field-not-written ${WORK}:11 extract.fields`, // the documents field itself
    ]);
    expect(await check(FORM('  tool: lookup.customer\n  documents: docs\n  fields: [name, owner]'))).toEqual([`error extract-field-not-written ${WORK}:11 extract.fields`]);
    expect(await check(FORM('  tool: lookup.customer\n  documents: docs\n  fields: []'))).toEqual([`error extract-no-fields ${WORK}:11 extract.fields`]);
  });

  test('the tool must be bound and `read`', async () => {
    expect(await check(FORM('  tool: mail.send\n  documents: docs\n  fields: [name]'))).toEqual([`error extract-tool-not-read ${WORK}:9 extract.tool`]);
    expect(await check(FORM('  tool: nope.read\n  documents: docs\n  fields: [name]'))).toEqual([`error unknown-tool ${WORK}:9 extract.tool`]);
  });

  test('min_confidence is between 0 and 1', async () => {
    const r = await check(FORM(`${GOOD}\n  min_confidence: 2`));
    expect(r.some((d) => d.startsWith('error invalid-format') && d.includes(WORK))).toBe(true);
  });
});

test('`external.` tool names belong to the kernel', () => {
  expect(RESERVED_TOOL_PREFIXES).toContain('external.');
});
