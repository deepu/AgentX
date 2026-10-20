/**
 * A local stand-in for the Anthropic Messages API, trimmed from the S4 spike
 * (spikes/s4-pi-ai-step-loop/src/fake-anthropic.ts): scripted SSE replies chosen by the
 * conversation turn (assistant messages in the request), and a log of request bodies.
 */

export type FakeBlock = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: object };
export type FakeTurn = { blocks: FakeBlock[]; stop: 'tool_use' | 'end_turn' };

function sse(turn: FakeTurn, n: number): string {
  const ev: [string, object][] = [['message_start', { type: 'message_start', message: {
    id: `msg_fake_${n}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } }]];
  turn.blocks.forEach((b, index) => {
    if (b.type === 'text') {
      ev.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
      ev.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } }]);
    } else {
      ev.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }]);
      for (const piece of JSON.stringify(b.input).match(/.{1,10}/gs) ?? []) {
        ev.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: piece } }]);
      }
    }
    ev.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  ev.push(['message_delta', { type: 'message_delta', delta: { stop_reason: turn.stop, stop_sequence: null }, usage: { output_tokens: 20 } }]);
  ev.push(['message_stop', { type: 'message_stop' }]);
  return ev.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

export function startFakeAnthropic(script: FakeTurn[]) {
  const requests: any[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (new URL(req.url).pathname !== '/v1/messages') return new Response('not found', { status: 404 });
      const body = await req.json() as { messages: { role: string }[] };
      requests.push({ body, headers: Object.fromEntries(req.headers) });
      const turn = body.messages.filter((m) => m.role === 'assistant').length;
      const step = script[turn];
      if (!step) return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: `no scripted turn ${turn}` } }, { status: 400 });
      return new Response(sse(step, requests.length), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}
