import type { StepEngineDeps } from './types.ts';

// Module-level because a DBOS workflow body can only take its (JSON) input: the gateways and
// stores are wired once per process, before DBOS.launch() starts recovering step runs.
let current: StepEngineDeps | undefined;

export function configureStepEngine(deps: StepEngineDeps): void {
  current = deps;
}

export function engineDeps(): StepEngineDeps {
  if (!current) throw new Error('step engine not configured: call configureStepEngine(deps) before DBOS.launch()');
  return current;
}
