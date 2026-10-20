import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { TestDatabase } from '@memwise/db';
import type { ToolContext } from '@memwise/gateway';
import { sampleTools } from '../src/sample-tools.ts';
import { kernelDatabase } from './helpers.ts';

let db: TestDatabase;
beforeAll(async () => { db = await kernelDatabase('mw_rt_tools'); });
afterAll(async () => { await db?.drop(); });

const ctx = (key: string) => ({ idempotencyKey: key, secrets: {} }) as unknown as ToolContext;
const byName = () => Object.fromEntries(sampleTools({ pool: db.pool }).map((t) => [t.name, t]));

test('gst.validate_gstin checks the format and looks up the legal name', async () => {
  const gst = byName()['gst.validate_gstin']!;
  expect(gst.effect).toBe('read');
  expect(await gst.execute({ gstin: '27AAACM1234M1Z2' }, ctx('k'))).toEqual({ gstin: '27AAACM1234M1Z2', valid: true, legal_name: 'Menon Exports LLP' });
  expect(await gst.execute({ gstin: '27AAACM1234M1Z9X' }, ctx('k'))).toMatchObject({ valid: false, legal_name: null });
});

test('intake.extract_fields is a quarantined read', async () => {
  const ex = byName()['intake.extract_fields']!;
  expect(ex.quarantine).toBe(true);
  expect(await ex.execute({ documents: ['pan-card.pdf'] }, ctx('k'))).toEqual({ fields: [{ name: 'pan', value: 'AAACM1234M', document: 'pan-card.pdf' }] });
});

test('email.send previews, and a retry with the same key does not send twice', async () => {
  const email = byName()['email.send']!;
  const args = { to: 'a@b.example', subject: 'Hi', body: 'Hello' };
  expect(email).toMatchObject({ effect: 'outbound', idempotent: true });
  expect(await email.preview!(args)).toEqual({ summary: 'Email to a@b.example: Hi', detail: args });
  expect(await email.execute(args, ctx('step/1:5'))).toEqual({ message_id: 'sandbox:step/1:5', attempts: 1 });
  expect(await email.execute(args, ctx('step/1:5'))).toEqual({ message_id: 'sandbox:step/1:5', attempts: 2 });
  const { rows } = await db.pool.query(`select count(*)::int as n from mw_sandbox.outbox where idempotency_key = 'step/1:5'`);
  expect(rows[0].n).toBe(1);
});

test('crm.create_customer is an idempotent write', async () => {
  const crm = byName()['crm.create_customer']!;
  expect(crm.effect).toBe('write');
  const a = await crm.execute({ name: 'Acme' }, ctx('k1'));
  expect(await crm.execute({ name: 'Acme' }, ctx('k1'))).toEqual(a);
});
