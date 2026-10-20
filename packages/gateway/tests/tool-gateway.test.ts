import { describe, expect, test } from 'bun:test';
import { createToolGateway, stubTools, type GatewayDecision, type SecretProvider, type ToolDefinition } from '../src/index.ts';
import { call, MemoryLedger, policy, token } from './helpers.ts';

/** A tool that counts how often its effect really ran. */
function tool(name: string, over: Partial<ToolDefinition> = {}): ToolDefinition & { runs: number } {
  const t = {
    name,
    description: name,
    inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
    runs: 0,
    async execute(args: { to: string }) { t.runs++; return { sent: true, to: args.to }; },
    ...over,
  };
  return t;
}

const allow = (tool: string, effect: GatewayDecision['effect'] = 'outbound'): GatewayDecision => ({
  tool, effect, classified: true, decision: { verdict: 'allow', reason: 'test', origins: [] },
});

describe('check', () => {
  const lookup = tool('crm.lookup', { effect: 'read' });
  const send = tool('mail.send', { effect: 'outbound', preview: (a: { to: string }) => ({ summary: `email to ${a.to}` }) });
  const post = tool('http.post', { effect: 'write' });
  const legacy = tool('legacy.do');
  const gw = createToolGateway({ tools: [lookup, send, post, legacy], ledger: new MemoryLedger() });

  test('unknown tool is denied with a clear reason', async () => {
    const d = await gw.check({ tool: 'nope.x', args: {}, token }, policy(), { tainted: false });
    expect(d.decision.verdict).toBe('deny');
    expect(d.decision.reason).toContain('unknown tool "nope.x"');
    expect(d.decision.reason).toContain('crm.lookup');
  });

  test('read is allowed without a preview', async () => {
    const d = await gw.check({ tool: 'crm.lookup', args: {}, token }, policy(), { tainted: false });
    expect(d).toMatchObject({ effect: 'read', classified: true, decision: { verdict: 'allow' } });
    expect(d.preview).toBeUndefined();
  });

  test('outbound needs approval and carries the tool preview', async () => {
    const d = await gw.check({ tool: 'mail.send', args: { to: 'a@b.test' }, token }, policy(), { tainted: false });
    expect(d.decision.verdict).toBe('approve');
    expect(d.preview).toEqual({ summary: 'email to a@b.test' });
  });

  test('preview verdict without a tool preview gets the generic one', async () => {
    const d = await gw.check({ tool: 'http.post', args: { to: 'x' }, token }, policy({ effects: { write: 'preview' } }), { tainted: false });
    expect(d.decision.verdict).toBe('preview');
    expect(d.preview).toEqual({ summary: 'http.post with {"to":"x"}', detail: { to: 'x' } });
  });

  test('unclassified tool is treated as irreversible', async () => {
    const d = await gw.check({ tool: 'legacy.do', args: {}, token }, policy({ effects: { outbound: 'allow' } }), { tainted: false });
    expect(d).toMatchObject({ effect: 'irreversible', classified: false, decision: { verdict: 'approve' } });
    expect(d.decision.reason).toContain('unclassified');
  });

  test('denied by policy, and tainted sessions tighten outbound', async () => {
    expect((await gw.check({ tool: 'crm.lookup', args: {}, token }, policy({ denied: ['crm.lookup'] }), { tainted: false })).decision.verdict).toBe('deny');
    const loose = policy({ effects: { outbound: 'allow' } });
    expect((await gw.check({ tool: 'mail.send', args: { to: 'x' }, token }, loose, { tainted: false })).decision.verdict).toBe('allow');
    expect((await gw.check({ tool: 'mail.send', args: { to: 'x' }, token }, loose, { tainted: true })).decision.verdict).toBe('approve');
  });

  test('bound() lists declared classes, unclassified as undefined', () => {
    expect(gw.bound()).toEqual({ 'crm.lookup': { effect: 'read' }, 'mail.send': { effect: 'outbound' }, 'http.post': { effect: 'write' }, 'legacy.do': { effect: undefined } });
  });
});

describe('execute and the ledger', () => {
  test('deny refuses without running', async () => {
    const send = tool('mail.send', { effect: 'outbound' });
    const gw = createToolGateway({ tools: [send], ledger: new MemoryLedger() });
    const r = await gw.execute(call('mail.send', { to: 'x' }), { ...allow('mail.send'), decision: { verdict: 'deny', reason: 'no', origins: [] } });
    expect(r).toEqual({ status: 'denied', reason: 'no' });
    expect(send.runs).toBe(0);
  });

  test('new key: runs once and completes; the same key again replays without running', async () => {
    const send = tool('mail.send', { effect: 'outbound' });
    const ledger = new MemoryLedger();
    const gw = createToolGateway({ tools: [send], ledger });
    const first = await gw.execute(call('mail.send', { to: 'x' }), allow('mail.send'));
    expect(first).toEqual({ status: 'ok', result: { sent: true, to: 'x' }, effect: 'outbound', replayed: false });
    const again = await gw.execute(call('mail.send', { to: 'x' }), allow('mail.send'));
    expect(again).toEqual({ status: 'ok', result: { sent: true, to: 'x' }, effect: 'outbound', replayed: true });
    expect(send.runs).toBe(1);
    expect(ledger.log).toEqual(['begin run_1/1/check:mail.send:1 mail.send', 'complete run_1/1/check:mail.send:1', 'begin run_1/1/check:mail.send:1 mail.send']);
  });

  test('pending key on a non-idempotent tool: unknown, not repeated', async () => {
    const send = tool('mail.send', { effect: 'outbound' });
    const ledger = new MemoryLedger();
    ledger.rows.set('k', { status: 'pending', startedAt: '2026-01-01T00:00:00.000Z' });
    const r = await createToolGateway({ tools: [send], ledger }).execute(call('mail.send', { to: 'x' }, 'k'), allow('mail.send'));
    expect(r.status).toBe('unknown');
    expect(send.runs).toBe(0);
  });

  test('pending key on an idempotent tool: runs again with the same key', async () => {
    const keys: string[] = [];
    const send = tool('mail.send', { effect: 'outbound', idempotent: true, async execute(_a, ctx) { keys.push(ctx.idempotencyKey); return 'ok'; } });
    const ledger = new MemoryLedger();
    ledger.rows.set('k', { status: 'pending', startedAt: '2026-01-01T00:00:00.000Z' });
    const r = await createToolGateway({ tools: [send], ledger }).execute(call('mail.send', { to: 'x' }, 'k'), allow('mail.send'));
    expect(r).toMatchObject({ status: 'ok', result: 'ok', replayed: false });
    expect(keys).toEqual(['k']);
    expect(ledger.rows.get('k')).toEqual({ status: 'done', result: 'ok' });
  });

  test('failed key runs again', async () => {
    const send = tool('mail.send', { effect: 'outbound' });
    const ledger = new MemoryLedger();
    ledger.rows.set('k', { status: 'failed', error: 'boom' });
    const r = await createToolGateway({ tools: [send], ledger }).execute(call('mail.send', { to: 'x' }, 'k'), allow('mail.send'));
    expect(r.status).toBe('ok');
    expect(send.runs).toBe(1);
  });

  test('tool exception: status error and ledger.fail', async () => {
    const send = tool('mail.send', { effect: 'outbound', async execute() { throw new Error('smtp down'); } });
    const ledger = new MemoryLedger();
    const r = await createToolGateway({ tools: [send], ledger }).execute(call('mail.send', { to: 'x' }, 'k'), allow('mail.send'));
    expect(r).toEqual({ status: 'error', error: 'smtp down' });
    expect(ledger.rows.get('k')).toEqual({ status: 'failed', error: 'smtp down' });
  });

  test('reads skip the ledger; draft goes through it', async () => {
    const lookup = tool('crm.lookup', { effect: 'read' });
    const draft = tool('mail.draft', { effect: 'draft' });
    const ledger = new MemoryLedger();
    const gw = createToolGateway({ tools: [lookup, draft], ledger });
    await gw.execute(call('crm.lookup', { to: 'x' }), allow('crm.lookup', 'read'));
    expect(ledger.log).toEqual([]);
    await gw.execute(call('mail.draft', { to: 'x' }), allow('mail.draft', 'draft'));
    expect(ledger.log).toHaveLength(2);
  });

  test('invalid arguments: a readable error, nothing runs, no ledger row', async () => {
    const send = tool('mail.send', { effect: 'outbound' });
    const ledger = new MemoryLedger();
    const r = await createToolGateway({ tools: [send], ledger }).execute(call('mail.send', { to: 5 }), allow('mail.send'));
    expect(r).toEqual({ status: 'error', error: 'invalid arguments for mail.send: "to" must be string (got number)' });
    expect(send.runs).toBe(0);
    expect(ledger.log).toEqual([]);
  });
});

describe('secrets', () => {
  const secrets: SecretProvider = { async get(name) { return name === 'SMTP_KEY' ? 'sk-live-999' : undefined; } };

  test('injected into ctx.secrets and redacted from the result', async () => {
    let seen: Record<string, string> = {};
    const send = tool('mail.send', {
      effect: 'outbound', secrets: ['SMTP_KEY'],
      async execute(_a, ctx) { seen = ctx.secrets; return { debug: `auth=${ctx.secrets.SMTP_KEY}`, ok: true }; },
    });
    const ledger = new MemoryLedger();
    const r = await createToolGateway({ tools: [send], ledger, secrets }).execute(call('mail.send', { to: 'x' }, 'k'), allow('mail.send'));
    expect(seen).toEqual({ SMTP_KEY: 'sk-live-999' });
    expect(r).toMatchObject({ status: 'ok', result: { debug: 'auth=[secret]', ok: true } });
    expect(JSON.stringify(ledger.rows.get('k'))).not.toContain('sk-live-999');
  });

  test('redacted from errors too', async () => {
    const send = tool('mail.send', { effect: 'read', secrets: ['SMTP_KEY'], async execute(_a, ctx) { throw new Error(`401 for key ${ctx.secrets.SMTP_KEY}`); } });
    const r = await createToolGateway({ tools: [send], ledger: new MemoryLedger(), secrets }).execute(call('mail.send', { to: 'x' }), allow('mail.send', 'read'));
    expect(r).toEqual({ status: 'error', error: '401 for key [secret]' });
  });

  test('a missing secret is an error and the tool does not run', async () => {
    const send = tool('mail.send', { effect: 'outbound', secrets: ['OTHER'] });
    const ledger = new MemoryLedger();
    const r = await createToolGateway({ tools: [send], ledger, secrets }).execute(call('mail.send', { to: 'x' }, 'k'), allow('mail.send'));
    expect(r).toEqual({ status: 'error', error: 'secret "OTHER" is not configured for mail.send' });
    expect(send.runs).toBe(0);
    expect(ledger.rows.get('k')?.status).toBe('failed');
  });
});

describe('stubTools', () => {
  test('keeps the definition, replaces execution, counts calls per tool', async () => {
    const send = tool('mail.send', { effect: 'outbound', idempotent: true, preview: () => ({ summary: 'p' }) });
    const gst = tool('gst.validate', { effect: 'read' });
    const other = tool('crm.lookup', { effect: 'read' });
    const stubbed = stubTools([send, gst, other], { 'mail.send': { id: 'm1' }, 'gst.validate': { results: [{ valid: true }, { valid: false }] } });

    const s = stubbed.find((t) => t.name === 'mail.send')!;
    expect(s).toMatchObject({ name: 'mail.send', effect: 'outbound', idempotent: true, inputSchema: send.inputSchema });
    expect(s.preview!({})).toEqual({ summary: 'p' });
    expect(stubbed.find((t) => t.name === 'crm.lookup')).toBe(other);

    const gw = createToolGateway({ tools: stubbed, ledger: new MemoryLedger() });
    const r1 = await gw.execute(call('gst.validate', { to: 'a' }), allow('gst.validate', 'read'));
    const r2 = await gw.execute(call('gst.validate', { to: 'a' }), allow('gst.validate', 'read'));
    const r3 = await gw.execute(call('gst.validate', { to: 'a' }), allow('gst.validate', 'read'));
    expect([r1, r2]).toMatchObject([{ result: { valid: true } }, { result: { valid: false } }]);
    expect(r3).toMatchObject({ status: 'error' });
    await gw.execute(call('mail.send', { to: 'a' }, 'k1'), allow('mail.send'));
    await gw.execute(call('mail.send', { to: 'a' }, 'k1'), allow('mail.send')); // replayed from the ledger
    await gw.execute(call('mail.send', { to: 'a' }, 'k2'), allow('mail.send'));
    expect(stubbed.calls).toEqual({ 'mail.send': 2, 'gst.validate': 3 });
    expect(send.runs + gst.runs).toBe(0);
  });

  test('each stubTools call has its own counters', async () => {
    const stub = { 'gst.validate': { results: [1] } };
    const a = stubTools([tool('gst.validate', { effect: 'read' })], stub);
    const b = stubTools([tool('gst.validate', { effect: 'read' })], stub);
    const ctx = { idempotencyKey: 'k', token, secrets: {} };
    expect(await a[0]!.execute({}, ctx)).toBe(1);
    expect(await b[0]!.execute({}, ctx)).toBe(1);
  });
});
