import { expect, test } from 'bun:test';
import {
  PLATFORM_DEFAULTS, checkRateLimit, compilePolicy, describePolicy, mergeStricter, moneyExceeded, rateLimitOf, rateLimitRefusal,
  type RuleOrigin,
} from '../src/index.ts';
import { layer } from './fixtures.ts';

const domain = (doc: Parameters<typeof layer>[2]) => layer('domain', 'domain', doc, 'domain/policy.yaml');
const workflow = (doc: Parameters<typeof layer>[2]) => layer('workflow', 'wf', doc, 'workflows/wf/policy.yaml');
const step = (doc: Parameters<typeof layer>[2]) => layer('step', 'wf/check', doc, 'workflows/wf/steps/check.md');
const D: RuleOrigin = { layer: 'domain', name: 'domain', source: 'domain/policy.yaml' };
const W: RuleOrigin = { layer: 'workflow', name: 'wf', source: 'workflows/wf/policy.yaml' };

test('approvers: absent unless a layer says; intersected tighten-only', () => {
  expect(compilePolicy([PLATFORM_DEFAULTS]).effective.approvers).toBeUndefined();
  const { effective, violations } = compilePolicy([
    PLATFORM_DEFAULTS,
    domain({ approvals: { by: ['manager', 'partner'] } }),
    workflow({ approvals: { by: ['manager', 'staff'] } }),
    step({ approvals: { by: ['manager', 'partner'] } }),
  ]);
  expect(effective.approvers).toEqual({ value: ['manager'], origin: W });
  expect(violations.map((v) => [v.path, v.loosens])).toEqual([['approvals.by', D], ['approvals.by', W]]);
  expect(violations[0]!.message).toContain('lets staff decide approvals');
  expect(describePolicy(effective)).toContain('decided by: manager  (workflow wf, workflows/wf/policy.yaml)');
});

test('approvers: restating the same list keeps the upper origin', () => {
  const { effective, violations } = compilePolicy([domain({ approvals: { by: ['manager'] } }), step({ approvals: { by: ['manager'] } })]);
  expect(effective.approvers).toEqual({ value: ['manager'], origin: D });
  expect(violations).toEqual([]);
});

test('mergeStricter intersects approvals', () => {
  expect(mergeStricter({ approvals: { by: ['a', 'b'] } }, { approvals: { by: ['b', 'c'] } }).approvals).toEqual({ by: ['b'] });
  expect(mergeStricter({ approvals: { by: ['a'] } }, {}).approvals).toEqual({ by: ['a'] });
});

test('rate limit helpers', () => {
  const { effective } = compilePolicy([
    PLATFORM_DEFAULTS, domain({ tools: { rules: { 'gst.validate_gstin': { rateLimit: { count: 10, perMs: 60_000 } } } } }),
  ]);
  const limit = rateLimitOf(effective, 'gst.validate_gstin')!;
  expect(limit).toEqual({ count: 10, perMs: 60_000 });
  expect(rateLimitOf(effective, 'other.tool')).toBeUndefined();
  expect(rateLimitRefusal('gst.validate_gstin', limit)).toBe('rate limit: gst.validate_gstin allows 10 calls per 1m; try later');
  expect(rateLimitRefusal('x.y', { count: 1, perMs: 1000 })).toBe('rate limit: x.y allows 1 call per 1s; try later');
  const now = 1_000_000;
  const nine = Array.from({ length: 9 }, (_, i) => now - i * 1000);
  expect(checkRateLimit(limit, nine, now)).toEqual({ allowed: true, used: 9 });
  expect(checkRateLimit(limit, [...nine, now - 59_000], now)).toEqual({ allowed: false, used: 10 });
  expect(checkRateLimit(limit, [...nine, now - 60_000], now)).toEqual({ allowed: true, used: 9 });
});

test('moneyExceeded compares only within one currency', () => {
  expect(moneyExceeded({ amount: 49.9, currency: 'INR' }, { amount: 50, currency: 'INR' })).toBe(false);
  expect(moneyExceeded({ amount: 50, currency: 'INR' }, { amount: 50, currency: 'INR' })).toBe(true);
  expect(moneyExceeded({ amount: 1, currency: 'USD' }, { amount: 50, currency: 'INR' })).toBeUndefined();
});
