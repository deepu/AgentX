// Version B written with DBOS's patch API instead of a new application version
// (run with PATCHING=1). Same changes as s2-def-b.mjs, each behind a patch.
import { DBOS } from '@dbos-inc/dbos-sdk';
import { startWorker, step, sleep, log } from './s2-harness.mjs';

async function caseWorkflow(caseId) {
  await step('intake');
  if (await DBOS.patch('v2-classify')) await step('classify-B');
  await sleep();
  const review = (await DBOS.patch('v2-review')) ? await step('review-B') : await step('review-A');
  await step('close');
  log(`RETURN review=${review}`);
  return { caseId, review };
}
await startWorker('B-patched', caseWorkflow);
