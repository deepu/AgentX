/** A small valid two-domain project in a temp dir (Phase 6); tests break one file at a time. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll } from 'bun:test';
import { checkProject, loadProject, type Diagnostic } from '../src/index.ts';

export const ETMF = join(import.meta.dir, '..', '..', '..', 'examples', 'etmf');

export const MULTI: Record<string, string> = {
  'workspace.yaml': 'workspace: Acme\nroles:\n  clerk: Clerk\n  boss: { title: Boss }\npolicy:\n  effects: { irreversible: deny }\nstorm_limit: 10\n',
  'domains/sales/domain.yaml': 'name: Sales\nowner: boss\nintake: { address: sales }\n',
  'domains/sales/policy.yaml': 'modelRoles: [worker, verifier]\n',
  'domains/sales/entities/account.yaml': `entity: Account
title: "{name} ({region})"
fields:
  name: { type: Text, required: true }
  region: Text
  opened: Date
  vip: Boolean
relationships:
  orders: many Order
calculated:
  order_count: { count: orders }
  shipped:     { percent: orders, where: "status = 'shipped'" }
lifecycle:
  initial: lead
  states:
    lead:   { on: { won: active } }
    active: { on: { lost: lead } }
  transitions:
    won: { guard: "order_count > 0" }
`,
  'domains/sales/entities/order.yaml': 'entity: Order\nfields:\n  account: Ref<Account>\n  total: Number\n  placed: DateTime\n  receipt: Document\nlifecycle: [open, shipped]\n',
  'domains/sales/workflows/onboard/workflow.yaml': `workflow: onboard
version: 1
owner: boss
start: welcome
starts_on:
  - entered: Account.active
steps:
  welcome:
    on: { done: hand_off }
    wait: { timeout: 2d -> end }
  hand_off:
    start: { workflow: ops-setup, with: { account: case.account, note: case.note } }
    on: { started: end }
`,
  'domains/sales/workflows/onboard/case.yaml': 'case: onboarding\nfields:\n  account: Ref<Account>\n  note: Text\n',
  'domains/sales/workflows/onboard/steps/welcome.md': '---\ntitle: Welcome them\nperformer: person\nassignee: clerk\nreads: [case.account]\nwrites:\n  note: Text\noutcomes: [done]\n---\nCall the new account.\n',
  'domains/ops/domain.yaml': 'name: Operations\naccepts_from: [sales]\n',
  'domains/ops/entities/account.yaml': 'entity: Account\nfields:\n  number: Text\nlinks:\n  sales.Account: { match: { number: name }, follow: [region] }\n',
  'domains/ops/workflows/ops-setup/workflow.yaml': 'workflow: ops-setup\nversion: 1\nstart: setup\nsteps:\n  setup:\n    on: { done: end }\n    wait: { timeout: 2d -> end }\n',
  'domains/ops/workflows/ops-setup/case.yaml': 'case: setup\nfields:\n  account: Ref<sales.Account>\n  note: Text\n',
  'domains/ops/workflows/ops-setup/steps/setup.md': '---\ntitle: Set it up\nperformer: person\nassignee: clerk\nreads: [case.account]\noutcomes: [done]\n---\nSet the account up.\n',
};

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Writes MULTI with `changes` applied (a null value deletes the file) and returns the project root. */
export function makeMulti(changes: Record<string, string | null> = {}, base: Record<string, string> = MULTI): string {
  const root = mkdtempSync(join(tmpdir(), 'memwise-defs6-'));
  dirs.push(root);
  for (const [path, text] of Object.entries({ ...base, ...changes })) {
    if (text === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** `severity code file path` per diagnostic, for compact assertions. */
export const brief = (ds: Diagnostic[]) => ds.map((d) => `${d.severity} ${d.code} ${d.file}${d.path ? ` ${d.path}` : ''}`);

/** Loads and checks a MULTI variant: the load diagnostics and the checks together. */
export async function checkMulti(changes: Record<string, string | null> = {}): Promise<string[]> {
  const { project, diagnostics } = await loadProject(makeMulti(changes));
  return brief([...diagnostics, ...checkProject(project, { tools: {} })]);
}
