// A kernel in its own process, so tests can SIGKILL it (MEMWISE_CRASH_AT) and start it again.
//
//   bun kernel-worker.ts fake <databaseUrl> <runId>   fake step; starts the intake run at `check`
//   bun kernel-worker.ts exit <databaseUrl> <runId> <counterFile>
//                                                    the real step engine on examples/intake (exit test)
//   bun kernel-worker.ts invite <databaseUrl> <runId> <filesDir>
//                                                    client intake v2 at `invite` (Phase 5): the link
//                                                    is issued and emailed once, after its approval
//   bun kernel-worker.ts onboard <databaseUrl> <runId> <filesDir>
//                                                    examples/intake indexed, the run starts at the
//                                                    system step `onboard` (domain.customer.create)
//
// Each starts the run (a no-op when it already exists; DBOS.launch recovers it), answers
// pending approvals as the example says, and exits 0 once the run has left its first state.
import { createKernel } from '../../src/kernel.ts';
import type { Kernel, KernelOptions } from '../../src/types.ts';
import { fakeStep } from './fake-step.ts';

const [mode, databaseUrl, runId, counterFile] = process.argv.slice(2);
if (!mode || !databaseUrl || !runId) throw new Error('usage: kernel-worker.ts fake|exit <databaseUrl> <runId> [counterFile]');

let kernel: Kernel;
let approvals: Record<string, 'approve' | 'reject'> = {};
let start: { workflowId: string; case: Record<string, unknown>; startAt: string };

if (mode === 'invite') {
  // Phase 5: client intake v2 at its system step `invite` (external.invite → email.send), with a
  // public address; the invite's approval is answered by the loop below.
  const { SAMPLE_DIR } = await import('./exit-setup.ts');
  const { sampleTools } = await import('../../src/sample-tools.ts');
  const { cpSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const projectDir = join(mkdtempSync(join(tmpdir(), 'mw-invite-')), 'intake');
  cpSync(SAMPLE_DIR, projectDir, { recursive: true });
  kernel = await createKernel({
    databaseUrl, projectDir, tools: sampleTools({ databaseUrl }), modelRoles: {}, providers: [], filesDir: counterFile,
    publicUrl: () => 'https://memwise.example', businessName: 'Acme Advisors',
  });
  await kernel.index();
  approvals = { 'external.invite': 'approve' };
  start = { workflowId: 'client-intake', startAt: 'invite', case: { client_name: 'Asha Rao', client_email: 'asha@acme-traders.example', contact_by: 'email' } };
} else if (mode === 'onboard') {
  const { INTAKE_DIR } = await import('./exit-setup.ts');
  const { sampleTools } = await import('../../src/sample-tools.ts');
  kernel = await createKernel({ databaseUrl, projectDir: INTAKE_DIR, tools: sampleTools({ databaseUrl }), modelRoles: {}, providers: [], filesDir: counterFile });
  await kernel.index();
  start = { workflowId: 'client-intake', startAt: 'onboard', case: { client_name: 'Asha Rao', client_email: 'asha@acme-traders.example', pan: 'AAACA1234A', gstin: '29AAACA1234A1Z5' } };
} else if (mode === 'fake') {
  kernel = await createKernel({ databaseUrl, tools: [], modelRoles: {}, providers: [], stepExecutor: fakeStep(databaseUrl) });
  start = { workflowId: 'client-intake', startAt: 'check', case: { pan: 'AAACM9999Z' } };
} else {
  const { exitKernelOptions } = await import('./exit-setup.ts');
  const setup = await exitKernelOptions(databaseUrl, counterFile!);
  kernel = await createKernel(setup.options satisfies KernelOptions);
  approvals = setup.example.approvals ?? {};
  start = { workflowId: 'client-intake', startAt: setup.example.startAt ?? 'check', case: setup.example.case };
}

await kernel.startRun({ ...start, runId });
for (;;) {
  for (const a of await kernel.pendingApprovals()) {
    const answer = approvals[a.tool];
    if (answer) {
      await kernel.decideApproval({ id: a.id, status: answer === 'approve' ? 'approved' : 'rejected', by: 'test-manager', at: new Date().toISOString() });
    }
  }
  const run = await kernel.getRun(runId);
  if (run && (run.state !== start.startAt || run.status !== 'active')) {
    process.stdout.write(`RESULT ${JSON.stringify({ state: run.state, status: run.status, seq: run.seq })}\n`);
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}
await kernel.shutdown();
process.exit(0);
