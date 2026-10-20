// A kernel in its own process, so tests can SIGKILL it (MEMWISE_CRASH_AT) and start it again.
//
//   bun kernel-worker.ts fake <databaseUrl> <runId>   fake step; starts the intake run at `check`
//   bun kernel-worker.ts exit <databaseUrl> <runId> <counterFile>
//                                                    the real step engine on examples/intake (exit test)
//
// Either way it starts the run (a no-op when it already exists; DBOS.launch recovers it), answers
// pending approvals as the example says, and exits 0 once the run has left `check`.
import { createKernel } from '../../src/kernel.ts';
import type { Kernel, KernelOptions } from '../../src/types.ts';
import { fakeStep } from './fake-step.ts';

const [mode, databaseUrl, runId, counterFile] = process.argv.slice(2);
if (!mode || !databaseUrl || !runId) throw new Error('usage: kernel-worker.ts fake|exit <databaseUrl> <runId> [counterFile]');

let kernel: Kernel;
let approvals: Record<string, 'approve' | 'reject'> = {};
let start: { workflowId: string; case: Record<string, unknown>; startAt: string };

if (mode === 'fake') {
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
  if (run && (run.state !== 'check' || run.status !== 'active')) {
    process.stdout.write(`RESULT ${JSON.stringify({ state: run.state, status: run.status, seq: run.seq })}\n`);
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}
await kernel.shutdown();
process.exit(0);
