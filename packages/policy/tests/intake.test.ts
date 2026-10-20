/** The real stack for examples/intake's `check` step, built by hand from its files. */
import { expect, test } from 'bun:test';
import { compilePolicy, decide, describePolicy, layersFor, type RuleOrigin } from '../src/index.ts';
import { CHECK_TOOLS, intakeCheckStep, intakeDomainPolicy, intakeWorkflow } from './fixtures.ts';

const D: RuleOrigin = { layer: 'domain', name: 'domain', source: 'domain/policy.yaml' };
const S: RuleOrigin = { layer: 'step', name: 'client-intake/check', source: 'workflows/client-intake/steps/check.md' };

const layers = layersFor({ domainPolicy: intakeDomainPolicy, workflow: intakeWorkflow, step: intakeCheckStep });
const { effective, violations } = compilePolicy(layers);

test('the check step compiles without violations', () => {
  expect(violations).toEqual([]);
  expect(effective.layers.map((l) => l.name)).toEqual(['platform', 'domain', 'client-intake', 'client-intake/check']);
});

test('effects: outbound approve and irreversible deny, both from the domain', () => {
  expect(effective.effects.outbound).toEqual({ value: 'approve', origin: D });
  // The workflow restates `irreversible: deny`; the domain set it first and keeps it.
  expect(effective.effects.irreversible).toEqual({ value: 'deny', origin: D });
  expect(effective.effects.read.value).toBe('allow');
});

test('budgets and model roles come from the step; the verifier role is permitted for its checkpoint rules', () => {
  expect(effective.budgets.tokens).toEqual({ value: 40000, origin: S });
  expect(effective.budgets.modelCalls).toEqual({ value: 12, origin: S });
  expect(effective.budgets.timeMs).toEqual({ value: 600000, origin: S });
  expect(effective.modelRoles).toEqual({ value: ['checker', 'verifier'], origin: S });
});

test('the run budgets above the step are kept apart from the step budgets that hide them', () => {
  expect(effective.runBudgets).toEqual({
    tokens: { value: 100000, origin: { layer: 'workflow', name: 'client-intake', source: 'workflows/client-intake/policy.yaml' } },
    modelCalls: { value: 60, origin: D },
  });
});

test("the allowed tools are the step's list", () => {
  expect(effective.tools.allowed).toEqual({ value: CHECK_TOOLS, origin: S });
  expect(effective.tools.required).toEqual([{ value: 'gst.validate_gstin', origin: S }]);
  expect(effective.tools.denied).toEqual([{ value: 'payments.transfer', origin: D }]);
});

test('decisions for the tools the check step meets', () => {
  expect(decide(effective, { tool: 'gst.validate_gstin', effect: 'read', classified: true, tainted: false }).verdict).toBe('allow');
  expect(decide(effective, { tool: 'email.send', effect: 'outbound', classified: true, tainted: false }))
    .toMatchObject({ verdict: 'approve', origins: [D] });
  expect(decide(effective, { tool: 'payments.transfer', effect: 'irreversible', classified: true, tainted: false }).verdict).toBe('deny');
  expect(decide(effective, { tool: 'web.fetch', effect: 'read', classified: true, tainted: false }).verdict).toBe('deny');
  expect(decide(effective, { tool: 'step.finish', effect: 'write', classified: true, tainted: false }).verdict).toBe('allow');
});

test('the effective-policy view names the layer of every rule', () => {
  const text = describePolicy(effective);
  expect(text).toContain('outbound: approve  (domain, domain/policy.yaml)');
  expect(text).toContain('irreversible: deny  (domain, domain/policy.yaml)');
  expect(text).toContain('read: allow  (platform)');
  expect(text).toContain(`allowed: ${CHECK_TOOLS.join(', ')}  (step client-intake/check, workflows/client-intake/steps/check.md)`);
  expect(text).toContain('denied: payments.transfer  (domain, domain/policy.yaml)');
  expect(text).toContain('tokens: 40000  (step client-intake/check, workflows/client-intake/steps/check.md)');
  expect(text).toContain('time: 10m  (step client-intake/check');
  expect(text).toContain('roles: checker, verifier  (step client-intake/check');
  expect(text).toContain('run tokens: 100000  (workflow client-intake, workflows/client-intake/policy.yaml)');
  expect(text).toContain('run model calls: 60  (domain, domain/policy.yaml)');
  expect(text).toContain('enabled: on  (platform)');
  expect(text).toContain('layers: platform → domain, domain/policy.yaml → workflow client-intake, workflows/client-intake/policy.yaml → step client-intake/check');
});

test('a step that tries to loosen the domain is caught', () => {
  const loose = { ...intakeCheckStep, budget: { tokens: 300000 }, model: 'writer', policy: { effects: { outbound: 'allow' as const } } };
  const { violations: v } = compilePolicy(layersFor({ domainPolicy: intakeDomainPolicy, workflow: intakeWorkflow, step: loose }));
  expect(v.map((x) => x.path).sort()).toEqual(['budgets.tokens', 'effects.outbound', 'modelRoles']);
  expect(v.every((x) => x.source === 'workflows/client-intake/steps/check.md')).toBe(true);
});
