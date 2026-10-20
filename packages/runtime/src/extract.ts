// `intake.extract_fields` on quarantined reading (19 §5, D21): each uploaded document is read
// as data by the `extractor` model role with no tools, and only a JSON object of the requested
// fields is accepted. Results are tainted (the tool is `quarantine`), so the session and every
// value taken from them are marked.
import { inflateSync } from 'node:zlib';
import type { CaseSnapshot } from '@memwise/defs';
import type { ToolDefinition } from '@memwise/gateway';
import type { DocumentValue } from './types.ts';

export const EXTRACT_TOOL = 'intake.extract_fields';
export const EXTRACTOR_ROLE = 'extractor';

/** Fields read from intake documents unless the call names others. */
export const DEFAULT_EXTRACT_FIELDS: Record<string, string> = {
  pan: 'The PAN (permanent account number), 10 characters like AAACA1234A',
  gstin: 'The GSTIN, 15 characters like 29AAACA1234A1Z5',
  legal_name: 'The legal name of the business or person',
};

/** Reads one document's text as data and returns only the requested fields (a quarantined read). */
export type QuarantinedReader = (input: {
  role: string;
  file: { name: string; mime: string; text: string };
  fields: Record<string, string>;
  sessionId: string;
}) => Promise<Record<string, unknown>>;

export interface ExtractToolDeps {
  /** A document by file id, or by the name of a Document in the case's values. */
  readFile(id: string): Promise<{ meta: DocumentValue; data: Uint8Array } | undefined>;
  getCase(caseId: string): Promise<CaseSnapshot | undefined>;
  read: QuarantinedReader;
  role?: string;
}

/** Plain text of a document: text, Markdown and CSV as they are; PDF text runs, best effort. */
export function documentText(mime: string, _name: string, data: Uint8Array): { text: string; note?: string } {
  // The bytes decide, not the name: a PDF starts with `%PDF`.
  const isPdf = data.length >= 4 && data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46;
  if (isPdf || (mime === 'application/pdf' && !data.length)) {
    const text = pdfText(data);
    return text.trim()
      ? { text, note: 'PDF text extracted without layout (best effort)' }
      : { text: '', note: 'no text could be read from this PDF (it may be a scan); read it by hand' };
  }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(data) };
}

/**
 * Text drawn by `Tj`/`TJ` operators in a PDF's content streams, inflating FlateDecode streams
 * with zlib. No layout, fonts or encodings beyond plain bytes: enough for generated documents.
 */
export function pdfText(data: Uint8Array): string {
  const raw = Buffer.from(data).toString('latin1');
  const chunks: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const header = raw.slice(Math.max(0, m.index - 300), m.index);
    let body = Buffer.from(raw.slice(start, end), 'latin1');
    if (/FlateDecode/.test(header)) {
      try { body = inflateSync(body); } catch { re.lastIndex = end; continue; }
    }
    chunks.push(...textOperators(body.toString('latin1')));
    re.lastIndex = end;
  }
  return chunks.join('\n');
}

function textOperators(content: string): string[] {
  const out: string[] = [];
  const str = (s: string) => s.replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '', f: '' } as Record<string, string>)[c] ?? c);
  for (const m of content.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj|\[(?:[^\]])*\]\s*TJ/g)) {
    const parts = [...m[0].matchAll(/\(((?:\\.|[^\\)])*)\)/g)].map((p) => str(p[1]!));
    out.push(parts.join(''));
  }
  return out;
}

const isFileId = (s: string) => /^file_[0-9A-Za-z]+$/.test(s);

export function quarantinedExtractTool(deps: ExtractToolDeps): ToolDefinition<{ documents: string[]; fields?: string[] }> {
  return {
    name: EXTRACT_TOOL,
    description: "Read the client's uploaded documents (PAN card, GST certificate) and extract the fields printed on them. "
      + 'Pass the documents by file id or by their name on the case.',
    inputSchema: {
      type: 'object',
      properties: {
        documents: { type: 'array', items: { type: 'string' }, description: 'File ids, or names of the documents on the case.' },
        fields: { type: 'array', items: { type: 'string' }, description: `Fields to read; default ${Object.keys(DEFAULT_EXTRACT_FIELDS).join(', ')}.` },
      },
      required: ['documents'],
      additionalProperties: false,
    },
    effect: 'read',
    quarantine: true,
    source: { plugin: 'memwise-intake' },
    async execute({ documents, fields }, ctx) {
      const wanted = fields?.length
        ? Object.fromEntries(fields.map((f) => [f, DEFAULT_EXTRACT_FIELDS[f] ?? f]))
        : DEFAULT_EXTRACT_FIELDS;
      const onCase = ((await deps.getCase(ctx.token.caseId))?.values.documents?.value ?? []) as unknown[];
      const out: { name: string; value: unknown; document: string }[] = [];
      const notes: string[] = [];
      for (const ref of documents) {
        const doc = onCase.find((d): d is DocumentValue => !!d && typeof d === 'object' && ((d as DocumentValue).id === ref || (d as DocumentValue).name === ref));
        const id = doc?.id ?? (isFileId(ref) ? ref : undefined);
        const file = id ? await deps.readFile(id) : undefined;
        if (!file) { notes.push(`${ref}: no uploaded document with that id or name`); continue; }
        const { text, note } = documentText(file.meta.mime, file.meta.name, file.data);
        if (note) notes.push(`${file.meta.name}: ${note}`);
        if (!text.trim()) continue;
        const values = await deps.read({
          role: deps.role ?? 'extractor', file: { name: file.meta.name, mime: file.meta.mime, text }, fields: wanted,
          sessionId: `${ctx.token.stepRunId}:${id}`,
        });
        for (const [name, value] of Object.entries(values)) {
          if (value !== null && value !== undefined && value !== '' && name in wanted) out.push({ name, value, document: file.meta.name });
        }
      }
      return { fields: out, ...(notes.length ? { notes } : {}), tainted: true };
    },
  };
}
