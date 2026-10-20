/**
 * One step run in its own process, for crash-and-resume tests. Run it with MEMWISE_CRASH_AT to
 * be killed at a crash point; run it again without to let DBOS recover the workflow.
 *
 * Env: DB_URL (DBOS system database), OUT_DIR (logs and result), SCENARIO (`note`: a write tool,
 * the default; `approval`: the pan-mismatch example, whose email needs approval), APPROVE (send
 * the approval decision after launch).
 * Writes to OUT_DIR: model-calls.log (one line per real model call), executions.log (one line
 * per tool execution), provider.jsonl (the fake provider's effects, deduped by idempotency key),
 * ledger.json (a file-backed effect ledger), result.json.
 */
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { ApprovalDecision, EffectLedger, LedgerState } from '@memwise/defs';
import { createModelGateway, createToolGateway, scriptedProvider, type ToolDefinition } from '@memwise/gateway';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalTopic, configureStepEngine, registerAgentStep, type StepResult } from '../../src/index.ts';
import { MemoryRecorder, example, intakeTools, launchDbos, stepInput } from '../helpers.ts';

const out = process.env.OUT_DIR!;
const file = (name: string) => join(out, name);

/** Survives the kill: every write is synchronous. */
class FileLedger implements EffectLedger {
  private read(): Record<string, LedgerState> {
    return existsSync(file('ledger.json')) ? JSON.parse(readFileSync(file('ledger.json'), 'utf8')) : {};
  }
  private write(key: string, state: LedgerState) {
    writeFileSync(file('ledger.json'), JSON.stringify({ ...this.read(), [key]: state }));
  }
  async begin(key: string): Promise<LedgerState> {
    const row = this.read()[key];
    if (row) return row;
    this.write(key, { status: 'pending', startedAt: new Date().toISOString() });
    return { status: 'new' };
  }
  async complete(key: string, result: unknown) { this.write(key, { status: 'done', result }); }
  async fail(key: string, error: string) { this.write(key, { status: 'failed', error }); }
}

/** A write tool whose provider dedups on the idempotency key, as a real one would. */
const addNote: ToolDefinition<{ text: string }> = {
  name: 'crm.add_note',
  description: 'Add a note to the customer in the CRM.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  effect: 'write',
  idempotent: true,
  async execute(args, ctx) {
    appendFileSync(file('executions.log'), `crm.add_note ${ctx.idempotencyKey}\n`);
    const seen = existsSync(file('provider.jsonl')) && readFileSync(file('provider.jsonl'), 'utf8').includes(`"key":"${ctx.idempotencyKey}"`);
    appendFileSync(file('provider.jsonl'), JSON.stringify({ key: ctx.idempotencyKey, applied: !seen, text: args.text }) + '\n');
    return { noteId: 'note-1' };
  },
};

const approval = process.env.SCENARIO === 'approval';
const ex = example(approval ? 'pan-mismatch' : 'clean-application');
const [lookup, finish] = example('clean-application').model!.checker!;
const script = approval ? ex.model! : {
  checker: [lookup!, { toolCalls: [{ name: 'crm.add_note', args: { text: 'GSTIN validated.' } }] }, finish!],
  verifier: ex.model!.verifier!,
};
/** Every real tool execution leaves a line, so the test sees which ran again. */
const logged = [...intakeTools(ex), addNote].map((t): ToolDefinition => ({
  ...t,
  async execute(args, ctx) {
    if (t.name !== addNote.name) appendFileSync(file('executions.log'), `${t.name} ${ctx.idempotencyKey}\n`);
    return t.execute(args, ctx);
  },
}));

const agentStep = registerAgentStep();
configureStepEngine({
  tools: createToolGateway({ tools: logged, ledger: new FileLedger() }),
  models: createModelGateway({
    roles: { checker: { provider: 'scripted', model: 'checker' }, verifier: { provider: 'scripted', model: 'verifier' } },
    providers: [scriptedProvider(script, { onCall: (role, turn) => appendFileSync(file('model-calls.log'), `${role} ${turn}\n`) })],
  }),
  recorder: new MemoryRecorder(),
});
await launchDbos(process.env.DB_URL!);

const input = stepInput('crash', ex, (s) => ({ ...s, tools: { ...s.tools, allowed: [...s.tools.allowed, 'crm.add_note'] } }));
// A killed earlier process left the workflow PENDING: launch() recovers it, and we wait for it.
const existing = await DBOS.getWorkflowStatus(input.stepRunId);
const handle = existing
  ? DBOS.retrieveWorkflow<StepResult>(input.stepRunId)
  : await DBOS.startWorkflow(agentStep, { workflowID: input.stepRunId })(input);
if (process.env.APPROVE) {
  const id = `${input.stepRunId}:call_checker_1_0`;
  await DBOS.send(input.stepRunId, { id, status: 'approved', by: 'manager@example', at: '2026-10-20T11:00:00.000Z' } satisfies ApprovalDecision, approvalTopic(id));
}
const result = await handle.getResult();
writeFileSync(file('result.json'), JSON.stringify(result));
await DBOS.shutdown();
process.exit(0);
