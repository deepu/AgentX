// Definition version B: a new step before the sleep and a different review step.
//   intake -> classify-B -> sleep -> review-B -> close
import { startWorker, step, sleep, log } from './s2-harness.mjs';

async function caseWorkflow(caseId) {
  await step('intake');
  await step('classify-B');
  await sleep();
  const review = await step('review-B');
  await step('close');
  log(`RETURN review=${review}`);
  return { caseId, review };
}
await startWorker('B', caseWorkflow, 'def-B');
