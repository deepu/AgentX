// Definition version A of the case workflow: intake -> sleep -> review-A -> close.
import { startWorker, step, sleep, log } from './s2-harness.mjs';

async function caseWorkflow(caseId) {
  await step('intake');
  await sleep();
  const review = await step('review-A');
  await step('close');
  log(`RETURN review=${review}`);
  return { caseId, review };
}
await startWorker('A', caseWorkflow, 'def-A');
