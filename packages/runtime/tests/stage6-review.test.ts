/**
 * Stage 6 review fixes, the pure parts: one owner per fact on create (a synced connector's fields
 * other than its keys), and comparing a stored value with what a source says now by field type.
 */
import { describe, expect, test } from 'bun:test';
import { parseValueType, type BindingDef, type EntityTypeDef, type ProjectDefs } from '@memwise/defs';
import { readOnlyFields, syncedOwners } from '../src/domain-tools.ts';
import { argsFrom, sameValue } from '../src/plugins/service.ts';

const RAVE = 'memwise/medidata-rave';
const site = {
  entity: 'Site', domain: 'edc', fields: {
    rave_ref: { type: parseValueType('Text'), typeSource: 'Text' },
    site_number: { type: parseValueType('Text'), typeSource: 'Text' },
    note: { type: parseValueType('Text'), typeSource: 'Text' },
  },
  relationships: {}, ownership: { rave_ref: RAVE, site_number: RAVE },
} as unknown as EntityTypeDef;
const binding = (sync: boolean) => ({
  plugin: RAVE, records: { site: { entity: 'edc.Site', fields: {}, identity: { keys: ['rave_ref'] } } },
  ...(sync ? { sync: { every: '15m', everyMs: 900_000 } } : {}),
}) as unknown as BindingDef;
const project = (sync: boolean) => ({ bindings: { rave: binding(sync) } }) as unknown as ProjectDefs;

describe('one owner per fact on create', () => {
  test('a synced connector keeps its fields; a person may give only the key it matches by', () => {
    const synced = syncedOwners(project(true), 'edc.Site');
    expect([...synced.get(RAVE)!]).toEqual(['rave_ref']);
    const refused = readOnlyFields(site, ['rave_ref', 'site_number', 'note'], { creating: true, synced });
    expect(Object.keys(refused)).toEqual(['site_number']);
    expect(refused.site_number).toContain('read from the memwise/medidata-rave connector');
  });

  test('a connector read through (no sync:) still lets a create give its first values; an update never', () => {
    expect(syncedOwners(project(false), 'edc.Site').size).toBe(0);
    expect(readOnlyFields(site, ['site_number'], { creating: true, synced: syncedOwners(project(false), 'edc.Site') })).toEqual({});
    expect(Object.keys(readOnlyFields(site, ['rave_ref', 'site_number']))).toEqual(['rave_ref', 'site_number']);
  });
});

describe('the same value, by field type', () => {
  const T = (s: string) => parseValueType(s);
  test('"104" and 104 are the same Text; 7 and "7" the same Number', () => {
    expect(sameValue('104', 104, T('Text'))).toBe(true);
    expect(sameValue(104, '104', T('Text'))).toBe(true);
    expect(sameValue(7, '7', T('Number'))).toBe(true);
    expect(sameValue('7', 7, T('Percentage'))).toBe(true);
    expect(sameValue('104', '105', T('Text'))).toBe(false);
  });
  test('dates by day, however written; empties alike', () => {
    expect(sameValue(new Date('2026-09-02T00:00:00Z'), '2026-09-02', T('Date'))).toBe(true);
    expect(sameValue('2026-09-02T00:00:00.000Z', '2026-09-02', T('Date'))).toBe(true);
    expect(sameValue('2026-09-02', '2026-09-03', T('Date'))).toBe(false);
    expect(sameValue(null, '', T('Text'))).toBe(true);
    expect(sameValue(null, 'x', T('Text'))).toBe(false);
  });
});

describe('a project connection as a tool\'s arguments (Part B)', () => {
  const listSites = { type: 'object', properties: { study: { type: 'string' } }, additionalProperties: false };
  test('only what the tool takes: the study, never anything else', () => {
    expect(argsFrom({ study: 'MW-301', mailbox: 'x@example.com', RAVE_PASSWORD: 'no' }, listSites)).toEqual({ study: 'MW-301' });
    expect(argsFrom({ study: '' }, listSites)).toEqual({});
    expect(argsFrom(undefined, listSites)).toEqual({});
    expect(argsFrom({ study: 'MW-301' }, { type: 'object', properties: {} })).toEqual({});
  });
});
