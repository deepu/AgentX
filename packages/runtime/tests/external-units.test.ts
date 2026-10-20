// Phase 5 helpers without a database: grounding, file types by content, link expiry and tokens,
// and the invite's message text.
import { describe, expect, test } from 'bun:test';
import { foundInText, ground } from '../src/external/ground.ts';
import { sniffType } from '../src/external/form.ts';
import { DEFAULT_EXPIRY_MS, expiryMs, isToken, MAX_EXPIRY_MS, tokenFor } from '../src/external/links.ts';
import { inviteMessage } from '../src/external/messages.ts';
import { deliver } from '../src/external/deliver.ts';
import type { PolicyDoc } from '@memwise/defs';
import type { GatewayDecision, ToolGateway } from '@memwise/gateway';
import { compilePolicy, decide, PLATFORM_DEFAULTS, rateLimitOf, type EffectivePolicy } from '@memwise/policy';

const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0)]);

describe('grounding', () => {
  const PAN = { kind: 'identifier', scheme: 'PAN' } as const;
  test('identifiers ignore case, spaces and punctuation; numbers and money their separators', () => {
    expect(foundInText('AAACA1234A', PAN, 'PAN: aaaca 1234-a')).toBe(true);
    expect(foundInText('AAACA1234B', PAN, 'PAN: AAACA1234A')).toBe(false);
    expect(foundInText({ amount: 4200000, currency: 'INR' }, { kind: 'scalar', name: 'Money' }, 'Turnover ₹ 42,00,000')).toBe(true);
    expect(foundInText(42, { kind: 'scalar', name: 'Number' }, 'item 420')).toBe(false);
    expect(foundInText('2024-03-05', { kind: 'scalar', name: 'Date' }, 'Issued on 5 March 2024')).toBe(true);
    expect(foundInText('Acme Traders', { kind: 'scalar', name: 'Text' }, 'ACME   TRADERS Pvt Ltd')).toBe(true);
  });
  test('a value not in the text is capped at 0.5; a missing confidence counts as 0.5', () => {
    expect(ground('X', 0.99, { kind: 'scalar', name: 'Text' }, 'nothing here')).toEqual({ confidence: 0.5, found: false });
    expect(ground('here', undefined, { kind: 'scalar', name: 'Text' }, 'nothing here')).toEqual({ confidence: 0.5, found: true });
    expect(ground('here', 0.9, { kind: 'scalar', name: 'Text' }, 'nothing here')).toEqual({ confidence: 0.9, found: true });
  });
});

test('file types are read from the content, not the name', () => {
  expect(sniffType(new TextEncoder().encode('%PDF-1.4\n'))).toBe('application/pdf');
  expect(sniffType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
  expect(sniffType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
  expect(sniffType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
  expect(sniffType(new TextEncoder().encode('\0\0\0\x18ftypheic\0\0\0\0'))).toBe('image/heic');
  expect(sniffType(new TextEncoder().encode('PAN AAACA1234A\n'))).toBe('text/plain');
  expect(sniffType(bytes(0x4d, 0x5a, 0x90, 0x00))).toBeUndefined();
});

test('expiry: as asked, else the state\'s timeout, else 7 days; at most 30 days', () => {
  expect(expiryMs(undefined, undefined)).toBe(DEFAULT_EXPIRY_MS);
  expect(expiryMs(undefined, 3 * 86_400_000)).toBe(3 * 86_400_000);
  expect(expiryMs(86_400_000, 3 * 86_400_000)).toBe(86_400_000);
  expect(expiryMs(90 * 86_400_000, undefined)).toBe(MAX_EXPIRY_MS);
});

test('a token is mwl_ and 32 bytes; the same key gives the same link, another key another', () => {
  const key = Buffer.alloc(32, 7);
  const a = tokenFor(key, 'invite:run/1/invite:external.invite');
  expect(isToken(a)).toBe(true);
  expect(tokenFor(key, 'invite:run/1/invite:external.invite')).toBe(a);
  expect(tokenFor(key, 'invite:run/5/invite:external.invite')).not.toBe(a);
  expect(tokenFor(Buffer.alloc(32, 8), 'invite:run/1/invite:external.invite')).not.toBe(a);
});

test('the invite says who asks, what for, the link, until when, and the note', () => {
  const m = inviteMessage('email', 'asha@example.com', {
    business: 'Acme Advisors', name: 'Asha Rao', purpose: 'Client intake', form: 'Client fills in the intake form',
    url: 'https://memwise.example/f/mwl_x', expiresAt: '2026-10-27T00:00:00Z', note: 'Please upload the GST certificate again.',
  });
  expect(m.subject).toBe('Acme Advisors: please fill in a form for client intake');
  for (const part of ['Hello Asha,', 'https://memwise.example/f/mwl_x', '27 October 2026', '"Please upload the GST certificate again."']) expect(m.body).toContain(part);
  const prev = process.env.WHATSAPP_INVITE_TEMPLATE;
  process.env.WHATSAPP_INVITE_TEMPLATE = 'memwise_form_link';
  try {
    const w = inviteMessage('whatsapp', '+919876543210', { business: 'Acme Advisors', name: 'Asha Rao', purpose: 'Client intake', form: 'F', url: 'https://x/f/t', expiresAt: '2026-10-27T00:00:00Z' });
    expect(w.template).toEqual({ name: 'memwise_form_link', language: 'en', params: ['Asha', 'Acme Advisors', 'https://x/f/t'] });
  } finally {
    if (prev === undefined) delete process.env.WHATSAPP_INVITE_TEMPLATE; else process.env.WHATSAPP_INVITE_TEMPLATE = prev;
  }
});

describe('delivery under policy', () => {
  const message = { to: 'asha@example.com', via: 'email' as const, subject: 'Hi', body: 'Hello' };
  const token = {
    runId: 'run_1', caseId: 'case_1', stepId: 'invite', stepRunId: 'run_1/2/invite', workflowId: 'client-intake', workflowVersion: 1,
    agentRole: 'client-intake.invite', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const policyWith = (doc: PolicyDoc) => compilePolicy([PLATFORM_DEFAULTS, { kind: 'domain', name: 'domain', doc }]).effective;

  /** A gateway around one `email.send`, deciding with the real policy rules. */
  function gateway() {
    const calls: GatewayDecision[] = [];
    const def = { name: 'email.send', description: 'send', inputSchema: { type: 'object' }, effect: 'outbound' as const, execute: async () => ({ message_id: 'm1' }) };
    const tools = {
      get: (n: string) => (n === 'email.send' ? def : undefined),
      async check(req: { tool: string }, policy: EffectivePolicy) {
        const out: GatewayDecision = { tool: req.tool, effect: 'outbound', classified: true, decision: decide(policy, { tool: req.tool, effect: 'outbound', classified: true, tainted: false }) };
        const rl = rateLimitOf(policy, req.tool);
        if (rl) out.rateLimit = rl;
        return out;
      },
      async execute(_req: unknown, d: GatewayDecision) {
        calls.push(d);
        return d.decision.verdict === 'deny' ? { status: 'denied', reason: d.decision.reason } : { status: 'ok', result: { message_id: 'm1' }, effect: 'outbound', replayed: false };
      },
    } as unknown as ToolGateway;
    const db = { query: async (sql: string) => ({ rows: sql.startsWith('update') ? [{ id: 'dlv_1', channel: 'email', to: message.to, purpose: 'invite', status: 'sent', at: new Date() }] : [], rowCount: 1 }) };
    return { tools, db, calls };
  }

  test('a channel tool the policy denies is not sent; approve counts as already approved; its rate limit is kept', async () => {
    const denied = gateway();
    await expect(deliver(denied.db as never, denied.tools, { message, idemKey: 'k1', purpose: 'invite', token, policy: policyWith({ tools: { deny: ['email.send'] } }) }))
      .rejects.toThrow(/was not sent/);
    expect(denied.calls[0]!.decision.verdict).toBe('deny');

    const approved = gateway();
    await deliver(approved.db as never, approved.tools, { message, idemKey: 'k2', purpose: 'invite', token, policy: policyWith({ tools: { rules: { 'email.send': { rateLimit: { count: 5, perMs: 60_000 } } } } }) });
    expect(approved.calls[0]).toMatchObject({ decision: { verdict: 'allow' }, rateLimit: { count: 5, perMs: 60_000 } });
  });
});
