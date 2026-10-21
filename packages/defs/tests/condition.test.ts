import { expect, test } from 'bun:test';
import { conditionNames, parseCondition } from '../src/condition.ts';

test('guards, invariants and rollup filters parse', () => {
  const g = parseCondition('start_up_pack_complete = 100% and sponsor_approved');
  expect(g.errors).toEqual([]);
  expect(g.names).toEqual(['start_up_pack_complete', 'sponsor_approved']);
  expect(g.ast).toEqual({
    op: 'and',
    left: { op: '=', left: { op: 'name', name: 'start_up_pack_complete', pos: 0 }, right: { op: 'num', value: 100 } },
    right: { op: 'name', name: 'sponsor_approved', pos: 34 },
  });
  const inv = parseCondition("status = 'open' implies principal_investigator is set");
  expect(inv.ast?.op).toBe('implies');
  expect(parseCondition("status in ('filed', 'superseded')").ast?.op).toBe('in');
  expect(parseCondition('days_since(activated_on) > 30').names).toEqual(['activated_on']);
  expect(parseCondition('cv_expires <= today + 30d').ast).toMatchObject({ op: '<=', right: { op: '+', right: { op: 'duration', ms: 30 * 86_400_000 } } });
  expect(parseCondition('not (a or b) and c is not set').names).toEqual(['a', 'b', 'c']);
  expect(parseCondition('record.site_number = "US-012"').names).toEqual(['site_number']);
});

test('problems come back with a position, never thrown', () => {
  expect(parseCondition('').errors[0]!.message).toContain('empty');
  expect(parseCondition('a = ').errors[0]!.message).toContain('ends too early');
  expect(parseCondition("a = 'x").errors[0]!.message).toContain('closing quote');
  expect(parseCondition('frobnicate(a)').errors[0]).toEqual({ message: expect.stringContaining('not a function'), pos: 0 });
  expect(parseCondition('a b').errors[0]!.pos).toBe(2);
  expect(parseCondition('a is maybe').errors[0]!.message).toContain('is set');
  expect(conditionNames(parseCondition('coalesce(x, y) = 1').ast!)).toEqual(['x', 'y']);
});
