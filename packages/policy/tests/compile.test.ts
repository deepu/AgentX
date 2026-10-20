import { describe, expect, test } from 'bun:test';
import {
  PLATFORM_DEFAULTS, VERIFIER_ROLE, compilePolicy, describePolicy, layersFor, stepLayer, violationsToDiagnostics, type RuleOrigin,
} from '../src/index.ts';
import { layer, makeStep, makeWorkflow } from './fixtures.ts';

const platform: RuleOrigin = { layer: 'platform', name: 'platform' };
const domain = (doc: Parameters<typeof layer>[2]) => layer('domain', 'domain', doc, 'domain/policy.yaml');
const workflow = (doc: Parameters<typeof layer>[2]) => layer('workflow', 'wf', doc, 'workflows/wf/policy.yaml');
const step = (doc: Parameters<typeof layer>[2]) => layer('step', 'wf/check', doc, 'workflows/wf/steps/check.md');
const D: RuleOrigin = { layer: 'domain', name: 'domain', source: 'domain/policy.yaml' };
const W: RuleOrigin = { layer: 'workflow', name: 'wf', source: 'workflows/wf/policy.yaml' };
const S: RuleOrigin = { layer: 'step', name: 'wf/check', source: 'workflows/wf/steps/check.md' };

describe('PLATFORM_DEFAULTS', () => {
  test('compiles to the documented defaults', () => {
    const { effective, violations } = compilePolicy([PLATFORM_DEFAULTS]);
    expect(violations).toEqual([]);
    expect(Object.fromEntries(Object.entries(effective.effects).map(([k, v]) => [k, v.value]))).toEqual({
      read: 'allow', draft: 'allow', write: 'allow', outbound: 'approve', irreversible: 'approve',
    });
    expect(effective.effects.outbound.origin).toEqual(platform);
    expect(effective.taint.enabled).toEqual({ value: true, origin: platform });
    expect(effective.taint.outboundWhenTainted).toEqual({ value: 'approve', origin: platform });
    expect(effective.tools.allowed).toBeNull();
    expect(effective.modelRoles).toBeNull();
    expect(effective.budgets).toEqual({});
  });

  test('a stack without the platform layer falls back to its defaults', () => {
    const { effective } = compilePolicy([domain({ effects: { write: 'preview' } })]);
    expect(effective.effects.write).toEqual({ value: 'preview', origin: D });
    expect(effective.effects.irreversible).toEqual({ value: 'approve', origin: platform });
    expect(effective.taint.enabled.value).toBe(true);
  });
});

describe('effects', () => {
  test('a lower layer may tighten; the strictest wins with its origin', () => {
    const { effective, violations } = compilePolicy([
      PLATFORM_DEFAULTS, domain({ effects: { write: 'preview' } }), workflow({ effects: { write: 'deny' } }),
    ]);
    expect(violations).toEqual([]);
    expect(effective.effects.write).toEqual({ value: 'deny', origin: W });
  });

  test('restating a value keeps the upper origin', () => {
    const { effective, violations } = compilePolicy([
      PLATFORM_DEFAULTS, domain({ effects: { irreversible: 'deny' } }), workflow({ effects: { irreversible: 'deny' } }),
    ]);
    expect(violations).toEqual([]);
    expect(effective.effects.irreversible.origin).toEqual(D);
  });

  test('restating a platform default claims it', () => {
    const { effective } = compilePolicy([
      PLATFORM_DEFAULTS, domain({ effects: { outbound: 'approve' }, taint: { enabled: true, outboundWhenTainted: 'approve' } }),
    ]);
    expect(effective.effects.outbound.origin).toEqual(D);
    expect(effective.taint.enabled.origin).toEqual(D);
    expect(effective.taint.outboundWhenTainted.origin).toEqual(D);
  });

  test('loosening is a violation and is ignored', () => {
    const { effective, violations } = compilePolicy([
      PLATFORM_DEFAULTS, domain({ effects: { outbound: 'deny' } }), step({ effects: { outbound: 'allow', read: 'allow' } }),
    ]);
    expect(effective.effects.outbound).toEqual({ value: 'deny', origin: D });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ ...S, path: 'effects.outbound', loosens: D });
    expect(violations[0]!.message).toContain('looser than deny');
  });
});

describe('tools', () => {
  test('allow lists intersect; a tool outside the upper list is a violation and not allowed', () => {
    const { effective, violations } = compilePolicy([
      PLATFORM_DEFAULTS, workflow({ tools: { allow: ['a', 'b', 'c'] } }), step({ tools: { allow: ['a', 'b', 'x'] } }),
    ]);
    expect(effective.tools.allowed).toEqual({ value: ['a', 'b'], origin: S });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ ...S, path: 'tools.allow', loosens: W });
    expect(violations[0]!.message).toContain('x');
  });

  test('restating the same allow list keeps the upper origin', () => {
    const { effective } = compilePolicy([workflow({ tools: { allow: ['a', 'b'] } }), step({ tools: { allow: ['b', 'a'] } })]);
    expect(effective.tools.allowed?.origin).toEqual(W);
  });

  test('deny is a union and removes the tool from the allow list', () => {
    const { effective, violations } = compilePolicy([
      domain({ tools: { deny: ['pay'] } }), workflow({ tools: { allow: ['a', 'b'], deny: ['b'] } }),
    ]);
    expect(violations).toEqual([]);
    expect(effective.tools.denied).toEqual([{ value: 'pay', origin: D }, { value: 'b', origin: W }]);
    expect(effective.tools.allowed).toEqual({ value: ['a'], origin: W });
  });

  test('allowing or requiring a tool denied above is a violation', () => {
    const { effective, violations } = compilePolicy([
      domain({ tools: { deny: ['pay'] } }), step({ tools: { allow: ['pay', 'a'], require: ['pay'] } }),
    ]);
    expect(effective.tools.allowed?.value).toEqual(['a']);
    expect(effective.tools.required).toEqual([]);
    expect(violations.map((v) => [v.path, v.loosens])).toEqual([['tools.allow', D], ['tools.require', D]]);
  });

  test('require is a union; a required tool that is not allowed is a violation', () => {
    const { effective, violations } = compilePolicy([
      workflow({ tools: { require: ['audit.log'] } }), step({ tools: { allow: ['a', 'audit.log'], require: ['a', 'b'] } }),
    ]);
    expect(effective.tools.required).toEqual([{ value: 'audit.log', origin: W }, { value: 'a', origin: S }]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ ...S, path: 'tools.require', loosens: S });
    expect(violations[0]!.message).toContain('b is required');
  });

  test('a lower allow list that drops an upper requirement is blamed on the lower layer', () => {
    const { violations } = compilePolicy([workflow({ tools: { require: ['audit.log'] } }), step({ tools: { allow: ['a'] } })]);
    expect(violations).toEqual([expect.objectContaining({ ...S, path: 'tools.require', loosens: W })]);
  });

  test('built-in tools are never listed or denied', () => {
    const { effective, violations } = compilePolicy([
      workflow({ tools: { allow: ['a'], deny: ['step.finish'] } }), step({ tools: { allow: ['a', 'step.finish', 'checkpoint.verdict'] } }),
    ]);
    expect(violations).toEqual([]);
    expect(effective.tools.allowed?.value).toEqual(['a']);
    expect(effective.tools.denied).toEqual([]);
  });

  test('per-tool treatment only tightens', () => {
    const { effective, violations } = compilePolicy([
      domain({ tools: { rules: { 'email.send': { treatment: 'approve' } } } }),
      workflow({ tools: { rules: { 'email.send': { treatment: 'deny' }, 'crm.update': { treatment: 'preview' } } } }),
      step({ tools: { rules: { 'email.send': { treatment: 'preview' } } } }),
    ]);
    expect(effective.tools.perTool['email.send']?.treatment).toEqual({ value: 'deny', origin: W });
    expect(effective.tools.perTool['crm.update']?.treatment).toEqual({ value: 'preview', origin: W });
    expect(violations).toEqual([expect.objectContaining({ ...S, path: 'tools.rules.email.send.treatment', loosens: W })]);
  });

  test('rate limits: the lower rate wins, a higher one is a violation, the same rate keeps its origin', () => {
    const { effective, violations } = compilePolicy([
      layer('plugin', 'intake', { tools: { rules: { x: { rateLimit: { count: 10, perMs: 60_000 } } } } }),
      domain({ tools: { rules: { x: { rateLimit: { count: 1, perMs: 6_000 } } } } }),
      workflow({ tools: { rules: { x: { rateLimit: { count: 5, perMs: 60_000 } } } } }),
      step({ tools: { rules: { x: { rateLimit: { count: 1, perMs: 1_000 } } } } }),
    ]);
    expect(effective.tools.perTool.x?.rateLimit).toEqual({ value: { count: 5, perMs: 60_000 }, origin: W });
    expect(violations).toEqual([expect.objectContaining({ ...S, path: 'tools.rules.x.rateLimit', loosens: W })]);
  });
});

describe('budgets', () => {
  test('the lowest value wins; a higher one is a violation', () => {
    const { effective, violations } = compilePolicy([
      domain({ budgets: { tokens: 200000, timeMs: 600000 } }),
      workflow({ budgets: { tokens: 100000, modelCalls: 20 } }),
      step({ budgets: { tokens: 150000, timeMs: 600000 } }),
    ]);
    expect(effective.budgets.tokens).toEqual({ value: 100000, origin: W });
    expect(effective.budgets.timeMs).toEqual({ value: 600000, origin: D });
    expect(effective.budgets.modelCalls).toEqual({ value: 20, origin: W });
    expect(violations).toEqual([expect.objectContaining({ ...S, path: 'budgets.tokens', loosens: W })]);
    // Run budgets: only the layers above the step.
    expect(effective.runBudgets).toEqual({ tokens: { value: 100000, origin: W }, timeMs: { value: 600000, origin: D }, modelCalls: { value: 20, origin: W } });
  });

  test('a step that tightens a budget keeps the run budget above it apart', () => {
    const { effective, violations } = compilePolicy([
      domain({ budgets: { tokens: 200000, modelCalls: 60 } }),
      step({ budgets: { tokens: 40000 } }),
    ]);
    expect(violations).toEqual([]);
    expect(effective.budgets.tokens).toEqual({ value: 40000, origin: S });
    expect(effective.runBudgets).toEqual({ tokens: { value: 200000, origin: D }, modelCalls: { value: 60, origin: D } });
    const text = describePolicy(effective);
    expect(text).toContain('tokens: 40000  (step wf/check');
    expect(text).toContain('run tokens: 200000  (domain, domain/policy.yaml)');
    expect(text).not.toContain('run model calls');
  });

  test('money compares within one currency; another currency is a violation', () => {
    const { effective, violations } = compilePolicy([
      domain({ budgets: { money: { amount: 100, currency: 'INR' } } }),
      workflow({ budgets: { money: { amount: 50, currency: 'INR' } } }),
      step({ budgets: { money: { amount: 1, currency: 'USD' } } }),
      layer('step', 'wf/other', { budgets: { money: { amount: 80, currency: 'INR' } } }),
    ]);
    expect(effective.budgets.money).toEqual({ value: { amount: 50, currency: 'INR' }, origin: W });
    expect(violations.map((v) => [v.name, v.path, v.loosens])).toEqual([
      ['wf/check', 'budgets.money', W], ['wf/other', 'budgets.money', W],
    ]);
    expect(violations[0]!.message).toContain('currency mismatch');
  });
});

describe('model roles and taint', () => {
  test('model roles intersect; an extra role is a violation', () => {
    const { effective, violations } = compilePolicy([
      domain({ modelRoles: ['checker', 'verifier'] }), step({ modelRoles: ['checker', 'writer'] }),
    ]);
    expect(effective.modelRoles).toEqual({ value: ['checker'], origin: S });
    expect(violations).toEqual([expect.objectContaining({ ...S, path: 'modelRoles', loosens: D })]);
  });

  test('taint may not be switched off once on; its treatment only tightens', () => {
    const { effective, violations } = compilePolicy([
      PLATFORM_DEFAULTS,
      domain({ taint: { outboundWhenTainted: 'deny' } }),
      step({ taint: { enabled: false, outboundWhenTainted: 'preview' } }),
    ]);
    expect(effective.taint.enabled).toEqual({ value: true, origin: platform });
    expect(effective.taint.outboundWhenTainted).toEqual({ value: 'deny', origin: D });
    expect(violations.map((v) => [v.path, v.loosens])).toEqual([
      ['taint.outboundWhenTainted', D], ['taint.enabled', platform],
    ]);
  });

  test('a lower layer may switch taint on', () => {
    const { effective, violations } = compilePolicy([layer('plugin', 'p', { taint: { enabled: false } }), domain({ taint: { enabled: true } })]);
    expect(violations).toEqual([]);
    expect(effective.taint.enabled).toEqual({ value: true, origin: D });
  });
});

describe('stepLayer and layersFor', () => {
  test('a step layer carries its tools, budget and model role', () => {
    const l = stepLayer(makeStep({
      tools: { allowed: ['a', 'recall.step_record'], required: ['a'] },
      model: 'checker',
      budget: { tokens: 40000, timeMs: 600000 },
    }), 'wf');
    expect(l).toEqual({
      kind: 'step',
      name: 'wf/check',
      source: 'workflows/wf/steps/check.md',
      doc: {
        tools: { allow: ['a', 'recall.step_record'], require: ['a'] },
        budgets: { tokens: 40000, timeMs: 600000 },
        modelRoles: ['checker'],
      },
    });
  });

  test('a step with prose checkpoint rules also permits the verifier role', () => {
    expect(stepLayer(makeStep({ model: 'checker', checkpoint: ['every flag names its document'] }), 'wf').doc.modelRoles)
      .toEqual(['checker', VERIFIER_ROLE]);
    expect(VERIFIER_ROLE).toBe('verifier');
  });

  test('an agent step with no tools may call none', () => {
    expect(stepLayer(makeStep(), 'wf').doc.tools?.allow).toEqual([]);
  });

  test("the step's policy block merges in; the stricter of the two wins", () => {
    const l = stepLayer(makeStep({
      tools: { allowed: ['a', 'b'], required: ['a'] },
      budget: { tokens: 40000, modelCalls: 5 },
      model: 'checker',
      policy: {
        effects: { write: 'preview' },
        tools: { allow: ['b', 'c'], require: ['b'], deny: ['z'] },
        budgets: { tokens: 10000, modelCalls: 50 },
        modelRoles: ['checker', 'verifier'],
      },
    }), 'wf');
    expect(l.doc).toMatchObject({
      effects: { write: 'preview' },
      tools: { allow: ['b'], require: ['a', 'b'], deny: ['z'] },
      budgets: { tokens: 10000, modelCalls: 5 },
      modelRoles: ['checker'],
    });
  });

  test('layersFor stacks platform, plugins, domain, workflow and step', () => {
    const plugin = layer('plugin', 'gst', { tools: { rules: { x: { treatment: 'preview' } } } });
    const wf = makeWorkflow({ policy: { effects: { write: 'preview' }, file: 'workflows/wf/policy.yaml' } });
    const layers = layersFor({ domainPolicy: { file: 'domain/policy.yaml' }, plugins: [plugin], workflow: wf, step: makeStep() });
    expect(layers.map((l) => [l.kind, l.name, l.source])).toEqual([
      ['platform', 'platform', undefined],
      ['plugin', 'gst', undefined],
      ['domain', 'domain', 'domain/policy.yaml'],
      ['workflow', 'wf', 'workflows/wf/policy.yaml'],
      ['step', 'wf/check', 'workflows/wf/steps/check.md'],
    ]);
    expect(compilePolicy(layers).effective.layers.map((l) => l.kind)).toEqual(['platform', 'plugin', 'domain', 'workflow', 'step']);
  });

  test('layersFor skips what is absent', () => {
    expect(layersFor({ workflow: makeWorkflow() }).map((l) => l.kind)).toEqual(['platform']);
  });
});

test('violationsToDiagnostics', () => {
  const { violations } = compilePolicy([domain({ effects: { outbound: 'deny' } }), step({ effects: { outbound: 'allow' } })]);
  expect(violationsToDiagnostics(violations)).toEqual([{
    severity: 'error',
    code: 'policy-loosened',
    message: violations[0]!.message,
    file: 'workflows/wf/steps/check.md',
    path: 'effects.outbound',
  }]);
});

test('describePolicy shows open lists, rate limits and money with their layers', () => {
  const { effective } = compilePolicy([
    PLATFORM_DEFAULTS,
    domain({ tools: { rules: { 'gst.validate_gstin': { treatment: 'preview', rateLimit: { count: 10, perMs: 60_000 } } } } }),
    workflow({ budgets: { money: { amount: 50, currency: 'INR' }, timeMs: 5_400_000 } }),
  ]);
  const text = describePolicy(effective);
  expect(text).toContain('allowed: any tool bound in the domain');
  expect(text).toContain('roles: any');
  expect(text).toContain('gst.validate_gstin: preview  (domain, domain/policy.yaml)');
  expect(text).toContain('gst.validate_gstin rate limit: 10 per 1m  (domain, domain/policy.yaml)  (not enforced until Phase 2)');
  expect(text).toContain('money: 50 INR  (workflow wf, workflows/wf/policy.yaml)  (not enforced until Phase 2)');
  expect(text).toContain('time: 1h30m  (workflow wf');
});
