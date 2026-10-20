import { describe, expect, test } from 'bun:test';
import {
  applyTransform, compileRecordMapping, jaroWinkler, matchRecord, nameSimilarity, normaliseKey, parseEntityFile, roundTripProblem,
  type IdentityRules, type RecordBinding, type RecordSourceDef,
} from '../src/index.ts';

const CUSTOMER = parseEntityFile(`entity: Customer
fields:
  name: PersonName
  email: Email
  gstin: Identifier(GSTIN)
  credit_limit: Money
  tier: Enum[gold, silver]
  code: Text
`, 'domain/entities/customer.yaml').value!;

const SOURCE: RecordSourceDef = {
  name: 'contact',
  list: { tool: 'crm.list_contacts', items: 'contacts' },
  key: 'id',
  fields: { id: 'Text', company_name: 'Text', email: 'Text', gst_number: 'Text', limit: 'Number', level: 'Text', first: 'Text', last: 'Text', phone: 'Text' },
};

const BINDING: RecordBinding = {
  entity: 'Customer',
  fields: {
    name: { from: 'company_name', transform: ['trim', 'squash'], direction: 'both' },
    email: { from: 'email', transform: ['trim', 'lower'], direction: 'both' },
    gstin: { from: 'gst_number', transform: ['trim', 'upper'] },
    credit_limit: { from: 'limit', transform: [{ money: 'INR' }], direction: 'write' },
    tier: { from: 'level', transform: [{ map: { G: 'gold', S: 'silver' } }], direction: 'both' },
    code: { transform: [{ template: '{first}-{last}' }], direction: 'both' },
  },
  identity: { keys: ['gstin', 'email'], fuzzy: { field: 'name', auto: 0.95, review: 0.75 } },
};

describe('mappings', () => {
  test('each transform', () => {
    const rec = { first: 'Asha', last: 'Rao' };
    expect(applyTransform('trim', '  a b  ', rec)).toBe('a b');
    expect(applyTransform('lower', 'A@B.COM', rec)).toBe('a@b.com');
    expect(applyTransform('upper', '29aaaca', rec)).toBe('29AAACA');
    expect(applyTransform('digits', '+91 (98) 450-1234', rec)).toBe('91984501234');
    expect(applyTransform('digits', 42.5, rec)).toBe('425');
    expect(applyTransform('squash', 'Acme   Traders \n Ltd', rec)).toBe('Acme Traders Ltd');
    expect(applyTransform('trim', 7, rec)).toBe(7);
    expect(applyTransform({ default: 'n/a' }, '  ', rec)).toBe('n/a');
    expect(applyTransform({ default: 'n/a' }, 'x', rec)).toBe('x');
    expect(applyTransform({ map: { G: 'gold' } }, 'G', rec)).toBe('gold');
    expect(applyTransform({ map: { G: 'gold' } }, 'Z', rec)).toBe('Z');
    expect(applyTransform({ money: 'INR' }, '1,50,000', rec)).toEqual({ amount: 150000, currency: 'INR' });
    expect(applyTransform({ money: 'INR' }, 99, rec)).toEqual({ amount: 99, currency: 'INR' });
    expect(applyTransform({ money: 'INR' }, 'lots', rec)).toBe('lots');
    expect(applyTransform({ template: '{first} {last}' }, undefined, rec)).toBe('Asha Rao');
    expect(applyTransform({ template: '{first} {middle}' }, undefined, rec)).toBe('Asha ');
  });

  test('a record mapped onto the entity: values, extra, errors, round trips', () => {
    const map = compileRecordMapping(BINDING, SOURCE, 'crm', CUSTOMER);
    const record = {
      id: 'c-1', company_name: '  Acme   Traders ', email: ' Asha@Acme.Example ', gst_number: '29aaaca1234a1z5',
      limit: 500000, level: 'G', first: 'A', last: 'R', phone: '+91 98450 12345', notes: { vip: true },
    };
    const out = map(record);
    expect(out).toEqual({
      source: 'contact', externalId: 'c-1', raw: record,
      values: {
        name: 'Acme Traders', email: 'asha@acme.example', gstin: '29AAACA1234A1Z5',
        credit_limit: { amount: 500000, currency: 'INR' }, tier: 'gold', code: 'A-R',
      },
      extra: { 'crm.phone': '+91 98450 12345', 'crm.notes': { vip: true } },
      errors: [],
      roundTrip: ['credit_limit: the money transform can\'t be written back', 'code: the template transform can\'t be written back'],
    });
    // Deterministic: the same record maps the same way.
    expect(map({ id: 'c-1', company_name: 'Acme' })).toEqual(map({ id: 'c-1', company_name: 'Acme' }));
  });

  test('values that do not fit the entity are errors; a record without its key says so', () => {
    const map = compileRecordMapping(BINDING, SOURCE, 'crm', CUSTOMER);
    const out = map({ company_name: 'X', email: 'not-an-email', gst_number: 'nope', level: 'Z' });
    expect(out.externalId).toBe('');
    expect(out.errors).toEqual([
      'the record has no id',
      'email: expected an email address, got "not-an-email"',
      'gstin: `NOPE` is not a valid GSTIN',
      'tier: expected one of gold, silver, got "Z"',
    ]);
    // Without the entity, nothing is validated.
    expect(compileRecordMapping(BINDING, SOURCE, 'crm')({ id: 'x', email: 'bad' }).errors).toEqual([]);
  });

  test('round trips: normalising transforms and one-to-one maps write back; others are noted', () => {
    const rec = { level: 'G', code: 'x', n: '  A  ', d: '12-3' };
    expect(roundTripProblem('name', { from: 'n', transform: ['trim', 'squash', 'upper'] }, 'A', rec)).toBeUndefined();
    expect(roundTripProblem('tier', { from: 'level', transform: [{ map: { G: 'gold', S: 'silver' } }] }, 'gold', rec)).toBeUndefined();
    expect(roundTripProblem('tier', { from: 'level', transform: [{ map: { G: 'gold', H: 'gold' } }] }, 'gold', rec)).toBe('tier: the map is not one-to-one, so it can\'t be written back');
    expect(roundTripProblem('d', { from: 'd', transform: ['digits'] }, '123', rec)).toBe('d: digits can\'t be written back (the other characters are lost)');
    expect(roundTripProblem('d', { from: 'd', transform: [{ default: '0' }] }, '0', rec)).toBe('d: the default transform can\'t be written back');
  });
});

describe('identity matching', () => {
  const rules: IdentityRules = { keys: ['gstin', 'email'], fuzzy: { field: 'name', auto: 0.95, review: 0.75 } };
  const rows = [
    { id: 'cust_1', values: { name: 'Acme Traders Pvt Ltd', gstin: '29AAACA1234A1Z5', email: 'ops@acme.example' } },
    { id: 'cust_2', values: { name: 'Menon Exports LLP', gstin: '27AAACM1234M1Z2', email: 'ravi@menon.example' } },
    { id: 'cust_3', values: { name: 'Globex Corporation', email: 'hi@globex.example' } },
  ];

  test('normalised keys and name similarity', () => {
    expect(normaliseKey('  29aaa CA1234 ')).toBe('29aaaca1234');
    expect(normaliseKey(42)).toBe('42');
    expect(normaliseKey(null)).toBe('');
    expect(nameSimilarity('Acme Ltd', 'ACME Limited')).toBe(1);
    expect(nameSimilarity('Traders Acme Pvt. Ltd.', 'acme traders')).toBe(1);
    expect(nameSimilarity('Acme Traders', 'Acme Trading')).toBeCloseTo(0.9, 5);
    expect(nameSimilarity('Globex Corp', 'Globex Corporation')).toBe(1);
    expect(nameSimilarity('Acme Traders', 'Zenith Foods')).toBeLessThan(0.6);
    expect(nameSimilarity('', 'x')).toBe(0);
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.9611, 3);
    expect(jaroWinkler('dixon', 'dicksonx')).toBeCloseTo(0.8133, 3);
  });

  test('a key match links', () => {
    expect(matchRecord({ name: 'ACME', gstin: '29aaaca1234a1z5' }, rows, rules)).toEqual({ recordId: 'cust_1', score: 1, method: 'key', verdict: 'link', reasons: ['same GSTIN'] });
    expect(matchRecord({ gstin: '29AAACA1234A1Z5', email: 'OPS@acme.example ' }, rows, rules).reasons).toEqual(['same GSTIN', 'same email']);
  });

  test('keys pointing at two records go to a person', () => {
    const m = matchRecord({ gstin: '29AAACA1234A1Z5', email: 'ravi@menon.example' }, rows, rules);
    expect(m).toEqual({ recordId: 'cust_1', score: 1, method: 'key', verdict: 'review', reasons: ['same GSTIN', 'but cust_2 matches too'] });
  });

  test('fuzzy: auto-links, asks, or finds nothing; a differing key caps below auto', () => {
    expect(matchRecord({ name: 'Globx Corp' }, rows, rules)).toMatchObject({ recordId: 'cust_3', verdict: 'link', method: 'fuzzy', reasons: ['name 0.97 similar'] });
    expect(matchRecord({ name: 'Acme Traders Limited' }, rows, rules)).toMatchObject({ recordId: 'cust_1', score: 1, verdict: 'link', reasons: ['same name'] });
    const capped = matchRecord({ name: 'Acme Traders', gstin: '29AAACA9999A1Z5' }, rows, rules);
    expect(capped).toEqual({ recordId: 'cust_1', score: 0.94, method: 'fuzzy', verdict: 'review', reasons: ['same name', 'different GSTIN'] });
    const near = matchRecord({ name: 'Menon Export House' }, rows, rules);
    expect(near.verdict).toBe('review');
    expect(near.recordId).toBe('cust_2');
    expect(near.reasons[0]).toMatch(/^name 0\.\d\d similar$/);
    expect(matchRecord({ name: 'Zenith Foods' }, rows, rules)).toEqual({ score: 0.515, verdict: 'none', reasons: ['closest: name 0.51 similar'] });
    expect(matchRecord({ name: 'Acme' }, rows, { keys: ['gstin'] })).toEqual({ score: 0, verdict: 'none', reasons: ['no record with the same GSTIN'] });
    expect(matchRecord({ name: 'Acme' }, [], rules)).toEqual({ score: 0, verdict: 'none', reasons: ['no record with a similar name'] });
  });
});
