/**
 * Checking a value against its type, and the JSON Schema of a type (what the step engine
 * gives the model for `step.finish`). The two agree: a value the schema accepts passes
 * `validateValue`, apart from checks JSON Schema can't express (real calendar dates).
 */
import type { FieldDef, ValueType } from './types.ts';
import { formatValueType, parseDuration } from './value-types.ts';

/** Record types by name: the case file's `types:`, plus entity types when a field names one. */
export type RecordTypes = Record<string, { fields: Record<string, FieldDef> }>;

/** Identifier schemes with a known format. Other schemes only need a non-empty string. */
export const IDENTIFIER_PATTERNS: Record<string, RegExp> = {
  GSTIN: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/,
  PAN: /^[A-Z]{5}[0-9]{4}[A-Z]$/,
};

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9][0-9 ().-]{3,}$/;
const CURRENCY = /^[A-Z]{3}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const describe = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v === 'object' ? 'an object' : JSON.stringify(v));

function validDate(s: string): boolean {
  const m = DATE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}

/** Errors for `value` against `type`, each prefixed with where in the value it is (`flags[0].document: ...`). */
export function validateValue(type: ValueType, value: unknown, recordTypes: RecordTypes = {}): string[] {
  const errors: string[] = [];
  check(type, value, '', recordTypes, errors);
  return errors;
}

function check(type: ValueType, v: unknown, at: string, records: RecordTypes, errors: string[]): void {
  const fail = (msg: string): void => { errors.push(at ? `${at}: ${msg}` : msg); };
  const expected = (what: string): void => fail(`expected ${what}, got ${describe(v)}`);

  switch (type.kind) {
    case 'scalar':
      switch (type.name) {
        case 'Text': case 'PersonName':
          if (typeof v !== 'string') expected('text');
          return;
        case 'Address':
          if (typeof v !== 'string' && !isObject(v)) expected('an address (text or an object)');
          return;
        case 'Number': case 'Percentage':
          if (!isNumber(v)) expected('a number');
          return;
        case 'Boolean':
          if (typeof v !== 'boolean') expected('true or false');
          return;
        case 'Money':
          if (!isObject(v)) return expected('money as { amount, currency }');
          if (!isNumber(v.amount)) fail('amount must be a number');
          if (typeof v.currency !== 'string' || !CURRENCY.test(v.currency)) fail('currency must be a 3-letter ISO code like INR');
          for (const k of Object.keys(v)) if (k !== 'amount' && k !== 'currency') fail(`unexpected key \`${k}\` in money`);
          return;
        case 'Date':
          if (typeof v !== 'string' || !validDate(v)) expected('a date like 2026-10-20');
          return;
        case 'DateTime':
          if (typeof v !== 'string' || !DATE_TIME.test(v) || Number.isNaN(Date.parse(v)) || !validDate(v.slice(0, 10))) {
            expected('a date and time with a zone, like 2026-10-20T09:30:00+05:30');
          }
          return;
        case 'Duration':
          if ((typeof v !== 'string' && typeof v !== 'number') || parseDuration(v) === undefined) expected('a duration like 3d or 1h30m, or milliseconds');
          return;
        case 'Email':
          if (typeof v !== 'string' || !EMAIL.test(v)) expected('an email address');
          return;
        case 'Phone':
          if (typeof v !== 'string' || !PHONE.test(v)) expected('a phone number');
          return;
        case 'File': case 'Image': case 'Document':
          if (typeof v === 'string' ? v === '' : !(isObject(v) && typeof v.name === 'string' && v.name !== '')) {
            expected(`a ${type.name.toLowerCase()} (its name, or an object with a name)`);
          }
          return;
        case 'TimeSeries':
          if (!Array.isArray(v)) return expected('a list of { time, value } points');
          v.forEach((p, i) => {
            const ok = isObject(p) && (typeof p.time === 'string' || isNumber(p.time)) && isNumber(p.value);
            if (!ok) errors.push(`${at}[${i}]: expected a point { time, value }`);
          });
          return;
      }
      return;
    case 'identifier': {
      if (typeof v !== 'string' || v.trim() === '') return expected(`a ${type.scheme} identifier`);
      const pattern = IDENTIFIER_PATTERNS[type.scheme.toUpperCase()];
      if (pattern && !pattern.test(v)) fail(`\`${v}\` is not a valid ${type.scheme}`);
      return;
    }
    case 'quantity':
      if (isNumber(v)) return;
      if (isObject(v) && isNumber(v.value) && (v.unit === undefined || v.unit === type.unit)) return;
      return expected(`a quantity in ${type.unit}`);
    case 'enum':
      if (typeof v !== 'string' || !type.values.includes(v)) expected(`one of ${type.values.join(', ')}`);
      return;
    case 'list':
      if (!Array.isArray(v)) return expected('a list');
      v.forEach((item, i) => check(type.of, item, `${at}[${i}]`, records, errors));
      return;
    case 'ref':
      if (typeof v !== 'string' || v === '') expected(`the id of a ${type.entity}`);
      return;
    case 'named': {
      const record = records[type.name];
      if (!record) return fail(`unknown type ${type.name}`);
      if (!isObject(v)) return expected(`a ${type.name}`);
      const prefix = at ? `${at}.` : '';
      for (const [name, field] of Object.entries(record.fields)) {
        const fv = v[name];
        if (fv === undefined || fv === null) {
          if (field.required) errors.push(`${prefix}${name}: required`);
        } else check(field.type, fv, `${prefix}${name}`, records, errors);
      }
      for (const k of Object.keys(v)) if (!(k in record.fields)) errors.push(`${prefix}${k}: not a field of ${type.name}`);
      return;
    }
  }
}

type JsonSchema = Record<string, unknown>;

/** JSON Schema for a value of `type`. Record types are inlined; a record that contains itself stops at `{ type: object }`. */
export function valueTypeToJsonSchema(type: ValueType, recordTypes: RecordTypes = {}, seen: string[] = []): JsonSchema {
  const documentRef = { anyOf: [{ type: 'string', minLength: 1 }, { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'] }] };
  switch (type.kind) {
    case 'scalar':
      switch (type.name) {
        case 'Text': return { type: 'string' };
        case 'PersonName': return { type: 'string', description: "A person's name." };
        case 'Address': return { anyOf: [{ type: 'string' }, { type: 'object' }], description: 'A postal address.' };
        case 'Number': return { type: 'number' };
        case 'Percentage': return { type: 'number', description: 'A percentage.' };
        case 'Boolean': return { type: 'boolean' };
        case 'Money': return {
          type: 'object',
          properties: { amount: { type: 'number' }, currency: { type: 'string', pattern: CURRENCY.source, description: 'ISO 4217 code, e.g. INR.' } },
          required: ['amount', 'currency'],
          additionalProperties: false,
        };
        case 'Date': return { type: 'string', format: 'date' };
        case 'DateTime': return { type: 'string', format: 'date-time', description: 'ISO 8601 with a zone.' };
        case 'Duration': return { anyOf: [{ type: 'string', description: 'e.g. 3d, 1h30m' }, { type: 'number', minimum: 0, description: 'milliseconds' }] };
        case 'Email': return { type: 'string', format: 'email' };
        case 'Phone': return { type: 'string', description: 'A phone number.' };
        case 'File': case 'Image': case 'Document': return { ...documentRef, description: `A ${type.name.toLowerCase()}: its name, or an object with a name.` };
        case 'TimeSeries': return {
          type: 'array',
          items: { type: 'object', properties: { time: { type: ['string', 'number'] }, value: { type: 'number' } }, required: ['time', 'value'] },
        };
      }
      return {};
    case 'identifier': {
      const pattern = IDENTIFIER_PATTERNS[type.scheme.toUpperCase()];
      return { type: 'string', minLength: 1, ...(pattern ? { pattern: pattern.source } : {}), description: `${type.scheme} identifier.` };
    }
    case 'quantity': return { type: 'number', description: `Quantity in ${type.unit}.` };
    case 'enum': return { type: 'string', enum: [...type.values] };
    case 'list': return { type: 'array', items: valueTypeToJsonSchema(type.of, recordTypes, seen) };
    case 'ref': return { type: 'string', minLength: 1, description: `The id of a ${type.entity}.` };
    case 'named': {
      const record = recordTypes[type.name];
      if (!record || seen.includes(type.name)) return { type: 'object', description: formatValueType(type) };
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [name, field] of Object.entries(record.fields)) {
        properties[name] = {
          ...valueTypeToJsonSchema(field.type, recordTypes, [...seen, type.name]),
          ...(field.description ? { description: field.description } : {}),
        };
        if (field.required) required.push(name);
      }
      return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
    }
  }
}
