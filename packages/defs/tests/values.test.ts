import { describe, expect, test } from 'bun:test';
import { parseValueType, validateValue, valueTypeToJsonSchema, type RecordTypes } from '../src/index.ts';

const t = (s: string) => parseValueType(s)!;
const records: RecordTypes = {
  Flag: {
    fields: {
      field: { type: t('Text'), typeSource: 'Text', required: true },
      problem: { type: t('Text'), typeSource: 'Text' },
      document: { type: t('Document'), typeSource: 'Document' },
    },
  },
};
const ok = (type: string, value: unknown) => expect(validateValue(t(type), value, records)).toEqual([]);
const bad = (type: string, value: unknown) => expect(validateValue(t(type), value, records)).not.toEqual([]);

describe('validateValue', () => {
  test('scalars', () => {
    ok('Text', 'hi'); bad('Text', 3);
    ok('Number', 3.5); bad('Number', '3'); bad('Number', Number.NaN);
    ok('Boolean', false); bad('Boolean', 'false');
    ok('Percentage', 12.5);
    ok('PersonName', 'Asha Rao');
    ok('Phone', '+91 98765 43210'); bad('Phone', 'call me');
    ok('Address', '1 Main St'); ok('Address', { line1: '1 Main St' }); bad('Address', 7);
    ok('Duration', '3d'); ok('Duration', 5000); bad('Duration', 'soon');
    ok('TimeSeries', [{ time: '2026-01-01', value: 3 }]); bad('TimeSeries', [{ time: '2026-01-01' }]);
  });

  test('Money is { amount, currency }', () => {
    ok('Money', { amount: 42000000, currency: 'INR' });
    expect(validateValue(t('Money'), 42)).toEqual(['expected money as { amount, currency }, got 42']);
    expect(validateValue(t('Money'), { amount: '5', currency: 'rupees' })).toEqual(['amount must be a number', 'currency must be a 3-letter ISO code like INR']);
    bad('Money', { amount: 5, currency: 'INR', note: 'x' });
  });

  test('dates and times', () => {
    ok('Date', '2026-02-28'); bad('Date', '2026-02-30'); bad('Date', '28/02/2026'); bad('Date', '2026-02-28T00:00:00Z');
    ok('DateTime', '2026-10-20T09:30:00+05:30'); ok('DateTime', '2026-10-20T04:00:00.123Z');
    bad('DateTime', '2026-10-20T09:30:00'); bad('DateTime', '2026-10-20');
  });

  test('Email', () => {
    ok('Email', 'asha@acme-traders.example'); bad('Email', 'asha'); bad('Email', 'a b@c.d');
  });

  test('identifiers: GSTIN and PAN have formats, others need a non-empty string', () => {
    ok('Identifier(GSTIN)', '29AAACA1234A1Z5');
    expect(validateValue(t('Identifier(GSTIN)'), '29AAACA1234A1X5')).toEqual(['`29AAACA1234A1X5` is not a valid GSTIN']);
    bad('Identifier(GSTIN)', '29AAACA1234A0Z5');
    ok('Identifier(PAN)', 'AAACA1234A'); bad('Identifier(PAN)', 'AAACA1234'); bad('Identifier(PAN)', 'aaaca1234a');
    ok('Identifier(VAT)', 'anything'); bad('Identifier(VAT)', ''); bad('Identifier(VAT)', 12);
  });

  test('files and documents: a name, or an object with a name', () => {
    ok('Document', 'pan-card.pdf'); ok('Document', { name: 'pan-card.pdf', kind: 'pan_card' }); ok('Image', 'x.png');
    bad('Document', ''); bad('File', { kind: 'pan_card' }); bad('File', 3);
  });

  test('quantity, enum, ref', () => {
    ok('Quantity(kg)', 3); ok('Quantity(kg)', { value: 3, unit: 'kg' }); bad('Quantity(kg)', { value: 3, unit: 'lb' });
    ok('Enum[draft, checked]', 'draft'); bad('Enum[draft, checked]', 'approved');
    ok('Ref<Customer>', 'cust_1'); bad('Ref<Customer>', ''); bad('Ref<Customer>', { id: 'x' });
  });

  test('lists and records, with paths in the messages', () => {
    ok('List<Flag>', []);
    ok('List<Flag>', [{ field: 'pan', problem: 'mismatch', document: 'pan-card.pdf' }]);
    expect(validateValue(t('List<Flag>'), [{ field: 'pan' }, { problem: 3, extra: true }], records)).toEqual([
      '[1].field: required',
      '[1].problem: expected text, got 3',
      '[1].extra: not a field of Flag',
    ]);
    expect(validateValue(t('List<List<Number>>'), [[1], [2, 'x']])).toEqual(['[1][1]: expected a number, got "x"']);
    expect(validateValue(t('Flag'), 'pan', records)).toEqual(['expected a Flag, got "pan"']);
    expect(validateValue(t('Unknown'), {}, records)).toEqual(['unknown type Unknown']);
    bad('List<Text>', 'not a list');
  });
});

describe('valueTypeToJsonSchema', () => {
  test('the step.finish schema for the check step writes', () => {
    expect(valueTypeToJsonSchema(t('List<Flag>'), records)).toEqual({
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string' },
          problem: { type: 'string' },
          document: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'] }], description: 'A document: its name, or an object with a name.' },
        },
        required: ['field'],
        additionalProperties: false,
      },
    });
    expect(valueTypeToJsonSchema(t('Boolean'))).toEqual({ type: 'boolean' });
    expect(valueTypeToJsonSchema(t('Enum[a, b]'))).toEqual({ type: 'string', enum: ['a', 'b'] });
    expect(valueTypeToJsonSchema(t('Identifier(PAN)'))).toMatchObject({ type: 'string', pattern: '^[A-Z]{5}[0-9]{4}[A-Z]$' });
    expect(valueTypeToJsonSchema(t('Money'))).toMatchObject({ type: 'object', required: ['amount', 'currency'] });
    expect(valueTypeToJsonSchema(t('Ref<Customer>'))).toMatchObject({ type: 'string' });
    expect(valueTypeToJsonSchema(t('Date'))).toEqual({ type: 'string', format: 'date' });
  });

  test('a record that contains itself does not recurse forever', () => {
    const tree: RecordTypes = { Node: { fields: { children: { type: t('List<Node>'), typeSource: 'List<Node>' } } } };
    expect(valueTypeToJsonSchema(t('Node'), tree)).toEqual({
      type: 'object',
      properties: { children: { type: 'array', items: { type: 'object', description: 'Node' } } },
      additionalProperties: false,
    });
  });
});
