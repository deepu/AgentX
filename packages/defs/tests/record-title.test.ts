// A record's title from its type's `title:` template: no dangling separator for an empty field, and
// no repeated code when the next field already starts with it (Rave's study names carry the code).
import { describe, expect, test } from 'bun:test';
import { fillTitle } from '../src/index.ts';

const fill = (template: string, values: Record<string, unknown>) => fillTitle(template, (f) => values[f]).title;

describe('fillTitle', () => {
  test('fills the fields', () => {
    expect(fill('{site_number} · {name}', { site_number: '101', name: 'Northgate University Hospital' })).toBe('101 · Northgate University Hospital');
  });

  test("doesn't repeat a code the name already starts with", () => {
    const title = 'MW-301: meriglutide once weekly in adults with type 2 diabetes (phase 3)';
    expect(fill('{code} · {title}', { code: 'MW-301', title })).toBe(title);
    expect(fill('{protocol} · {name}', { protocol: 'MW-207', name: 'MW-207 meriglutide in adolescents' })).toBe('MW-207 meriglutide in adolescents');
    expect(fill('{code} · {title}', { code: 'MW-301', title: 'MW-301' })).toBe('MW-301');
  });

  test('keeps a code that is only a prefix of a longer word', () => {
    expect(fill('{code} · {title}', { code: 'MW-3', title: 'MW-301: meriglutide' })).toBe('MW-3 · MW-301: meriglutide');
    expect(fill('{code} · {title}', { code: 'MW', title: 'MWX trial' })).toBe('MW · MWX trial');
  });

  test('an empty field leaves no separator, and counts as not filled', () => {
    expect(fillTitle('{site_number} · {name}', (f) => ({ site_number: 'US-012' } as Record<string, unknown>)[f])).toEqual({ title: 'US-012', fields: 2, filled: 1 });
    expect(fillTitle('{a} · {b}', () => '')).toEqual({ title: '', fields: 2, filled: 0 });
  });
});
