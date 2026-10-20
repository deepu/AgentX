/**
 * The real pi-ai path (Anthropic SDK, request building, SSE parsing) against a local fake
 * server: a tool round trip through the model gateway.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { AssistantMessage, Message, ToolCall } from '@earendil-works/pi-ai';
import { createModelGateway, modelToolName, piAiProvider, type ModelRequest } from '../src/index.ts';
import { startFakeAnthropic } from './fake-anthropic.ts';

const fake = startFakeAnthropic([
  { stop: 'tool_use', blocks: [
    { type: 'text', text: 'Validating the GSTIN.' },
    { type: 'tool_use', id: 'toolu_1', name: 'gst__validate_gstin', input: { gstin: '27AAACR5055K1Z7' } },
  ] },
  { stop: 'end_turn', blocks: [{ type: 'text', text: 'The GSTIN is valid.' }] },
]);
afterAll(() => fake.stop());

describe('piAiProvider', () => {
  test('a tool round trip through pi-ai against a fake Anthropic server', async () => {
    const gw = createModelGateway({
      roles: { checker: { provider: 'anthropic', model: 'claude-sonnet-4-5', maxTokens: 1024 } },
      providers: [piAiProvider({ id: 'anthropic', apiKey: 'sk-fake', baseUrl: fake.url })],
    });
    const messages: Message[] = [{ role: 'user', content: 'Check the GSTIN.', timestamp: 1 }];
    const request = (): ModelRequest => ({
      systemPrompt: 'You check intake.',
      messages,
      tools: [{
        name: modelToolName('gst.validate_gstin'), description: 'Validate a GSTIN',
        parameters: { type: 'object', properties: { gstin: { type: 'string' } }, required: ['gstin'] },
      }],
    });

    const first = await gw.call(request(), { role: 'checker', sessionId: 'run_1/1/check' });
    expect(first.provider).toBe('anthropic');
    expect(first.message.stopReason).toBe('toolUse');
    const toolCall = first.message.content.find((b): b is ToolCall => b.type === 'toolCall')!;
    expect(toolCall).toMatchObject({ id: 'toolu_1', name: 'gst__validate_gstin', arguments: { gstin: '27AAACR5055K1Z7' } });
    expect(first.usage).toMatchObject({ input: 40, output: 20 });

    // What pi-ai sent: our system prompt, the tool's JSON Schema, the key and max tokens.
    const sent = fake.requests[0]!;
    expect(JSON.stringify(sent.body.system)).toContain('You check intake.');
    expect(sent.body.tools[0]).toMatchObject({ name: 'gst__validate_gstin', input_schema: { properties: { gstin: { type: 'string' } } } });
    expect(sent.body.max_tokens).toBe(1024);
    expect(sent.headers['x-api-key']).toBe('sk-fake');

    messages.push(first.message, {
      role: 'toolResult', toolCallId: toolCall.id, toolName: toolCall.name, isError: false, timestamp: 2,
      content: [{ type: 'text', text: '{"valid":true}' }],
    });
    const second = await gw.call(request(), { role: 'checker', sessionId: 'run_1/1/check' });
    expect(second.message.stopReason).toBe('stop');
    expect(second.message.content).toEqual([{ type: 'text', text: 'The GSTIN is valid.' }]);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.body.messages.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
  });

  test('a provider error is a failed call (no pi-ai retries)', async () => {
    const before = fake.requests.length;
    const gw = createModelGateway({
      roles: { checker: { provider: 'anthropic', model: 'claude-sonnet-4-5' } },
      providers: [piAiProvider({ id: 'anthropic', apiKey: 'sk-fake', baseUrl: fake.url })],
    });
    // Three assistant turns: the fake has no reply scripted and answers 400.
    const a: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'x' }], api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-5', stopReason: 'stop', timestamp: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const u = (t: string) => ({ role: 'user' as const, content: t, timestamp: 0 });
    await expect(gw.call({ systemPrompt: 's', messages: [u('a'), a, u('b'), a, u('c')], tools: [] }, { role: 'checker', sessionId: 's' }))
      .rejects.toThrow('model call for role "checker" failed');
    expect(fake.requests.length - before).toBe(1);
  });

  test('unknown provider id and unknown model are clear errors', async () => {
    expect(() => piAiProvider({ id: 'nope' })).toThrow('pi-ai provider "nope" is not built in');
    const p = piAiProvider({ id: 'anthropic', apiKey: 'k', baseUrl: fake.url });
    await expect(p.complete('no-such-model', { systemPrompt: '', messages: [], tools: [] }, { role: 'r', sessionId: 's' }))
      .rejects.toThrow('model "no-such-model" is not in pi-ai\'s anthropic catalog');
  });
});
