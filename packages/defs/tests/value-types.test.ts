import { describe, expect, test } from 'bun:test';
import { formatValueType, parseCount, parseDuration, parseRate, parseValueType, sameValueType, SCALAR_TYPES } from '../src/index.ts';

describe('parseValueType', () => {
  test('every scalar', () => {
    for (const name of SCALAR_TYPES) expect(parseValueType(name)).toEqual({ kind: 'scalar', name });
  });

  test.each([
    ['Identifier(GSTIN)', { kind: 'identifier', scheme: 'GSTIN' }],
    ['Quantity(kg)', { kind: 'quantity', unit: 'kg' }],
    ['Enum[draft, submitted, checked]', { kind: 'enum', values: ['draft', 'submitted', 'checked'] }],
    ['List<Flag>', { kind: 'list', of: { kind: 'named', name: 'Flag' } }],
    ['List<List<Money>>', { kind: 'list', of: { kind: 'list', of: { kind: 'scalar', name: 'Money' } } }],
    ['List<Ref<Customer>>', { kind: 'list', of: { kind: 'ref', entity: 'Customer' } }],
    ['Ref<Customer>', { kind: 'ref', entity: 'Customer' }],
    ['Flag', { kind: 'named', name: 'Flag' }],
  ] as const)('%s parses and round-trips', (src, type) => {
    expect(parseValueType(src)).toEqual(type as never);
    expect(formatValueType(type as never)).toBe(src);
    expect(parseValueType(formatValueType(type as never))).toEqual(type as never);
  });

  test('tolerates spacing', () => {
    expect(parseValueType(' List< Identifier( PAN ) > ')).toEqual({ kind: 'list', of: { kind: 'identifier', scheme: 'PAN' } });
    expect(parseValueType('Enum[ a ,b ]')).toEqual({ kind: 'enum', values: ['a', 'b'] });
  });

  test.each(['', 'List<Flag', 'List<>', 'Ref<>', 'Ref<List<X>>', 'Enum[]', 'Enum[a, a]', 'Enum[a,,b]', 'List', 'Identifier', 'Identifier()', 'Quantity()', 'two words', '9lives'])(
    'rejects %p', (src) => expect(parseValueType(src)).toBeUndefined(),
  );

  test('sameValueType compares structure, enum values as a set', () => {
    const t = (s: string) => parseValueType(s)!;
    expect(sameValueType(t('List<Flag>'), t('List<Flag>'))).toBe(true);
    expect(sameValueType(t('List<Flag>'), t('List<Note>'))).toBe(false);
    expect(sameValueType(t('Enum[a, b]'), t('Enum[b, a]'))).toBe(true);
    expect(sameValueType(t('Identifier(PAN)'), t('Identifier(GSTIN)'))).toBe(false);
    expect(sameValueType(t('Text'), t('PersonName'))).toBe(false);
  });
});

describe('durations, counts and rates', () => {
  test.each([
    ['30s', 30_000], ['10m', 600_000], ['3d', 259_200_000], ['1h30m', 5_400_000], ['250ms', 250],
    ['2w', 1_209_600_000], ['1.5h', 5_400_000], ['1h 30m', 5_400_000], ['500', 500], [1500, 1500], [0, 0],
  ] as const)('parseDuration(%p) = %p', (src, ms) => expect(parseDuration(src)).toBe(ms));

  test.each(['', 'soon', '3 days', '-5s', 'm', '3x', -1, Number.NaN])('parseDuration rejects %p', (src) => {
    expect(parseDuration(src as never)).toBeUndefined();
  });

  test.each([['40k', 40_000], ['1.5m', 1_500_000], ['12', 12], [200000, 200000], ['2K', 2000], ['3M', 3_000_000]] as const)(
    'parseCount(%p) = %p', (src, n) => expect(parseCount(src)).toBe(n),
  );
  test.each(['', 'lots', '40kb', '-3', 'k'])('parseCount rejects %p', (src) => expect(parseCount(src)).toBeUndefined());

  test('parseRate', () => {
    expect(parseRate('30/min')).toEqual({ count: 30, perMs: 60_000 });
    expect(parseRate('100/h')).toEqual({ count: 100, perMs: 3_600_000 });
    expect(parseRate('5/10m')).toEqual({ count: 5, perMs: 600_000 });
    expect(parseRate('1000/day')).toEqual({ count: 1000, perMs: 86_400_000 });
    expect(parseRate('30 per minute')).toBeUndefined();
  });
});
