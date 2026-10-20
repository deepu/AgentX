/**
 * Crash points for crash-and-resume tests (docs/memwise/17-build-plan.md: "every runtime
 * package ships with crash-and-resume tests").
 *
 * `MEMWISE_CRASH_AT=<point>[@<detail>]` kills the process with SIGKILL when the named point
 * is reached (and, if given, the detail matches). Unset in production: a no-op.
 *
 * Points used by the kernel:
 *   after-model-call@<n>        step engine, after the n-th model call (1-based, verifier calls included) is journaled
 *   after-tool-effect@<tool>    gateway, after the tool ran, before the ledger marks the key done
 *   after-ledger-complete@<tool> gateway, after the ledger marked the key done, before DBOS records the step
 *   waiting-approval@<tool>     step engine, after the approval request is recorded, while waiting
 *   after-system-tool@<tool>    step engine, a system step's tool call is recorded by DBOS, before the next one (Phase 2)
 *   before-finish               step engine, after the checkpoint passed, before the step record is finished
 *   after-step-before-commit@<state>  runtime, after a step returned, before the transition commits
 *   in-commit@<state>           runtime, inside the commit transaction
 */
import { writeSync } from 'node:fs';

export function crashPoint(point: string, detail?: string | number): void {
  const spec = process.env.MEMWISE_CRASH_AT;
  if (!spec) return;
  const [want, filter] = spec.split('@');
  if (want !== point || (filter !== undefined && filter !== String(detail))) return;
  writeSync(2, `[memwise] MEMWISE_CRASH_AT=${spec}: SIGKILL pid ${process.pid}\n`);
  process.kill(process.pid, 'SIGKILL');
}
