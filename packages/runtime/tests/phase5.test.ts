// Phase 5 (docs/memwise/23-phase-5-interfaces.md): external links, the public form, extraction in
// the form, external.invite, inbox notifications with inbox links, and webhooks, through the kernel
// on client intake version 2 against a real Postgres. The invite's crash cases run in a worker
// process that is killed and started again.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PgDefinitionStore, type TestDatabase } from '@memwise/db';
import { indexProject, loadProject, type ExternalForm, type ExtractSuggestion, type StepToken } from '@memwise/defs';
import { scriptedProvider, stubTools, type ToolDefinition } from '@memwise/gateway';
import crypto from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChannelKernelService } from '../src/external/channels.ts';
import { createKernel } from '../src/kernel.ts';
import { sampleTools } from '../src/sample-tools.ts';
import type { Kernel, PersonActor } from '../src/types.ts';
import { SAMPLE_DIR } from './fixtures/exit-setup.ts';
import { kernelDatabase, pgAvailable, runChild, workerResult } from './helpers.ts';

const WORKER = fileURLToPath(new URL('./fixtures/kernel-worker.ts', import.meta.url));
const BASE = 'https://memwise.example';
const TOKEN = /\/f\/(mwl_[A-Za-z0-9_-]{43})/;
const INBOX_TOKEN = /\/i\/(mwl_[A-Za-z0-9_-]{43})/;
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

async function until<T>(what: string, get: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The sample project, plus a tiny playbook whose external step times out in two seconds. */
function testProject(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'mw-p5-')), 'intake');
  cpSync(SAMPLE_DIR, dir, { recursive: true });
  const wf = join(dir, 'workflows', 'quick-form');
  mkdirSync(join(wf, 'steps'), { recursive: true });
  writeFileSync(join(wf, 'workflow.yaml'), `workflow: quick-form
version: 1
title: Quick form
owner: manager
case: ./case.yaml
start: ask
steps:
  ask:
    on: { sent: end }
    wait: { timeout: 2s → end }
`);
  writeFileSync(join(wf, 'case.yaml'), 'case: quick\nfields:\n  note: Text\n');
  writeFileSync(join(wf, 'steps', 'ask.md'), `---
title: Tell us one thing
performer: external
assignee: staff
writes:
  note: { type: Text, from: person }
outcomes: [sent]
---
Write a short note.
`);
  return dir;
}

let db: TestDatabase;
let kernel: Kernel;
let publicUrl: string | undefined = BASE;
let priya: PersonActor; // staff
let ravi: PersonActor; // manager
let finn: PersonActor; // finance only
let extractResult: unknown = { fields: [] };
const extractCalls: { args: unknown; token: StepToken }[] = [];

/** The form's reader: a `read` tool whose result each test sets. */
const extractTool: ToolDefinition = {
  name: 'intake.extract_fields',
  description: 'Read fields from uploaded documents (test double).',
  inputSchema: { type: 'object', additionalProperties: true },
  effect: 'read',
  async execute(args, ctx) {
    extractCalls.push({ args, token: ctx.token });
    return structuredClone(extractResult);
  },
};

const outbox = async (like: string) =>
  (await db.pool.query(`select idempotency_key, "to", subject, body, attempts from mw_sandbox.outbox where idempotency_key like $1 order by idempotency_key`, [like])).rows;
const stepRun = async (runId: string, state: string) => {
  const run = await kernel.waitForRun(runId, { until: (r) => r.state === state || r.status !== 'active', timeoutMs: 30_000 });
  expect(run.state).toBe(state);
  const id = `${runId}/${run.enteredSeq}/${state}`;
  await until(`${id} waiting`, () => kernel.getStepRecord(id), (r) => r?.status === 'waiting');
  return id;
};
const open = (f: unknown) => f as ExternalForm;

describe.skipIf(!pgAvailable)('Phase 5 kernel', () => {
  const savedEnv = process.env.MEMWISE_PUBLIC_URL;

  beforeAll(async () => {
    delete process.env.MEMWISE_PUBLIC_URL;
    db = await kernelDatabase('mw_rt_p5');
    const projectDir = testProject();
    const { project } = await loadProject(projectDir);
    const clean = project.workflows['client-intake']!.examples.find((e) => e.name === 'clean-application')!;
    const sample = sampleTools({ databaseUrl: db.url }).filter((t) => t.name !== 'intake.extract_fields');
    kernel = await createKernel({
      databaseUrl: db.url,
      projectDir,
      tools: [extractTool, ...stubTools(sample, { 'gst.validate_gstin': { valid: true, legal_name: 'Acme Traders Private Limited' } })],
      modelRoles: { checker: { provider: 'scripted', model: 'scripted' }, verifier: { provider: 'scripted', model: 'scripted' } },
      providers: [scriptedProvider(clean.model!)],
      filesDir: mkdtempSync(join(tmpdir(), 'mw-p5-files-')),
      publicUrl: () => publicUrl,
      businessName: 'Acme Advisors',
      logLevel: 'error',
    });
    const diagnostics = await kernel.index();
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const actor = async (name: string, roles: string[]) =>
      kernel.people.actorFor((await kernel.people.create({ name, email: `${name.toLowerCase().split(' ')[0]}@example.com`, roles })).id);
    priya = await actor('Priya Shah', ['staff']);
    ravi = await actor('Ravi Kumar', ['manager']);
    finn = await actor('Finn Olsen', ['finance']);
  }, 120_000);

  afterAll(async () => {
    if (savedEnv === undefined) delete process.env.MEMWISE_PUBLIC_URL; else process.env.MEMWISE_PUBLIC_URL = savedEnv;
    await kernel?.shutdown();
    await db?.drop();
  }, 60_000);

  // ---------------------------------------------------------------- links, the form, extraction

  let caseId = '';
  let runId = '';
  let fillRun = '';
  let early: { token: string; linkId: string };
  let invite: { token: string; linkId: string };
  let panDoc = '';
  let suggestions: ExtractSuggestion[] = [];

  test('a link issued before its step is entered waits for it; only the step\'s roles may issue one', async () => {
    ({ runId, caseId } = await kernel.startRun({ workflowId: 'client-intake', case: {} }));
    await stepRun(runId, 'prepare');
    const issued = await kernel.external.issueLink({ runId, stepId: 'fill', participant: { name: 'Asha Rao', email: 'asha@acme-traders.example' }, by: priya });
    expect(issued.token).toMatch(/^mwl_[A-Za-z0-9_-]{43}$/);
    expect(issued.url).toBe(`${BASE}/f/${issued.token}`);
    expect(issued.link).toMatchObject({ kind: 'step', status: 'open', stepId: 'fill', via: 'copy', createdBy: priya.personId });
    early = { token: issued.token, linkId: issued.link.id };
    // Only the token's sha256 is stored.
    const { rows } = await db.pool.query(`select token_hash, to_jsonb(l)::text as row from mw.external_links l where id = $1`, [early.linkId]);
    expect(rows[0].token_hash).toBe(sha256(issued.token));
    expect(rows[0].row).not.toContain(issued.token);

    expect(await kernel.external.form(early.token)).toMatchObject({ status: 'not_yet' });
    expect(await kernel.external.form('mwl_nope')).toMatchObject({ status: 'unknown' });
    await expect(kernel.external.issueLink({ runId, stepId: 'fill', participant: {}, by: finn })).rejects.toThrow(/staff or manager role/);
    await expect(kernel.external.issueLink({ runId, stepId: 'verify', participant: {}, by: priya })).rejects.toThrow(/outside the business/);
  }, 60_000);

  test('send link: the invite is approved by staff, then emailed once with a link to the form', async () => {
    const prepare = `${runId}/0/prepare`;
    expect(await kernel.submitStep({
      stepRunId: prepare, outcome: 'send_link', by: priya,
      values: { client_name: 'Asha Rao', client_email: 'asha@acme-traders.example', contact_by: 'email' },
    })).toMatchObject({ applied: true });
    const pending = await until('the invite approval', () => kernel.pendingApprovals(), (a) => a.some((x) => x.stepRunId.startsWith(`${runId}/`)));
    const approval = pending.find((x) => x.stepRunId.startsWith(`${runId}/`))!;
    expect(approval.tool).toBe('external.invite');
    // The preview is the exact message, with the link hidden (it doesn't exist yet).
    const detail = approval.preview.detail as { to: string; subject: string; body: string };
    expect(detail).toMatchObject({ to: 'asha@acme-traders.example', subject: 'Acme Advisors: please fill in a form for client intake' });
    expect(detail.body).toContain(`${BASE}/f/mwl_•••`);
    // Staff or a manager may approve it (the playbook's policy); finance may not.
    expect(await kernel.decideApproval({ id: approval.id, status: 'approved', by: finn.personId, at: new Date().toISOString() }, finn)).toMatchObject({ applied: false, status: 'forbidden' });
    expect(await kernel.decideApproval({ id: approval.id, status: 'approved', by: priya.personId, at: new Date().toISOString() }, priya)).toMatchObject({ applied: true });

    fillRun = await stepRun(runId, 'fill');
    const sent = await outbox(`${runId}/%`);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'asha@acme-traders.example', subject: detail.subject, attempts: 1 });
    expect(sent[0].body).toBe(detail.body.replace(`${BASE}/f/mwl_•••`, `${BASE}/f/${TOKEN.exec(sent[0].body)![1]}`));
    const token = TOKEN.exec(sent[0].body)![1]!;
    const links = await kernel.external.links({ caseId });
    const mine = links.find((l) => l.id !== early.linkId)!;
    invite = { token, linkId: mine.id };
    expect(mine).toMatchObject({ status: 'open', via: 'email', createdBy: `step:${runId}/1/invite`, participant: { name: 'Asha Rao', email: 'asha@acme-traders.example' } });
    expect(mine.sentAt).toBeTruthy();
    // The fill state's timeout (7 days) sets the expiry.
    expect(Math.abs(Date.parse(mine.expiresAt) - Date.now() - 7 * 86_400_000)).toBeLessThan(120_000);
    expect(await kernel.channels.deliveries({ caseId })).toEqual([expect.objectContaining({ channel: 'email', purpose: 'invite', status: 'sent', linkId: invite.linkId })]);
    // While the client has an open link, the form is not in the staff inbox.
    expect((await kernel.inbox(priya)).some((i) => i.kind === 'input' && i.caseId === caseId)).toBe(false);
  }, 60_000);

  test('the form shows only the step: its fields, the business, no other case values or ids', async () => {
    const form = open(await kernel.external.form(invite.token, { ip: '203.0.113.9' }));
    expect(form).toMatchObject({
      status: 'open', business: 'Acme Advisors', title: 'Client fills in the intake form', participant: { name: 'Asha Rao' },
      outcomes: [{ id: 'submitted', label: 'Submitted' }], comments: [], suggestions: [],
      extract: { documentsField: 'documents', fields: ['pan', 'gstin', 'client_name'], minConfidence: 0.8 },
      limits: { maxFileBytes: 15 * 1024 * 1024, maxFiles: 20 },
    });
    expect(form.fields.map((f) => [f.name, f.kind])).toEqual([
      ['client_name', 'text'], ['client_email', 'email'], ['pan', 'identifier'], ['gstin', 'identifier'], ['annual_turnover', 'money'], ['documents', 'documents'],
    ]);
    // Defaults from the case for the step's own writes only.
    expect(form.fields.find((f) => f.name === 'client_name')).toMatchObject({ value: 'Asha Rao', source: { kind: 'case' } });
    expect(form.fields.find((f) => f.name === 'pan')).toMatchObject({ upperCase: true, pattern: expect.any(String) });
    const text = JSON.stringify(form);
    for (const secret of [caseId, runId, 'contact_by', 'Priya', priya.personId]) expect(text).not.toContain(secret);
    const { rows } = await db.pool.query(`select first_opened_at, last_opened_at from mw.external_links where id = $1`, [invite.linkId]);
    expect(rows[0].first_opened_at).toBeTruthy();
    // The early link opens the same step run now.
    expect(await kernel.external.form(early.token)).toMatchObject({ status: 'open' });
  }, 30_000);

  test('drafts are kept on the link and come back; only the step\'s fields', async () => {
    const saved = await kernel.external.saveDraft(invite.token, { pan: 'AAACA1234A', gstin_ok: true });
    expect(saved).toMatchObject({ savedAt: expect.any(String) });
    const form = open(await kernel.external.form(invite.token));
    expect(form.draftSavedAt).toBeTruthy();
    expect(form.fields.find((f) => f.name === 'pan')).toMatchObject({ value: 'AAACA1234A', source: { kind: 'draft' } });
    const { rows } = await db.pool.query(`select draft from mw.external_links where id = $1`, [invite.linkId]);
    expect(rows[0].draft).toEqual({ pan: 'AAACA1234A' });
  });

  test('uploads are checked by content and size, and saved as the participant\'s', async () => {
    const bad = await kernel.external.upload(invite.token, { name: 'pan.pdf', mime: 'application/pdf', data: new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0xff, 0xfe]) });
    expect(bad).toMatchObject({ status: 'invalid' });
    const big = await kernel.external.upload(invite.token, { name: 'big.txt', mime: 'text/plain', data: new Uint8Array(15 * 1024 * 1024 + 1).fill(65) });
    expect(big).toMatchObject({ status: 'invalid', message: expect.stringContaining('15 MB') });
    const pdf = await kernel.external.upload(invite.token, { name: '../pan-card.pdf', mime: 'text/plain', data: new TextEncoder().encode('%PDF-1.7\n1 0 obj\n') });
    expect(pdf).toMatchObject({ document: { name: 'pan-card.pdf', mime: 'application/pdf' } });
    const text = 'Income Tax Department\nPermanent Account Number: AAACA 1234 A\nName: ASHA RAO\nGSTIN 29AAACA1234A1Z5\n';
    const up = await kernel.external.upload(invite.token, { name: 'pan-card.txt', mime: 'application/octet-stream', data: new TextEncoder().encode(text) });
    if (!('document' in up)) throw new Error(JSON.stringify(up));
    expect(up.document).toMatchObject({ name: 'pan-card.txt', mime: 'text/plain' });
    panDoc = up.document.id;
    const { rows } = await db.pool.query(`select created_by from mw.files where id = $1`, [panDoc]);
    expect(rows[0].created_by).toBe(`external:${invite.linkId}`);
  }, 30_000);

  test('extraction runs under a component token, is journaled, grounded, and pre-fills only what it found', async () => {
    extractResult = {
      fields: [
        { name: 'pan', value: 'aaaca1234a', document: 'pan-card.txt', confidence: 0.95, quote: 'AAACA 1234 A' },
        { name: 'gstin', value: '29AAACA1234A1Z5', document: 'pan-card.txt' }, // no confidence: 0.5
        { name: 'client_name', value: 'Bogus Person', document: 'pan-card.txt', confidence: 0.99 }, // not in the text
      ],
    };
    const r = await kernel.external.extract(invite.token, { documents: [panDoc] });
    if (!('suggestions' in r)) throw new Error(JSON.stringify(r));
    suggestions = r.suggestions;
    const by = Object.fromEntries(r.suggestions.map((s) => [s.field, s]));
    expect(by.pan).toMatchObject({ value: 'AAACA1234A', confidence: 0.95, found: true, prefill: true, document: 'pan-card.txt', documentId: panDoc, quote: 'AAACA 1234 A' });
    expect(by.gstin).toMatchObject({ value: '29AAACA1234A1Z5', confidence: 0.5, found: true, prefill: false });
    expect(by.client_name).toMatchObject({ value: 'Bogus Person', confidence: 0.5, found: false, prefill: false });
    expect(r.suggestions.every((s) => /^sug_/.test(s.id))).toBe(true);

    const call = extractCalls.at(-1)!;
    expect(call.args).toEqual({ documents: [panDoc], fields: ['pan', 'gstin', 'client_name'] });
    expect(call.token).toMatchObject({ agentRole: 'client-intake.fill.form', onBehalfOf: `external:${invite.linkId}`, stepRunId: fillRun, stepId: 'fill' });
    const journal = await db.pool.query(`select journal_key, kind, name, effect from mw.step_journal where step_run_id = $1 and journal_key like 'form.extract:%'`, [fillRun]);
    expect(journal.rows).toEqual([{ journal_key: 'form.extract:1', kind: 'tool', name: 'intake.extract_fields', effect: 'read' }]);

    // A reload shows them; the made-up name is not filled in.
    const form = open(await kernel.external.form(invite.token));
    expect(form.suggestions.map((s) => s.id).sort()).toEqual(r.suggestions.map((s) => s.id).sort());
    expect(form.fields.find((f) => f.name === 'client_name')?.value).toBe('Asha Rao');
    // The draft's PAN (saved earlier) is what the document says, so it shows, and is sent, as read from it.
    expect(form.fields.find((f) => f.name === 'pan')).toMatchObject({ value: 'AAACA1234A', source: { kind: 'extracted', suggestionId: by.pan!.id, document: 'pan-card.txt' } });
    // Documents not sent through this link can't be read through it.
    const other = await kernel.saveFile({ name: 'other.txt', mime: 'text/plain', data: new TextEncoder().encode('PAN ZZZZZ9999Z') }, { kind: 'system' });
    const none = await kernel.external.extract(invite.token, { documents: [other.id] });
    expect(none).toMatchObject({ suggestions: [], notes: [expect.stringContaining('Upload a document first')] });
  }, 30_000);

  test('a tool that is not `read` is refused for the form', async () => {
    const before = extractCalls.length;
    extractTool.effect = 'outbound';
    try {
      const r = await kernel.external.extract(invite.token, { documents: [panDoc] });
      expect(r).toMatchObject({ suggestions: [], notes: ["Reading documents isn't available for this form; please type the answers in."] });
      expect(extractCalls.length).toBe(before);
    } finally {
      extractTool.effect = 'read';
    }
  });

  test('submitting consumes the link once, records the client as external and tainted, and closes the other link', async () => {
    const invalid = await kernel.external.submit(invite.token, { values: { pan: 'NOT-A-PAN', documents: ['file_nope'] } });
    expect(invalid).toMatchObject({ status: 'invalid', errors: { pan: [expect.any(String)], documents: ['this file was not uploaded with this form'] } });

    const sug = (field: string) => suggestions.find((s) => s.field === field)!;
    const result = await kernel.external.submit(invite.token, {
      values: {
        client_name: 'Asha Rao', client_email: 'asha@acme-traders.example', pan: 'AAACA1234A', gstin: '29AAACA1234A1Z6',
        annual_turnover: { amount: 42000000, currency: 'INR' }, documents: [panDoc],
      },
      sources: { pan: sug('pan').id, gstin: sug('gstin').id }, // gstin was changed after it was suggested
    });
    expect(result).toEqual({ status: 'applied', message: 'Thank you. Your answers were sent to Acme Advisors.' });
    expect(await kernel.external.submit(invite.token, { values: {} })).toMatchObject({ status: 'used' });
    expect(await kernel.external.form(invite.token)).toMatchObject({ status: 'used' });
    expect(await kernel.external.form(early.token)).toMatchObject({ status: 'closed' });

    await kernel.waitForRun(runId, { until: (r) => r.state !== 'fill', timeoutMs: 30_000 });
    const sr = await db.pool.query(`select decided_by, outcome, tainted from mw.step_runs where id = $1`, [fillRun]);
    expect(sr.rows[0]).toEqual({ decided_by: `external:${invite.linkId}`, outcome: 'submitted', tainted: true });
    const values = (await kernel.getCase(caseId))!.values;
    expect(values.pan!.provenance).toMatchObject({
      kind: 'tool', tool: 'intake.extract_fields', callId: 'form.extract:1', stepRunId: fillRun, tainted: true,
      document: 'pan-card.txt', confidence: 0.95, confirmedBy: 'Asha Rao',
    });
    expect(values.gstin!.provenance).toMatchObject({ kind: 'external', by: 'Asha Rao', linkId: invite.linkId, stepRunId: fillRun, tainted: true });
    expect(values.gstin!.value).toBe('29AAACA1234A1Z6');
    expect(values.documents!.value).toEqual([expect.objectContaining({ id: panDoc, name: 'pan-card.txt' })]);
    const tf = await db.pool.query(`select tainted_fields from mw.cases where id = $1`, [caseId]);
    expect(tf.rows[0].tainted_fields).toEqual(expect.arrayContaining(['pan', 'gstin', 'documents']));
    // The name was on the case already and came back unchanged: it keeps where it came from.
    expect(values.client_name!.provenance.kind).not.toBe('external');
    const links = await kernel.external.links({ caseId });
    expect(Object.fromEntries(links.map((l) => [l.id, l.status]))).toEqual({ [invite.linkId]: 'used', [early.linkId]: 'closed' });
  }, 60_000);

  test('the client\'s answers are tainted in the check that reads them', async () => {
    const run = await kernel.waitForRun(runId, { until: (r) => r.state === 'verify' || r.status !== 'active', timeoutMs: 30_000 });
    expect(run.state).toBe('verify');
    const check = await kernel.getStepRecord(`${runId}/${run.enteredSeq - 1}/check`);
    expect(check).toMatchObject({ status: 'completed', outcome: 'checked', tainted: true });
  }, 60_000);

  // ---------------------------------------------------------------- expiry, revocation, the state left

  test('links expire (the step\'s timeout, at most 30 days), can be revoked, and close when the state is left', async () => {
    const started = await kernel.startRun({ workflowId: 'client-intake', case: { client_name: 'Ravi Menon' }, startAt: 'fill' });
    const sr = await stepRun(started.runId, 'fill');
    const long = await kernel.external.issueLink({ runId: started.runId, stepId: 'fill', participant: { name: 'Ravi Menon' }, expiresInMs: 90 * 86_400_000, by: ravi });
    expect(Date.parse(long.link.expiresAt) - Date.now()).toBeLessThanOrEqual(30 * 86_400_000 + 5_000);
    await db.pool.query(`update mw.external_links set expires_at = now() - interval '1 second' where id = $1`, [long.link.id]);
    expect(await kernel.external.form(long.token)).toMatchObject({ status: 'expired' });
    expect(await kernel.external.submit(long.token, { values: {} })).toMatchObject({ status: 'expired' });

    const revoked = await kernel.external.issueLink({ runId: started.runId, stepId: 'fill', participant: {}, by: priya });
    expect(await kernel.external.revoke(revoked.link.id, finn)).toMatchObject({ applied: false });
    expect(await kernel.external.revoke(revoked.link.id, priya)).toEqual({ applied: true });
    expect(await kernel.external.form(revoked.token)).toMatchObject({ status: 'revoked', message: expect.any(String) });
    // No open link: the step is back in the staff inbox, with its extraction.
    const item = (await kernel.inbox(priya)).find((i) => i.kind === 'input' && i.stepRunId === sr);
    expect(item).toMatchObject({ extract: { documentsField: 'documents', fields: ['pan', 'gstin', 'client_name'], minConfidence: 0.8 } });

    // A staff member answering the step closes its open links.
    const open1 = await kernel.external.issueLink({ runId: started.runId, stepId: 'fill', participant: {}, by: priya });
    expect(await kernel.submitStep({ stepRunId: sr, outcome: 'submitted', values: { client_name: 'Ravi Menon' }, by: priya })).toMatchObject({ applied: true });
    expect(await until('the link closed', () => kernel.external.form(open1.token), (f) => f.status === 'closed')).toMatchObject({ status: 'closed' });

    // Leaving the state another way (the timeout) closes them too.
    const quick = await kernel.startRun({ workflowId: 'quick-form', case: {} });
    await stepRun(quick.runId, 'ask');
    const q = await kernel.external.issueLink({ runId: quick.runId, stepId: 'ask', participant: { email: 'x@example.com' }, by: priya });
    expect(await kernel.external.form(q.token)).toMatchObject({ status: 'open' });
    await kernel.waitForRun(quick.runId, { until: (r) => r.status !== 'active', timeoutMs: 30_000 });
    expect(await kernel.external.form(q.token)).toMatchObject({ status: 'closed' });
    const { rows } = await db.pool.query(`select closed_reason from mw.external_links where id = $1`, [q.link.id]);
    expect(rows[0].closed_reason).toBe('left');
  }, 120_000);

  test('extraction is rate limited per link, and staff can run it on the step in the app', async () => {
    const started = await kernel.startRun({ workflowId: 'client-intake', case: {}, startAt: 'fill' });
    const sr = await stepRun(started.runId, 'fill');
    const link = await kernel.external.issueLink({ runId: started.runId, stepId: 'fill', participant: {}, by: priya });
    const doc = await kernel.external.upload(link.token, { name: 'gst.txt', mime: 'text/plain', data: new TextEncoder().encode('GSTIN 29AAACA1234A1Z5') });
    if (!('document' in doc)) throw new Error(JSON.stringify(doc));
    extractResult = { fields: [{ name: 'gstin', value: '29AAACA1234A1Z5', document: 'gst.txt', confidence: 0.9 }] };
    for (let i = 0; i < 10; i++) expect(await kernel.external.extract(link.token, { documents: [doc.document.id] })).toHaveProperty('suggestions');
    expect(await kernel.external.extract(link.token, { documents: [doc.document.id] })).toMatchObject({ status: 'rate_limited' });

    await kernel.external.revoke(link.link.id, priya);
    await expect(kernel.external.extractForStep({ stepRunId: sr, documents: [doc.document.id], by: finn })).rejects.toThrow(/staff role/);
    // A file from somewhere else (another case, another person) is not read, even by its id.
    const elsewhere = await kernel.saveFile({ name: 'other-gst.txt', mime: 'text/plain', data: new TextEncoder().encode('GSTIN 27AAACM1234M1Z2') }, ravi);
    const calls = extractCalls.length;
    expect(await kernel.external.extractForStep({ stepRunId: sr, documents: [elsewhere.id], by: priya })).toMatchObject({ suggestions: [], notes: [expect.stringContaining('Upload a document first')] });
    expect(extractCalls.length).toBe(calls);
    const r = await kernel.external.extractForStep({ stepRunId: sr, documents: [doc.document.id, elsewhere.id], by: priya });
    expect(extractCalls.at(-1)!.args).toMatchObject({ documents: [doc.document.id] });
    const gstin = r.suggestions.find((s) => s.field === 'gstin')!;
    expect(gstin).toMatchObject({ value: '29AAACA1234A1Z5', confidence: 0.9, found: true, prefill: true });
    expect(extractCalls.at(-1)!.token).toMatchObject({ agentRole: 'client-intake.fill.form', onBehalfOf: priya.personId });
    expect(await kernel.submitStep({ stepRunId: sr, outcome: 'submitted', values: { gstin: '29AAACA1234A1Z5' }, sources: { gstin: gstin.id }, by: priya })).toMatchObject({ applied: true });
    await kernel.waitForRun(started.runId, { until: (x) => x.state !== 'fill', timeoutMs: 30_000 });
    const values = (await kernel.getCase(started.caseId))!.values;
    expect(values.gstin!.provenance).toMatchObject({ kind: 'tool', tool: 'intake.extract_fields', confidence: 0.9, document: 'gst.txt', confirmedBy: priya.personId, tainted: true });
  }, 120_000);

  // ---------------------------------------------------------------- no public address

  test('without a public address the invite is not asked about: the case goes to a person', async () => {
    publicUrl = undefined;
    try {
      const started = await kernel.startRun({ workflowId: 'client-intake', startAt: 'invite', case: { client_name: 'Asha Rao', client_email: 'asha@acme-traders.example', contact_by: 'email' } });
      const run = await kernel.waitForRun(started.runId, { until: (r) => r.state !== 'invite' || r.status !== 'active', timeoutMs: 30_000 });
      expect(run).toMatchObject({ state: 'needs_person', status: 'active' });
      const record = await kernel.getStepRecord(`${started.runId}/0/invite`);
      expect(record?.rationale).toContain('connect a public address in Settings → Public address');
      expect((await kernel.pendingApprovals()).some((a) => a.stepRunId.startsWith(`${started.runId}/`))).toBe(false);
      expect(await outbox(`${started.runId}/%`)).toEqual([]);
      // A copied link still works; it just has no address to open it at.
      const copy = await kernel.external.issueLink({ runId: started.runId, stepId: 'fill', participant: {}, by: priya });
      expect(copy.url).toBeUndefined();
    } finally {
      publicUrl = BASE;
    }
  }, 60_000);

  // ---------------------------------------------------------------- inbox notifications and inbox links

  test('people who turned notifications on get one message per item, with a single-use inbox link', async () => {
    expect(await kernel.channels.available()).toMatchObject({ email: { tool: 'email.send' }, whatsapp: undefined });
    await expect(kernel.channels.setNotifySettings(ravi.personId, { email: true }, priya)).rejects.toThrow(/only the person/);
    await expect(kernel.channels.setNotifySettings(ravi.personId, { whatsapp: '12345' }, ravi)).rejects.toThrow(/international form/);
    expect(await kernel.channels.setNotifySettings(ravi.personId, { email: true }, ravi)).toEqual({ email: true });
    expect(await kernel.channels.notifySettings(ravi.personId)).toEqual({ email: true });

    // A decision item for the manager appears: the notifier (on the change feed) sends it.
    const started = await kernel.startRun({ workflowId: 'client-intake', startAt: 'verify', case: { client_name: 'Meera Iyer', gstin: '29AAACA1234A1Z5' } });
    const sr = await stepRun(started.runId, 'verify');
    const deliveries = await until('the notification', () => kernel.channels.deliveries({ personId: ravi.personId }),
      (d) => d.some((x) => x.itemId === `step:${sr}`), 15_000);
    expect(deliveries.filter((x) => x.itemId === `step:${sr}`)).toEqual([expect.objectContaining({ channel: 'email', purpose: 'notification', status: 'sent', to: 'ravi@example.com' })]);
    // Once per item and channel, however often the notifier looks.
    await (kernel.channels as ChannelKernelService).notifyNow();
    expect((await kernel.channels.deliveries({ personId: ravi.personId })).filter((x) => x.itemId === `step:${sr}`)).toHaveLength(1);
    // A send that failed is tried again on a later sweep (here the ledger has it, so it is not sent twice).
    const key = `notify:${ravi.personId}:step:${sr}:email`;
    const fail = () => db.pool.query(`update mw.deliveries set status = 'failed', updated_at = now() - interval '10 minutes' where idem_key = $1`, [key]);
    const statusOf = async () => (await db.pool.query(`select status from mw.deliveries where idem_key = $1`, [key])).rows[0].status;
    await fail();
    await (kernel.channels as ChannelKernelService).notifyNow();
    expect(await statusOf()).toBe('sent');
    const mail = (await outbox(`notify:${ravi.personId}:step:${sr}:email`))[0];
    expect(mail.subject).toBe('Waiting for you: Manager approves onboarding (Client intake for Meera Iyer)');
    const token = INBOX_TOKEN.exec(mail.body)![1]!;

    const item = await kernel.external.inboxItem(token);
    expect(item).toMatchObject({
      status: 'open', kind: 'decision', business: 'Acme Advisors', person: 'Ravi', title: 'Manager approves onboarding', caseTitle: 'Client intake for Meera Iyer',
      outcomes: [{ id: 'approved', label: 'Approved' }, { id: 'sent_back', label: 'Sent back', comment: 'required' }],
    });
    expect((item as { fields: { label: string; value: string }[] }).fields).toEqual(expect.arrayContaining([{ label: 'Client name', value: 'Meera Iyer' }]));
    const decided = await kernel.external.decideInboxItem(token, { outcome: 'approved' });
    expect(decided).toMatchObject({ status: 'applied', message: expect.stringContaining('recorded as you (via email link)') });
    expect(await kernel.external.decideInboxItem(token, { outcome: 'approved' })).toMatchObject({ status: 'used' });
    // Its link is used now: a failed row for it is not sent again.
    await fail();
    await (kernel.channels as ChannelKernelService).notifyNow();
    expect(await statusOf()).toBe('failed');
    await kernel.waitForRun(started.runId, { until: (r) => r.state !== 'verify', timeoutMs: 30_000 });
    const row = await db.pool.query(`select decided_by, decided_via, outcome from mw.step_runs where id = $1`, [sr]);
    expect(row.rows[0]).toEqual({ decided_by: ravi.personId, decided_via: 'email', outcome: 'approved' });
  }, 90_000);

  test('an approval decided through an inbox link is the person\'s; a role lost since is refused', async () => {
    expect(await kernel.channels.setNotifySettings(priya.personId, { email: true }, priya)).toEqual({ email: true });
    const started = await kernel.startRun({ workflowId: 'client-intake', startAt: 'invite', case: { client_name: 'Kiran Rao', client_email: 'kiran@example.com', contact_by: 'email' } });
    const approval = (await until('the invite approval', () => kernel.pendingApprovals(), (a) => a.some((x) => x.stepRunId.startsWith(`${started.runId}/`))))
      .find((x) => x.stepRunId.startsWith(`${started.runId}/`))!;
    const itemId = `approval:${approval.id}`;
    await until('both notified', () => kernel.channels.deliveries({ limit: 500 }),
      (d) => [priya.personId, ravi.personId].every((p) => d.some((x) => x.itemId === itemId && x.personId === p)), 15_000);
    const tokenOf = async (personId: string) => INBOX_TOKEN.exec((await outbox(`notify:${personId}:${itemId}:email`))[0].body)![1]!;
    const staffToken = await tokenOf(priya.personId);
    const managerToken = await tokenOf(ravi.personId);

    const item = await kernel.external.inboxItem(staffToken);
    expect(item).toMatchObject({
      status: 'open', kind: 'approval', person: 'Priya',
      preview: { to: 'kiran@example.com', subject: 'Acme Advisors: please fill in a form for client intake', body: expect.stringContaining('/f/mwl_•••') },
    });
    expect(await kernel.external.decideInboxItem(staffToken, { outcome: 'maybe' })).toMatchObject({ status: 'invalid' });
    expect(await kernel.external.decideInboxItem(staffToken, { outcome: 'approved' })).toMatchObject({ status: 'applied' });
    const a = await db.pool.query(`select status, decided_by, decided_via from mw.approvals where id = $1`, [approval.id]);
    expect(a.rows[0]).toEqual({ status: 'approved', decided_by: priya.personId, decided_via: 'email' });
    await kernel.waitForRun(started.runId, { until: (r) => r.state === 'fill', timeoutMs: 30_000 });
    // The manager's link to the same approval: already dealt with.
    expect(await kernel.external.inboxItem(managerToken)).toMatchObject({ status: 'closed' });

    // A second verify item; the manager loses the role before deciding it.
    const second = await kernel.startRun({ workflowId: 'client-intake', startAt: 'verify', case: { client_name: 'Dev Patel' } });
    const sr = await stepRun(second.runId, 'verify');
    await until('the notification', () => kernel.channels.deliveries({ personId: ravi.personId }), (d) => d.some((x) => x.itemId === `step:${sr}`), 15_000);
    const token = INBOX_TOKEN.exec((await outbox(`notify:${ravi.personId}:step:${sr}:email`))[0].body)![1]!;
    await kernel.people.setRoles(ravi.personId, ['staff']);
    try {
      expect(await kernel.external.decideInboxItem(token, { outcome: 'approved' })).toMatchObject({ status: 'forbidden' });
      expect((await kernel.getStepRecord(sr))?.status).toBe('waiting');
    } finally {
      await kernel.people.setRoles(ravi.personId, ['manager']);
    }
    // An input item needs typed values: its link page opens it in the app instead.
    const third = await kernel.startRun({ workflowId: 'client-intake', startAt: 'fill', case: {} });
    const fill = await stepRun(third.runId, 'fill');
    await until('the input notification', () => kernel.channels.deliveries({ personId: priya.personId }), (d) => d.some((x) => x.itemId === `step:${fill}`), 15_000);
    const inputToken = INBOX_TOKEN.exec((await outbox(`notify:${priya.personId}:step:${fill}:email`))[0].body)![1]!;
    expect(await kernel.external.inboxItem(inputToken)).toMatchObject({ status: 'open', kind: 'input', openInApp: `memwise://inbox/item/${encodeURIComponent(`step:${fill}`)}` });
    expect(await kernel.external.decideInboxItem(inputToken, { outcome: 'submitted' })).toMatchObject({ status: 'invalid' });

    // Turned off: nothing more is sent.
    await kernel.channels.setNotifySettings(ravi.personId, {}, ravi);
    await kernel.channels.setNotifySettings(priya.personId, {}, priya);
    expect(await kernel.channels.notifySettings(ravi.personId)).toEqual({});
  }, 120_000);

  // ---------------------------------------------------------------- webhooks

  test('webhooks: signed requests are verified and kept; WhatsApp statuses update deliveries', async () => {
    const seen: string[] = [];
    const stop = kernel.channels.onInbound((e) => seen.push(e.id));
    const { hook, secret } = await kernel.channels.createWebhook({ purpose: 'test events', scheme: 'hmac-sha256' }, priya);
    expect(hook).toMatchObject({ purpose: 'test events', scheme: 'hmac-sha256', url: `${BASE}/h/${hook.id}` });
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const { rows } = await db.pool.query(`select secret_hash, secret_enc from mw.webhooks where id = $1`, [hook.id]);
    expect(rows[0].secret_hash).toBe(sha256(secret));
    expect(rows[0].secret_enc).not.toContain(secret);

    const body = new TextEncoder().encode(JSON.stringify({ hello: 'world' }));
    const sig = (s: string, b: Uint8Array) => `sha256=${crypto.createHmac('sha256', s).update(b).digest('hex')}`;
    const good = await kernel.channels.receiveWebhook(hook.id, { method: 'POST', query: {}, headers: { 'X-MemWise-Signature': sig(secret, body), Cookie: 'x=1' }, body });
    expect(good.status).toBe(200);
    const bad = await kernel.channels.receiveWebhook(hook.id, { method: 'POST', query: {}, headers: { 'x-memwise-signature': sig('wrong', body) }, body });
    expect(bad.status).toBe(401);
    expect((await kernel.channels.receiveWebhook('hk_nope', { method: 'POST', query: {}, headers: {}, body })).status).toBe(404);
    const events = await kernel.channels.inbound({ hookId: hook.id });
    // Only the signed one is kept.
    expect(events.map((e) => e.verified)).toEqual([true]);
    expect(events[0]).toMatchObject({ body: { hello: 'world' } });
    expect(events[0]!.headers.cookie).toBeUndefined();
    expect(seen).toEqual([events[0]!.id]);
    stop();

    // Meta (WhatsApp): the GET handshake, and delivery statuses.
    const meta = await kernel.channels.createWebhook({ purpose: 'whatsapp', scheme: 'meta', secret: 'app-secret', verifyToken: 'vt-123' }, priya);
    expect(await kernel.channels.receiveWebhook(meta.hook.id, { method: 'GET', query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'vt-123', 'hub.challenge': '4242' }, headers: {}, body: new Uint8Array() }))
      .toEqual({ status: 200, body: '4242', contentType: 'text/plain' });
    expect((await kernel.channels.receiveWebhook(meta.hook.id, { method: 'GET', query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' }, headers: {}, body: new Uint8Array() })).status).toBe(403);
    await db.pool.query(
      `insert into mw.deliveries (id, idem_key, channel, tool, "to", purpose, status, provider_id) values ('dlv_wa', 'wa:1', 'whatsapp', 'whatsapp.send', '+919876543210', 'invite', 'sent', 'wamid.ABC')`);
    const status = (s: string) => new TextEncoder().encode(JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.ABC', status: s }] } }] }] }));
    for (const s of ['delivered', 'read', 'sent']) {
      const b = status(s);
      expect((await kernel.channels.receiveWebhook(meta.hook.id, { method: 'POST', query: {}, headers: { 'x-hub-signature-256': sig('app-secret', b) }, body: b })).status).toBe(200);
    }
    const d = await db.pool.query(`select status from mw.deliveries where id = 'dlv_wa'`);
    expect(d.rows[0].status).toBe('read'); // a late "sent" never replaces "read"
    expect((await kernel.channels.webhooks()).map((w) => w.id)).toEqual([hook.id, meta.hook.id]);
  }, 30_000);
});

// ---------------------------------------------------------------- the invite across crashes

const CRASHES = [
  { name: 'no crash' },
  { name: 'waiting for the approval (approved after restart)', crash: 'waiting-approval@external.invite' },
  { name: 'after the email went out, before its ledger', crash: 'after-tool-effect@email.send', retried: true },
  { name: 'after the email\'s ledger, before the invite finished', crash: 'after-ledger-complete@email.send' },
  { name: 'after the invite, before its ledger', crash: 'after-tool-effect@external.invite' },
  { name: 'after the invite\'s ledger', crash: 'after-ledger-complete@external.invite' },
];

describe.skipIf(!pgAvailable)('external.invite, killed mid-step', () => {
  let cdb: TestDatabase;
  const files = mkdtempSync(join(tmpdir(), 'mw-p5-crash-files-'));
  beforeAll(async () => {
    cdb = await kernelDatabase('mw_rt_p5_crash');
    const { project } = await loadProject(SAMPLE_DIR);
    await indexProject(project, new PgDefinitionStore(cdb.pool));
  }, 60_000);
  afterAll(async () => { await cdb?.drop(); });

  CRASHES.forEach((c, i) => {
    test(c.name, async () => {
      const runId = `run_invite_${i}`;
      const args = ['invite', cdb.url, runId, files];
      if (c.crash) {
        const crashed = await runChild(WORKER, args, { MEMWISE_CRASH_AT: c.crash });
        expect(crashed.signal, crashed.output).toBe('SIGKILL');
        expect(crashed.output).toContain(`MEMWISE_CRASH_AT=${c.crash}`);
      }
      const resumed = await runChild(WORKER, args, {});
      expect(resumed.code, resumed.output).toBe(0);
      expect(workerResult(resumed.output)).toMatchObject({ state: 'fill', status: 'active' });

      const q = async (sql: string) => (await cdb.pool.query(sql, [runId])).rows;
      const mail = await q(`select "to", attempts, body from mw_sandbox.outbox where idempotency_key like $1 || '/%'`);
      expect(mail).toHaveLength(1);
      expect(mail[0]).toMatchObject({ to: 'asha@acme-traders.example', attempts: c.retried ? 2 : 1 });
      const links = await q(`select id, token_hash, sent_at from mw.external_links where run_id = $1`);
      expect(links).toHaveLength(1);
      // The link in the email is the one link of the run.
      expect(sha256(TOKEN.exec(mail[0].body)![1]!)).toBe(links[0].token_hash);
      expect(links[0].sent_at).toBeTruthy();
      expect(await q(`select status from mw.deliveries where link_id in (select id from mw.external_links where run_id = $1)`)).toEqual([{ status: 'sent' }]);
      expect(await q(`select tool, status from mw.effects where step_run_id like $1 || '/%' order by tool`))
        .toEqual([{ tool: 'email.send', status: 'done' }, { tool: 'external.invite', status: 'done' }]);
      expect(await q(`select from_state, to_state from mw.transitions where run_id = $1 order by seq`)).toEqual([{ from_state: 'invite', to_state: 'fill' }]);
    }, 120_000);
  });
});
