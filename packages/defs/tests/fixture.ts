/** A small valid project in a temp dir; tests break one file at a time. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll } from 'bun:test';
import type { CheckEnvironment } from '../src/index.ts';

export const SAMPLE = join(import.meta.dir, '..', '..', '..', 'examples', 'intake');

export const SAMPLE_ENV: CheckEnvironment = {
  tools: Object.fromEntries(
    ['gst.validate_gstin', 'intake.extract_fields', 'email.send', 'recall.step_record', 'recall.similar_cases', 'crm.create_customer', 'domain.customer.create', 'domain.customer.get',
      // The meta playbooks' tools (Phase 3, bound by the kernel).
      'playbooks.check_draft', 'playbooks.publish_draft', 'playbooks.vocabulary', 'playbooks.read', 'playbooks.write', 'playbooks.diff', 'playbooks.check']
      .map((t) => [t, {}]),
  ),
};

export const ENV: CheckEnvironment = { tools: { 'lookup.customer': { effect: 'read' }, 'mail.send': { effect: 'outbound' } } };

export const BASE: Record<string, string> = {
  'domain/policy.yaml': 'effects: { outbound: approve }\n',
  'domain/entities/customer.yaml': 'entity: Customer\nfields:\n  name: PersonName\n',
  'workflows/demo/workflow.yaml': `workflow: demo
version: 1
start: work
steps:
  work: { on: { done: review } }
  review:
    on: { approved: end }
    wait: { timeout: 2d -> end }
`,
  'workflows/demo/case.yaml': `case: demo
fields:
  name: Text
  flags: List<Flag>
  owner: Ref<Customer>
types:
  Flag:
    note: Text
`,
  'workflows/demo/steps/work.md': `---
title: Do the work
performer: agent
reads: [case.name]
writes:
  flags: List<Flag>
tools:
  allowed: [lookup.customer]
model: worker
outcomes: [done]
---
Look the customer up and flag anything odd.
`,
  'workflows/demo/steps/review.md': `---
title: Review
performer: person
outcomes: [approved]
---
A person looks at the flags.
`,
};

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Writes BASE with `changes` applied (a null value deletes the file) and returns the project root. */
export function makeProject(changes: Record<string, string | null> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'memwise-defs-'));
  dirs.push(root);
  for (const [path, text] of Object.entries({ ...BASE, ...changes })) {
    if (text === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
