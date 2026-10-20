import { describe, expect, test } from 'bun:test';
import { effectFromAnnotations, redactSecrets, resolveEffect, validateArgs } from '../src/index.ts';

describe('resolveEffect', () => {
  test('declared class', () => {
    expect(resolveEffect({ effect: 'outbound' }, {})).toEqual({ effect: 'outbound', classified: true });
  });

  test('class as a function of the arguments', () => {
    const http = { effect: (a: { method: string }) => (a.method === 'GET' ? 'read' as const : 'outbound' as const) };
    expect(resolveEffect(http, { method: 'GET' })).toEqual({ effect: 'read', classified: true });
    expect(resolveEffect(http, { method: 'POST' })).toEqual({ effect: 'outbound', classified: true });
  });

  test('undeclared is irreversible and unclassified (D29), annotations notwithstanding', () => {
    expect(resolveEffect({}, {})).toEqual({ effect: 'irreversible', classified: false });
  });

  test('a function that throws or returns nonsense falls back to irreversible', () => {
    expect(resolveEffect({ effect: () => { throw new Error('x'); } }, {})).toEqual({ effect: 'irreversible', classified: false });
    expect(resolveEffect({ effect: (() => 'delete') as never }, {})).toEqual({ effect: 'irreversible', classified: false });
  });
});

describe('effectFromAnnotations', () => {
  test('maps explicit hints conservatively', () => {
    expect(effectFromAnnotations(undefined)).toBeUndefined();
    expect(effectFromAnnotations({})).toBeUndefined();
    expect(effectFromAnnotations({ readOnlyHint: true })).toBe('read');
    expect(effectFromAnnotations({ readOnlyHint: true, openWorldHint: true })).toBe('read');
    expect(effectFromAnnotations({ destructiveHint: true })).toBe('irreversible');
    expect(effectFromAnnotations({ readOnlyHint: true, destructiveHint: true })).toBe('irreversible');
    expect(effectFromAnnotations({ openWorldHint: true })).toBe('outbound');
    expect(effectFromAnnotations({ readOnlyHint: false, destructiveHint: false, openWorldHint: false })).toBeUndefined();
  });
});

describe('validateArgs', () => {
  const schema = {
    type: 'object',
    properties: { gstin: { type: 'string' }, amount: { type: 'number' }, count: { type: 'integer' }, tags: { type: 'array' } },
    required: ['gstin'],
  };

  test('passes valid arguments', () => {
    expect(validateArgs(schema, { gstin: '27AAA', amount: 1.5, count: 2, tags: [] })).toEqual([]);
  });

  test('reports missing keys and wrong top-level types', () => {
    expect(validateArgs(schema, { amount: '12', count: 1.5 })).toEqual([
      'missing required "gstin"', '"amount" must be number (got string)', '"count" must be integer (got number)',
    ]);
    expect(validateArgs(schema, 'x')).toEqual(['arguments must be an object (got string)']);
  });

  test('an empty schema accepts anything', () => {
    expect(validateArgs({}, 42)).toEqual([]);
  });
});

describe('redactSecrets', () => {
  test('replaces every occurrence at any depth', () => {
    const out = redactSecrets({ msg: 'key sk-123 rejected', nested: [{ k: 'sk-123' }], n: 1 }, ['sk-123']);
    expect(out).toEqual({ msg: 'key [secret] rejected', nested: [{ k: '[secret]' }], n: 1 });
  });

  test('class instances are flattened so no field escapes', () => {
    class Res { constructor(public token = 'sk-123') {} }
    expect(redactSecrets(new Res(), ['sk-123'])).toEqual({ token: '[secret]' } as never);
  });
});
