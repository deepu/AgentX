// The public form (23 §4): what a participant sees of an external step. Only the step's writes
// (as fields, with the current case values as defaults), the comments returned to the step, the
// link's note, and who is asking. Field kinds come from value types, so the page never parses them.
import {
  IDENTIFIER_PATTERNS, type CaseValue, type ExternalComment, type ExternalDocument, type ExternalFieldKind, type ExternalForm,
  type ExternalFormField, type ExtractSuggestion, type StepDef, type ValueType, type WriteDef,
} from '@memwise/defs';
import type { DocumentValue } from '../types.ts';
import type { StoredSuggestion } from './links.ts';
import { compact, plainLabel } from './text.ts';

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_FILES = 20;
export const ACCEPTED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'text/plain'];

/** A placeholder per identifier scheme with a known format. */
const PLACEHOLDERS: Record<string, string> = { PAN: 'AAACA1234A', GSTIN: '29AAACA1234A1Z5' };

const LONG_TEXT = /(message|note|notes|comment|description|details|address|reason)$/;

/** The kind a value type is shown as, or undefined when the public form can't take it (records, refs). */
export function fieldKind(name: string, t: ValueType): ExternalFieldKind | undefined {
  switch (t.kind) {
    case 'scalar':
      switch (t.name) {
        case 'Text': return LONG_TEXT.test(name) ? 'longtext' : 'text';
        case 'PersonName': return 'text';
        case 'Address': return 'longtext';
        case 'Email': return 'email';
        case 'Phone': return 'phone';
        case 'Number': case 'Percentage': return 'number';
        case 'Money': return 'money';
        case 'Date': return 'date';
        case 'Boolean': return 'boolean';
        case 'Document': case 'File': case 'Image': return 'document';
        default: return undefined;
      }
    case 'identifier': return 'identifier';
    case 'enum': return 'enum';
    case 'quantity': return 'number';
    case 'list': return fieldKind(name, t.of) === 'document' ? 'documents' : undefined;
    default: return undefined;
  }
}

/** A stored document as the form shows it (no hash). */
export const formDocument = (d: DocumentValue | ExternalDocument): ExternalDocument => ({ id: d.id, name: d.name, mime: d.mime, size: d.size });

function formValue(kind: ExternalFieldKind, value: unknown): unknown {
  if (kind === 'document') return value && typeof value === 'object' && 'id' in (value as object) ? formDocument(value as DocumentValue) : undefined;
  if (kind === 'documents') {
    return Array.isArray(value) ? value.filter((d) => d && typeof d === 'object' && 'id' in d).map((d) => formDocument(d as DocumentValue)) : undefined;
  }
  return value;
}

export interface FormInput {
  step: StepDef;
  business: string;
  participant: { name?: string };
  /** Current case values of the step's writes (other fields are never read). */
  values: Record<string, CaseValue | undefined>;
  draft?: Record<string, unknown> | null;
  draftSavedAt?: string;
  comments: ExternalComment[];
  suggestions: StoredSuggestion[];
  expiresAt: string;
  /** Money fields' currency when the case has none yet. */
  defaultCurrency?: string;
}

export function formFields(step: StepDef, input: Pick<FormInput, 'values' | 'draft' | 'suggestions' | 'defaultCurrency'>): ExternalFormField[] {
  const fields: ExternalFormField[] = [];
  for (const [name, w] of Object.entries(step.writes)) {
    const field = formField(name, w, input);
    if (field) fields.push(field);
  }
  return fields;
}

function formField(name: string, w: WriteDef, input: Pick<FormInput, 'values' | 'draft' | 'suggestions' | 'defaultCurrency'>): ExternalFormField | undefined {
  const kind = fieldKind(name, w.type);
  if (!kind) return undefined;
  const t = w.type;
  const field: ExternalFormField = { name, label: plainLabel(name), kind, required: w.required === true };
  if (t.kind === 'identifier') {
    const pattern = IDENTIFIER_PATTERNS[t.scheme.toUpperCase()];
    if (pattern) field.pattern = pattern.source;
    field.upperCase = true;
    const placeholder = PLACEHOLDERS[t.scheme.toUpperCase()];
    if (placeholder) field.placeholder = placeholder;
    if (field.label.toLowerCase() === t.scheme.toLowerCase()) field.label = t.scheme.toUpperCase();
  }
  if (t.kind === 'enum') field.options = t.values.map((v) => ({ value: v, label: plainLabel(v) }));
  if (kind === 'email') field.placeholder = 'name@example.com';
  const current = input.values[name];
  if (kind === 'money') {
    const c = (current?.value as { currency?: string } | undefined)?.currency;
    field.currency = c ?? input.defaultCurrency ?? process.env.MEMWISE_CURRENCY ?? 'INR';
  }
  const draft = input.draft && Object.hasOwn(input.draft, name) ? input.draft[name] : undefined;
  const suggested = [...input.suggestions].reverse().find((s) => s.field === name && s.prefill);
  if (draft !== undefined && draft !== null) {
    Object.assign(field, { value: draft, source: { kind: 'draft' } });
  } else if (current !== undefined && current.value !== null && current.value !== undefined) {
    const value = formValue(kind, current.value);
    if (value !== undefined) Object.assign(field, { value, source: { kind: 'case' } });
  } else if (suggested) {
    Object.assign(field, { value: suggested.value, source: { kind: 'extracted', suggestionId: suggested.id, document: suggested.document, confidence: suggested.confidence } });
  }
  return field;
}

/** What the form shows of a stored suggestion. */
export const formSuggestion = ({ tool: _t, callId: _c, stepRunId: _s, ...s }: StoredSuggestion): ExtractSuggestion => s;

export function buildForm(input: FormInput): ExternalForm {
  const { step } = input;
  const x = step.extract;
  return compact({
    status: 'open' as const,
    business: input.business,
    title: step.title,
    instructions: step.instructions,
    participant: compact({ name: input.participant.name }),
    fields: formFields(step, input),
    comments: [...input.comments].sort((a, b) => a.at.localeCompare(b.at)),
    outcomes: step.outcomes.map((id) => ({ id, label: plainLabel(id) })),
    extract: x ? { documentsField: x.documents, fields: [...new Set(Object.values(x.fields))], minConfidence: x.minConfidence } : undefined,
    suggestions: input.suggestions.map(formSuggestion),
    draftSavedAt: input.draftSavedAt,
    expiresAt: input.expiresAt,
    limits: { maxFileBytes: MAX_FILE_BYTES, maxFiles: MAX_FILES, accept: [...ACCEPTED_TYPES] },
  }) as ExternalForm;
}

/**
 * The type of an upload from its first bytes (23 §3: by content, not by name): PDF, JPEG, PNG,
 * HEIC/HEIF, WebP, or plain text (UTF-8 without control characters). Undefined: not accepted.
 */
export function sniffType(data: Uint8Array): string | undefined {
  const at = (i: number, ...bytes: number[]) => bytes.every((b, j) => data[i + j] === b);
  const ascii = (i: number, s: string) => at(i, ...[...s].map((c) => c.charCodeAt(0)));
  if (ascii(0, '%PDF-')) return 'application/pdf';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(4, 'ftyp')) {
    const brand = String.fromCharCode(...data.slice(8, 12));
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis'].includes(brand)) return 'image/heic';
    if (['mif1', 'msf1', 'heif'].includes(brand)) return 'image/heif';
  }
  if (!data.length) return undefined;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    // Text: no control characters other than tab, line breaks and form feed.
    if (!/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) return 'text/plain';
  } catch { /* not UTF-8 */ }
  return undefined;
}
