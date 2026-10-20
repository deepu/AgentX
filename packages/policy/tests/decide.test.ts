import { describe, expect, test } from 'bun:test';
import { EFFECT_CLASSES } from '@memwise/defs';
import { PLATFORM_DEFAULTS, compilePolicy, decide, type PolicyRequest, type RuleOrigin } from '../src/index.ts';
import { layer } from './fixtures.ts';

const platform: RuleOrigin = { layer: 'platform', name: 'platform' };
const D: RuleOrigin = { layer: 'domain', name: 'domain', source: 'domain/policy.yaml' };
const S: RuleOrigin = { layer: 'step', name: 'wf/check' };

const req = (tool: string, effect: PolicyRequest['effect'], over: Partial<PolicyRequest> = {}): PolicyRequest =>
  ({ tool, effect, classified: true, tainted: false, ...over });

const { effective } = compilePolicy([
  PLATFORM_DEFAULTS,
  layer('domain', 'domain', {
    effects: { write: 'preview', irreversible: 'deny' },
    tools: { deny: ['payments.transfer'], rules: { 'crm.lookup': { treatment: 'approve' } } },
  }, 'domain/policy.yaml'),
]);

describe('decide', () => {
  test('each effect class takes its treatment, with its origin', () => {
    const verdicts = EFFECT_CLASSES.map((effect) => {
      const d = decide(effective, req('t', effect));
      return [effect, d.verdict, d.origins];
    });
    expect(verdicts).toEqual([
      ['read', 'allow', [platform]],
      ['draft', 'allow', [platform]],
      ['write', 'preview', [D]],
      ['outbound', 'approve', [platform]],
      ['irreversible', 'deny', [D]],
    ]);
    expect(decide(effective, req('crm.save', 'write')).reason).toBe(
      'crm.save (write) runs with a recorded preview: write tools: preview from domain, domain/policy.yaml.',
    );
  });

  test('a denied tool is denied whatever its class', () => {
    const d = decide(effective, req('payments.transfer', 'read'));
    expect(d).toEqual({ verdict: 'deny', reason: 'payments.transfer is denied by domain, domain/policy.yaml.', origins: [D] });
  });

  test('a tool outside the allow list is denied', () => {
    const { effective: e } = compilePolicy([PLATFORM_DEFAULTS, layer('step', 'wf/check', { tools: { allow: ['a'] } })]);
    expect(decide(e, req('a', 'read')).verdict).toBe('allow');
    const d = decide(e, req('b', 'read'));
    expect(d.verdict).toBe('deny');
    expect(d.origins).toEqual([S]);
    expect(d.reason).toContain('not in the allowed tools');
  });

  test('built-in tools are always allowed', () => {
    const { effective: e } = compilePolicy([PLATFORM_DEFAULTS, layer('step', 'wf/check', { tools: { allow: [] } })]);
    for (const tool of ['step.finish', 'checkpoint.verdict']) {
      const d = decide(e, req(tool, 'irreversible', { classified: false, tainted: true }));
      expect(d.verdict).toBe('allow');
      expect(d.origins).toEqual([platform]);
    }
    expect(decide(e, req('recall.step_record', 'read')).verdict).toBe('deny');
  });

  test('a per-tool rule tightens its class treatment but never loosens it', () => {
    expect(decide(effective, req('crm.lookup', 'read'))).toMatchObject({ verdict: 'approve', origins: [D] });
    const { effective: e } = compilePolicy([PLATFORM_DEFAULTS, layer('domain', 'domain', { tools: { rules: { mail: { treatment: 'allow' } } } })]);
    expect(decide(e, req('mail', 'outbound')).verdict).toBe('approve');
  });

  test('taint raises outbound and irreversible calls only', () => {
    // No platform layer, so outbound may start at preview.
    const { effective: e } = compilePolicy([
      layer('domain', 'domain', { effects: { outbound: 'preview' }, taint: { outboundWhenTainted: 'approve' } }, 'domain/policy.yaml'),
    ]);
    expect(decide(e, req('mail', 'outbound')).verdict).toBe('preview');
    const tainted = decide(e, req('mail', 'outbound', { tainted: true }));
    expect(tainted.verdict).toBe('approve');
    expect(tainted.origins).toEqual([D]);
    expect(tainted.reason).toContain('a tainted session');
    expect(decide(e, req('save', 'write', { tainted: true })).verdict).toBe('allow');
  });

  test('every rule that reaches the verdict is an origin', () => {
    const d = decide(compilePolicy([PLATFORM_DEFAULTS]).effective, req('mail', 'outbound', { tainted: true }));
    expect(d.verdict).toBe('approve');
    expect(d.origins).toEqual([platform, platform]);
  });

  test('taint switched off is ignored', () => {
    const { effective: e } = compilePolicy([
      layer('plugin', 'p', { effects: { outbound: 'allow' }, taint: { enabled: false, outboundWhenTainted: 'deny' } }),
    ]);
    expect(decide(e, req('mail', 'outbound', { tainted: true })).verdict).toBe('allow');
  });

  test('an unclassified tool is treated as irreversible and says so', () => {
    const d = decide(compilePolicy([PLATFORM_DEFAULTS]).effective, req('mystery.do', 'irreversible', { classified: false }));
    expect(d.verdict).toBe('approve');
    expect(d.reason).toContain('unclassified tool, treated as irreversible');
  });
});
