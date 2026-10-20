/** Hand-built definitions for the tests (the defs parsers are not used here). */
import type { PolicyDoc, StepDef, WorkflowDef } from '@memwise/defs';
import type { LayerKind, PolicyLayer } from '../src/index.ts';

export const layer = (kind: LayerKind, name: string, doc: PolicyDoc, source?: string): PolicyLayer =>
  source === undefined ? { kind, name, doc } : { kind, name, source, doc };

export function makeStep(over: Partial<StepDef> = {}): StepDef {
  return {
    id: 'check',
    title: 'Check',
    performer: 'agent',
    strictness: 'guided',
    reads: [],
    writes: {},
    tools: { allowed: [], required: [] },
    checkpoint: [],
    outcomes: ['checked'],
    instructions: '',
    file: 'workflows/wf/steps/check.md',
    hash: 'h',
    ...over,
  };
}

export function makeWorkflow(over: Partial<WorkflowDef> = {}): WorkflowDef {
  return {
    id: 'wf',
    version: 1,
    start: 'check',
    states: { check: { name: 'check', on: { checked: 'end' }, step: 'check' } },
    steps: {},
    caseType: { id: 'c', fields: {}, types: {}, file: 'workflows/wf/case.yaml', hash: 'h' },
    examples: [],
    dir: 'workflows/wf',
    hash: 'h',
    ...over,
  };
}

// ---------------------------------------------------------------- examples/intake, by hand

/** examples/intake/domain/policy.yaml */
export const intakeDomainPolicy: PolicyDoc = {
  name: 'domain',
  effects: { outbound: 'approve', irreversible: 'deny' },
  tools: { deny: ['payments.transfer'] },
  budgets: { tokens: 200000, modelCalls: 60 },
  modelRoles: ['checker', 'verifier', 'extractor'],
  file: 'domain/policy.yaml',
};

/** examples/intake/workflows/client-intake/policy.yaml */
export const intakeWorkflowPolicy: PolicyDoc = {
  name: 'client-intake',
  effects: { irreversible: 'deny' },
  budgets: { tokens: 100000 },
  file: 'workflows/client-intake/policy.yaml',
};

export const CHECK_TOOLS = ['gst.validate_gstin', 'intake.extract_fields', 'email.send', 'recall.step_record', 'recall.similar_cases'];

/** examples/intake/workflows/client-intake/steps/check.md (front matter only) */
export const intakeCheckStep: StepDef = makeStep({
  id: 'check',
  title: "Check the client's answers",
  tools: { allowed: [...CHECK_TOOLS], required: ['gst.validate_gstin'] },
  model: 'checker',
  budget: { tokens: 40000, timeMs: 600000, modelCalls: 12 },
  checkpoint: ['every flag names the document it came from'],
  outcomes: ['checked', 'needs_info', 'failed'],
  file: 'workflows/client-intake/steps/check.md',
});

export const intakeWorkflow: WorkflowDef = makeWorkflow({
  id: 'client-intake',
  policy: intakeWorkflowPolicy,
  steps: { check: intakeCheckStep },
  dir: 'workflows/client-intake',
});
