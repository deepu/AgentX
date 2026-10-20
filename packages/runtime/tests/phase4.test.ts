// Phase 4 kernel (docs/memwise/22-phase-4-interfaces.md) on a temp copy of examples/intake with
// two fixture plugins: a MemWise plugin (command and builtin routes) and a Claude plugin over MCP
// (a tiny stdio server). Install, bind through the bind-plugin playbook (scripted binder), tools
// bound only after freeze, plugin policy layers, identity resolution and decisions, read-through.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PgEntityStore, type TestDatabase } from '@memwise/db';
import { bindingPath, parseBindingFile, type ExampleOutcome } from '@memwise/defs';
import { scriptedProvider, type ToolDefinition } from '@memwise/gateway';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernel } from '../src/kernel.ts';
import { sampleTools } from '../src/sample-tools.ts';
import type { Actor, Kernel, TestRunner } from '../src/types.ts';
import { INTAKE_DIR } from './fixtures/exit-setup.ts';
import { kernelDatabase, pgAvailable } from './helpers.ts';

type PersonActor = Extract<Actor, { kind: 'person' }>;

const FIXTURES = join(import.meta.dir, 'fixtures', 'plugins');
const PROJECT = mkdtempSync(join(tmpdir(), 'mw-p4-project-'));
cpSync(INTAKE_DIR, PROJECT, { recursive: true });
// A playbook using a plugin tool: before tiny-tools is bound, its step can't call it.
mkdirSync(join(PROJECT, 'workflows', 'shout-it', 'steps'), { recursive: true });
writeFileSync(join(PROJECT, 'workflows', 'shout-it', 'workflow.yaml'), `workflow: shout-it
version: 1
title: Shout it
owner: manager
case: ./case.yaml
start: shout
steps:
  shout: { on: { done: end } }
  needs_person:
    on: { resolved: shout }
    assignee: manager
    wait: { timeout: 7d → end }
`);
writeFileSync(join(PROJECT, 'workflows', 'shout-it', 'case.yaml'), `case: shout
fields:
  word: Text
  loud: Text
`);
writeFileSync(join(PROJECT, 'workflows', 'shout-it', 'steps', 'shout.md'), `---
title: Shout the word
performer: system
strictness: strict
reads: [case.word]
tools:
  allowed:  [tiny.shout]
  required: [tiny.shout]
map:
  tiny.shout: { word: case.word }
writes:
  loud: { type: Text, from: { tool: tiny.shout, field: word } }
outcomes: [done]
---
Shout it.
`);

const lookup: ToolDefinition = {
  name: 'tiny.lookup', description: 'Looks a word up', inputSchema: { type: 'object' }, effect: 'read',
  execute: async (args: { word: string }) => ({ found: args.word }),
};

// The binder classifies what the MCP hints left open; it leaves `draft` out (the run's own draft).
const binderTurns = [
  { toolCalls: [{ name: 'plugins.classify_tools', args: {
    classes: { 'crm.create_contact': 'write', 'crm.fail': 'irreversible' },
    reasons: { 'crm.create_contact': 'It adds a contact to the CRM.', 'crm.fail': 'Nothing says what it does, so the strictest class.' },
  } }] },
  { toolCalls: [{ name: 'step.finish', args: { outcome: 'proposed', rationale: 'Creating a contact writes to the CRM; the unknown tool is irreversible.' } }] },
];

let db: TestDatabase;
let kernel: Kernel;
let staff: PersonActor, manager: PersonActor;
const runnerCalls: Parameters<TestRunner>[0][] = [];
const runner: TestRunner = async (req) => { runnerCalls.push(req); return [] as ExampleOutcome[]; };
const changes: string[] = [];

const stepRunOf = async (runId: string, state: string) => {
  for (let i = 0; i < 300; i++) {
    const run = await kernel.getRun(runId);
    if (run?.state === state) {
      const id = `${runId}/${run.enteredSeq}/${state}`;
      if ((await kernel.getStepRecord(id))?.status === 'waiting') return id;
    }
    if (run && run.status !== 'active') throw new Error(`${runId} ended in ${run.state}: ${run.stopReason}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${runId} never waited in ${state} (now ${JSON.stringify(await kernel.getRun(runId))})`);
};
const until = (runId: string, state: string, timeoutMs = 60_000) => kernel.waitForRun(runId, { until: (r) => r.state === state || r.status !== 'active', timeoutMs });

describe.skipIf(!pgAvailable)('Phase 4 kernel', () => {
  beforeAll(async () => {
    db = await kernelDatabase('mw_rt_p4');
    kernel = await createKernel({
      databaseUrl: db.url,
      projectDir: PROJECT,
      filesDir: mkdtempSync(join(tmpdir(), 'mw-p4-files-')),
      tools: sampleTools({ databaseUrl: db.url }),
      builtins: [lookup],
      modelRoles: { binder: { provider: 'scripted', model: 's' } },
      providers: [scriptedProvider({ binder: binderTurns })],
      testRunner: (req) => runner(req),
      logLevel: 'error',
    });
    expect((await kernel.index()).filter((d) => d.severity === 'error')).toEqual([]);
    kernel.onChange((c) => changes.push(c.kind));
    const add = async (name: string, roles: string[]) => kernel.people.actorFor((await kernel.people.create({ name, email: `${name}@acme.example`, roles })).id);
    staff = await add('sam', ['staff']);
    manager = await add('maya', ['manager']);
  }, 120_000);
  afterAll(async () => { await kernel?.shutdown(); await db?.drop(); });

  test('installing copies the plugin and binds nothing; a Claude plugin gets its MCP tools discovered', async () => {
    const tiny = await kernel.plugins.install(join(FIXTURES, 'tiny-tools'), manager);
    expect(tiny).toMatchObject({ id: 'test/tiny-tools', version: '1.0.0', binding: { status: 'unbound' }, tools: 4 });
    const crm = await kernel.plugins.install(join(FIXTURES, 'tiny-crm'), manager);
    expect(crm).toMatchObject({ id: 'claude/tiny-crm', imported: 'claude-plugin', trust: 'community', binding: { status: 'unbound' }, tools: 4 });
    expect(existsSync(join(PROJECT, 'plugins', 'claude__tiny-crm', '1.0.0', 'memwise-plugin.yaml'))).toBe(true);

    const detail = (await kernel.plugins.get('claude/tiny-crm'))!;
    expect(detail.toolClasses.find((t) => t.name === 'crm.list_contacts')).toMatchObject({ from: 'annotations' });
    expect(detail.toolClasses.find((t) => t.name === 'crm.create_contact')).toMatchObject({ from: 'none' });
    expect(detail.toolClasses.find((t) => t.name === 'crm.create_contact')!.effect).toBeUndefined();
    expect(detail.notes.join(' ')).toContain('found 4 tools on the MCP server crm');
    expect(detail.manifest.records.contact).toMatchObject({ list: { tool: 'crm.list_contacts' } });
    expect((await kernel.plugins.list()).map((p) => p.id)).toEqual(['claude/tiny-crm', 'test/tiny-tools']);
    const { rows } = await kernel.pool.query(`select id, version, installed_by from mw.plugins order by id`);
    expect(rows).toEqual([
      { id: 'claude/tiny-crm', version: '1.0.0', installed_by: manager.personId },
      { id: 'test/tiny-tools', version: '1.0.0', installed_by: manager.personId },
    ]);
    // Nothing is bound: no plugin tool reaches a playbook.
    const vocab = await kernel.authoring!.vocabulary();
    expect(vocab.tools.filter((t) => t.name.startsWith('tiny.') || t.name.endsWith('_contact') || t.name.endsWith('_contacts'))).toEqual([]);
  }, 60_000);

  test('before its binding is frozen a plugin tool is not bound: the step goes to a person', async () => {
    const { runId } = await kernel.startRun({ workflowId: 'shout-it', case: { word: 'hi' } });
    const run = await until(runId, 'needs_person');
    expect(run.state === 'needs_person' || run.status === 'stopped').toBe(true);
    const record = await kernel.getStepRecord(`${runId}/0/shout`);
    expect(record?.rationale).toContain('unknown tool "tiny.shout"');
  }, 60_000);

  test('bind-plugin: all classified, dry run, review, freeze, link; the tools are bound after', async () => {
    const { runId, caseId } = await kernel.plugins.startBind('test/tiny-tools', manager);
    await expect(kernel.plugins.startBind('test/tiny-tools', manager)).rejects.toThrow('already being bound');
    const review = await stepRunOf(runId, 'review');
    const c = (await kernel.getCase(caseId))!.values;
    expect(c.version?.value).toBe('1.0.0');
    expect(c.gaps?.value).toBe(0);
    expect(c.report?.value).toMatch(/^Checks pass/);
    expect((await kernel.plugins.list()).find((p) => p.id === 'test/tiny-tools')!.binding).toMatchObject({ status: 'binding', runId });
    const view = (await kernel.plugins.binding('test/tiny-tools', { draftId: c.draft!.value as string }))!;
    expect(view.binding).toMatchObject({ plugin: 'test/tiny-tools', pluginVersion: '1.0.0' });
    expect(view.report).toMatchObject({ outcome: 'passed', plugin: 'test/tiny-tools' });
    expect(view.pluginPolicy).toMatchObject({ tools: { rules: { 'tiny.shout': {} } } });
    // Nothing live yet.
    expect(existsSync(join(PROJECT, bindingPath('test/tiny-tools')))).toBe(false);

    expect(await kernel.submitStep({ stepRunId: review, outcome: 'approved', by: manager })).toMatchObject({ applied: true });
    const done = await until(runId, 'end');
    expect(done.state).toBe('end');
    expect((await kernel.getCase(caseId))!.values.binding_version?.value).toBe(1);

    const text = readFileSync(join(PROJECT, bindingPath('test/tiny-tools')), 'utf8');
    const live = parseBindingFile(text, bindingPath('test/tiny-tools')).value!;
    expect(live).toMatchObject({ version: 1, frozen: { by: manager.personId, runId }, dryRun: { passed: true } });
    const { rows } = await kernel.pool.query(`select plugin_id, version, plugin_version, frozen_by, run_id from mw.binding_versions`);
    expect(rows).toEqual([{ plugin_id: 'test/tiny-tools', version: 1, plugin_version: '1.0.0', frozen_by: manager.personId, run_id: runId }]);
    expect((await kernel.plugins.list()).find((p) => p.id === 'test/tiny-tools')!.binding).toMatchObject({ status: 'bound', version: 1 });
    expect(changes).toContain('plugins');

    const vocab = await kernel.authoring!.vocabulary();
    expect(vocab.tools.find((t) => t.name === 'tiny.shout')).toMatchObject({ effect: 'read', plugin: 'test/tiny-tools' });
    expect(vocab.tools.find((t) => t.name === 'tiny.lookup')).toMatchObject({ plugin: 'test/tiny-tools' });
  }, 120_000);

  test('a bound plugin tool runs (command route) under its plugin layer', async () => {
    const policy = await kernel.effectivePolicy('shout-it', 'shout');
    expect(policy.effective.layers.map((l) => [l.kind, l.name])).toContainEqual(['plugin', 'test/tiny-tools']);
    expect(policy.effective.tools.perTool['tiny.shout']?.rateLimit?.origin).toMatchObject({ layer: 'plugin', name: 'test/tiny-tools' });
    // A step that uses none of its tools gets no plugin layer.
    expect((await kernel.effectivePolicy('client-intake', 'fill')).effective.layers.some((l) => l.kind === 'plugin')).toBe(false);

    const { runId, caseId } = await kernel.startRun({ workflowId: 'shout-it', case: { word: 'hello' } });
    const run = await until(runId, 'end');
    expect(run.state).toBe('end');
    expect((await kernel.getCase(caseId))!.values.loud?.value).toBe('HELLO');
  }, 60_000);

  test('an upgrade is a proposal from the live binding; a draft changed after its dry run is stale at freeze', async () => {
    // Version 1.1.0 of tiny-tools, beside 1.0.0: installing it changes nothing live.
    const v2 = mkdtempSync(join(tmpdir(), 'mw-p4-tiny-v2-'));
    cpSync(join(FIXTURES, 'tiny-tools'), v2, { recursive: true });
    writeFileSync(join(v2, 'memwise-plugin.yaml'), readFileSync(join(v2, 'memwise-plugin.yaml'), 'utf8').replace('version: 1.0.0', 'version: 1.1.0'));
    expect(await kernel.plugins.install(v2, manager)).toMatchObject({ version: '1.1.0', versions: ['1.1.0', '1.0.0'], upgradeAvailable: true, binding: { status: 'bound', version: 1, pluginVersion: '1.0.0' } });

    const { runId, caseId } = await kernel.plugins.startBind('test/tiny-tools', manager);
    const review = await stepRunOf(runId, 'review');
    const c = (await kernel.getCase(caseId))!.values;
    expect(c.summary?.value).toContain('An upgrade from 1.0.0 (binding version 1) to 1.1.0');
    const draftId = c.draft!.value as string;
    const view = (await kernel.plugins.binding('test/tiny-tools', { draftId }))!;
    expect(view.binding).toMatchObject({ pluginVersion: '1.1.0', version: 1 });
    expect(view.report!.impact).toEqual([]);

    // Someone edits the draft after the dry run: freezing refuses it and the dry run runs again.
    const tightened = view.text.replace(/^records: \{\}$/m, 'records: {}\npolicy: { effects: { write: approve } }');
    expect(tightened).not.toBe(view.text);
    await kernel.authoring!.write({ draftId, files: [{ path: view.path, content: tightened }], summary: 'Writes need approval', via: 'editor' }, staff);
    const entered = (await kernel.getRun(runId))!.enteredSeq;
    expect(await kernel.submitStep({ stepRunId: review, outcome: 'approved', by: manager })).toMatchObject({ applied: true });
    await kernel.waitForRun(runId, { until: (r) => (r.state === 'review' && r.enteredSeq > entered) || r.status !== 'active', timeoutMs: 60_000 });
    const again = await stepRunOf(runId, 'review');
    const path = (await kernel.getCaseView(caseId, manager))!.path;
    expect(path).toEqual(['check', 'propose', 'dry_run', 'review', 'freeze', 'dry_run', 'review']);
    expect(await kernel.submitStep({ stepRunId: again, outcome: 'approved', by: manager })).toMatchObject({ applied: true });
    expect((await until(runId, 'end')).state).toBe('end');
    expect((await kernel.getCase(caseId))!.values.binding_version?.value).toBe(2);

    const live = parseBindingFile(readFileSync(join(PROJECT, bindingPath('test/tiny-tools')), 'utf8'), bindingPath('test/tiny-tools')).value!;
    expect(live).toMatchObject({ version: 2, pluginVersion: '1.1.0', policy: { effects: { write: 'approve' } } });
    // The binding's tightening is a plugin layer of its own, under the plugin's.
    const layers = (await kernel.effectivePolicy('shout-it', 'shout')).effective.layers.map((l) => l.name);
    expect(layers).toEqual(expect.arrayContaining(['test/tiny-tools', 'test/tiny-tools binding']));
    expect((await kernel.plugins.list()).find((p) => p.id === 'test/tiny-tools')).toMatchObject({ binding: { status: 'bound', version: 2, pluginVersion: '1.1.0' } });
    expect((await kernel.plugins.list()).find((p) => p.id === 'test/tiny-tools')!.upgradeAvailable).toBeUndefined();
  }, 120_000);

  let acme = '', menon = '';

  test('bind-plugin for a Claude plugin: the binder classifies, the dry run maps sample records, link resolves identities', async () => {
    const store = new PgEntityStore();
    const customer = (await kernel.project()).project.entities.Customer!;
    acme = await store.create(kernel.pool, customer, { name: 'Acme Traders Pvt Ltd', gstin: '29AAACA1234A1Z5' });
    menon = await store.create(kernel.pool, customer, { name: 'Menon Exporters' });

    const { runId, caseId } = await kernel.plugins.startBind('claude/tiny-crm', manager);
    const review = await stepRunOf(runId, 'review');
    const c = (await kernel.getCase(caseId))!.values;
    expect(c.unclassified?.value).toContain('crm.create_contact');
    const draftId = c.draft!.value as string;
    const view = (await kernel.plugins.binding('claude/tiny-crm', { draftId }))!;
    expect(view.binding.tools['crm.create_contact']).toMatchObject({ effect: 'write', reason: 'It adds a contact to the CRM.' });
    expect(view.binding.tools['crm.list_contacts']).toMatchObject({ effect: 'read' });
    expect(view.binding.records.contact).toMatchObject({ entity: 'Customer' });
    expect(view.report!.records.map((r) => r.externalId)).toEqual(['c1', 'c2', 'c3']);
    expect(view.report!.records[0]!.values).toMatchObject({ email: 'accounts@acme-traders.example', gstin: '29AAACA1234A1Z5' });
    expect(view.report!.records[0]!.extra).toMatchObject({ 'crm.city': 'Bengaluru' });

    expect(await kernel.submitStep({ stepRunId: review, outcome: 'approved', by: manager })).toMatchObject({ applied: true });
    const done = await until(runId, 'end');
    expect(done.state).toBe('end');
    const values = (await kernel.getCase(caseId))!.values;
    expect([values.linked?.value, values.candidates?.value]).toEqual([1, 1]);

    const links = await kernel.identity.links('Customer', acme);
    expect(links).toEqual([expect.objectContaining({ plugin: 'claude/tiny-crm', source: 'contact', externalId: 'c1', method: 'key', reasons: ['same GSTIN'] })]);
  }, 120_000);

  test('an uncertain match waits in the owner role\'s inbox; a person decides it; resolving again changes nothing', async () => {
    const managerInbox = (await kernel.inbox(manager)).filter((i) => i.kind === 'identity');
    expect(managerInbox).toHaveLength(1);
    const item = managerInbox[0]!;
    if (item.kind !== 'identity') throw new Error('expected an identity item');
    expect(item.candidate).toMatchObject({ recordId: menon, externalId: 'c2', status: 'pending', external: { name: 'Menon Exports' } });
    expect((await kernel.inbox(staff)).some((i) => i.kind === 'identity')).toBe(false);

    expect(await kernel.identity.decide({ candidateId: item.candidate.id, decision: 'confirm', by: staff })).toMatchObject({ applied: false });
    expect(await kernel.identity.decide({ candidateId: item.candidate.id, decision: 'confirm', by: manager })).toEqual({ applied: true });
    expect(await kernel.identity.decide({ candidateId: item.candidate.id, decision: 'reject', by: manager })).toMatchObject({ applied: false });
    expect(await kernel.identity.links('Customer', menon)).toEqual([expect.objectContaining({ externalId: 'c2', method: 'person', linkedBy: manager.personId })]);
    expect((await kernel.inbox(manager)).some((i) => i.kind === 'identity')).toBe(false);

    const before = (await kernel.pool.query(`select count(*)::int as n from mw.identity_links`)).rows[0].n;
    expect(await kernel.identity.resolve({ plugin: 'claude/tiny-crm' })).toEqual({ linked: 2, candidates: 0, unmatched: 1, created: 0 });
    expect(await kernel.identity.resolve({ plugin: 'claude/tiny-crm' })).toEqual({ linked: 2, candidates: 0, unmatched: 1, created: 0 });
    expect((await kernel.pool.query(`select count(*)::int as n from mw.identity_links`)).rows[0].n).toBe(before);
    expect(await kernel.identity.candidates({ status: 'confirmed' })).toHaveLength(1);
  }, 60_000);

  test('a rejected pair is never proposed again', async () => {
    const customer = (await kernel.project()).project.entities.Customer!;
    const zenith = await new PgEntityStore().create(kernel.pool, customer, { name: 'Zenith Bake House' });
    expect(await kernel.identity.resolve({ plugin: 'claude/tiny-crm', source: 'contact' })).toEqual({ linked: 2, candidates: 1, unmatched: 0, created: 0 });
    const [pending] = await kernel.identity.candidates({ status: 'pending' });
    expect(pending).toMatchObject({ recordId: zenith, externalId: 'c3' });
    expect(await kernel.identity.decide({ candidateId: pending!.id, decision: 'reject', by: manager })).toEqual({ applied: true });
    expect(await kernel.identity.resolve({ plugin: 'claude/tiny-crm' })).toEqual({ linked: 2, candidates: 0, unmatched: 1, created: 0 });
    expect(await kernel.identity.candidates({ status: 'pending' })).toEqual([]);
    expect(await kernel.identity.candidates({ status: 'rejected' })).toEqual([expect.objectContaining({ recordId: zenith, decidedBy: manager.personId })]);
  }, 60_000);

  test('a linked record shows its CRM values, read through the link; fields the CRM owns are read through', async () => {
    const rec = (await kernel.entityRecord('Customer', acme, manager))!;
    expect(rec.values).toMatchObject({ name: 'Acme Traders Pvt Ltd', gstin: '29AAACA1234A1Z5' });
    expect(rec.links).toHaveLength(1);
    expect(rec.links[0]).toMatchObject({ externalId: 'c1', values: { email: 'accounts@acme-traders.example', name: 'Acme Traders Private Limited' } });
    // customer.yaml: `ownership: { email: crm }`, the plugin's namespace.
    expect(rec.readThrough).toEqual({ email: { plugin: 'claude/tiny-crm', value: 'accounts@acme-traders.example' } });
    expect(await kernel.entityRecord('Customer', 'cust_nope', manager)).toBeUndefined();
  }, 60_000);
});
