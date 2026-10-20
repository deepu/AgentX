import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import {
  BudgetExceededError, createModelGateway, scriptedProvider, SCRIPTED_TOKENS_PER_CALL,
  type ModelCallSink, type ModelProvider, type ModelRequest,
} from '../src/index.ts';

const request = (messages: Message[] = [{ role: 'user', content: 'go', timestamp: 1 }]): ModelRequest => ({
  systemPrompt: 'You check intake.', messages, tools: [{ name: 'gst__validate', description: 'v', parameters: { type: 'object' } }],
});

const script = {
  checker: [
    { text: 'Checking.', toolCalls: [{ name: 'gst.validate', args: { gstin: '27AAA' } }, { name: 'crm.lookup', args: { id: 1 } }] },
    { text: 'Done.' },
  ],
};

const opts = { role: 'checker', sessionId: 's1' };

function failing(id: string, how: 'throw' | 'error'): ModelProvider & { calls: number } {
  const p = {
    id, calls: 0,
    async complete(model: string): Promise<AssistantMessage> {
      p.calls++;
      if (how === 'throw') throw new Error(`${id} is down`);
      return {
        role: 'assistant', content: [], api: 'anthropic-messages', provider: id, model, timestamp: 0, stopReason: 'error', errorMessage: 'overloaded',
        usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
      };
    },
  };
  return p;
}

describe('scriptedProvider', () => {
  test('replies by turn with mapped tool names and deterministic ids', async () => {
    const p = scriptedProvider(script);
    const m = await p.complete('fake-model', request(), opts);
    expect(m.stopReason).toBe('toolUse');
    expect(m.provider).toBe('scripted');
    expect(m.model).toBe('fake-model');
    expect(m.usage.totalTokens).toBe(SCRIPTED_TOKENS_PER_CALL);
    expect(m.content).toEqual([
      { type: 'text', text: 'Checking.' },
      { type: 'toolCall', id: 'call_checker_0_0', name: 'gst__validate', arguments: { gstin: '27AAA' } },
      { type: 'toolCall', id: 'call_checker_0_1', name: 'crm__lookup', arguments: { id: 1 } },
    ]);
    const second = await p.complete('fake-model', request([...request().messages, m]), opts);
    expect(second).toMatchObject({ stopReason: 'stop', content: [{ type: 'text', text: 'Done.' }] });
  });

  test('same request, same reply (no hidden counter)', async () => {
    const calls: string[] = [];
    const p = scriptedProvider(script, { onCall: (role, turn) => calls.push(`${role}:${turn}`) });
    const a = await p.complete('m', request(), opts);
    const b = await p.complete('m', request(), opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(calls).toEqual(['checker:0', 'checker:0']);
  });

  test('out of script is an error message', async () => {
    const m = await scriptedProvider(script).complete('m', request(), { role: 'extractor', sessionId: 's' });
    expect(m).toMatchObject({ stopReason: 'error', errorMessage: 'script exhausted for role extractor (turn 0)' });
  });
});

describe('createModelGateway', () => {
  test('unknown role throws a clear error', async () => {
    const gw = createModelGateway({ roles: { checker: { provider: 'scripted', model: 'm' } }, providers: [scriptedProvider(script)] });
    await expect(gw.call(request(), { role: 'writer', sessionId: 's' })).rejects.toThrow('unknown model role "writer"; configured roles: checker');
  });

  test('picks the role\'s provider and model, returns usage and reports to the sink', async () => {
    const records: Parameters<ModelCallSink['record']>[0][] = [];
    const gw = createModelGateway({
      roles: { checker: { provider: 'scripted', model: 'claude-x', maxTokens: 512 } },
      providers: [scriptedProvider(script)],
      sink: { record: (e) => { records.push(e); } },
    });
    expect(gw.roles()).toEqual({ checker: { provider: 'scripted', model: 'claude-x', maxTokens: 512 } });
    const r = await gw.call(request(), opts);
    expect(r).toMatchObject({ provider: 'scripted', model: 'claude-x', usage: { totalTokens: 100, costUsd: 0 } });
    expect(r.message.stopReason).toBe('toolUse');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ name: 'checker', sessionId: 's1', model: { provider: 'scripted', model: 'claude-x', stopReason: 'toolUse' } });
    expect(records[0]!.error).toBeUndefined();
  });

  test('budgets are checked before calling', async () => {
    let calls = 0;
    const gw = createModelGateway({ roles: { checker: { provider: 'scripted', model: 'm' } }, providers: [scriptedProvider(script, { onCall: () => calls++ })] });
    const spent = { tokens: 100, modelCalls: 1, elapsedMs: 10 };
    await expect(gw.call(request(), { ...opts, budget: { tokens: 100 }, spent })).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(gw.call(request(), { ...opts, budget: { modelCalls: 1 }, spent })).rejects.toMatchObject({ limit: 'modelCalls' });
    await expect(gw.call(request(), { ...opts, budget: { timeMs: 10 }, spent })).rejects.toMatchObject({ limit: 'timeMs' });
    expect(calls).toBe(0);
    await gw.call(request(), { ...opts, budget: { tokens: 101, modelCalls: 2, timeMs: 11 }, spent });
    expect(calls).toBe(1);
  });

  test('falls back in order when a provider throws or returns an error message', async () => {
    const down = failing('anthropic', 'throw');
    const overloaded = failing('openai', 'error');
    const records: Parameters<ModelCallSink['record']>[0][] = [];
    const gw = createModelGateway({
      roles: { checker: { provider: 'anthropic', model: 'a', fallbacks: [{ provider: 'openai', model: 'o' }, { provider: 'scripted', model: 's' }] } },
      providers: [down, overloaded, scriptedProvider(script)],
      sink: { record: (e) => { records.push(e); } },
    });
    const r = await gw.call(request(), opts);
    expect(r).toMatchObject({ provider: 'scripted', model: 's' });
    expect([down.calls, overloaded.calls]).toEqual([1, 1]);
    expect(records.map((e) => [e.model?.provider, e.error])).toEqual([
      ['anthropic', 'anthropic is down'], ['openai', 'error: overloaded'], ['scripted', undefined],
    ]);
    expect(records[1]!.model?.usage).toMatchObject({ totalTokens: 5, costUsd: 0.01 });
  });

  test('all providers failing throws, so the DBOS step policy retries', async () => {
    const gw = createModelGateway({
      roles: { checker: { provider: 'anthropic', model: 'a', fallbacks: [{ provider: 'missing', model: 'x' }] } },
      providers: [failing('anthropic', 'error')],
    });
    await expect(gw.call(request(), opts)).rejects.toThrow('model call for role "checker" failed: anthropic/a: error: overloaded; missing/x: no provider "missing" is registered');
  });

  test('script exhaustion surfaces as a failure', async () => {
    const gw = createModelGateway({ roles: { checker: { provider: 'scripted', model: 'm' } }, providers: [scriptedProvider({ checker: [] })] });
    await expect(gw.call(request(), opts)).rejects.toThrow('script exhausted for role checker');
  });

  test('a failing sink does not fail the call', async () => {
    const gw = createModelGateway({
      roles: { checker: { provider: 'scripted', model: 'm' } }, providers: [scriptedProvider(script)],
      sink: { record: () => { throw new Error('meter down'); } },
    });
    expect((await gw.call(request(), opts)).provider).toBe('scripted');
  });
});
