// Runs one outbound call through the gateway, logging the ledger and the effect to a file
// (argv[2]); run with MEMWISE_CRASH_AT set to see where the process dies.
import { appendFileSync } from 'node:fs';
import { createToolGateway } from '../../src/index.ts';
import { call } from '../helpers.ts';

const log = (line: string) => appendFileSync(process.argv[2]!, line + '\n');
const gw = createToolGateway({
  tools: [{ name: 'mail.send', description: '', inputSchema: {}, effect: 'outbound', async execute() { log('effect'); return 'sent'; } }],
  ledger: {
    async begin() { log('begin'); return { status: 'new' }; },
    async complete() { log('complete'); },
    async fail() { log('fail'); },
  },
});
await gw.execute(call('mail.send', {}), { tool: 'mail.send', effect: 'outbound', classified: true, decision: { verdict: 'allow', reason: '', origins: [] } });
log('returned');
