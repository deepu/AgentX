// Text from uploaded documents, for the quarantined extractor (19 §5).
import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { documentText, pdfText } from '../src/extract.ts';

const pdf = (content: string, flate: boolean) => {
  const body = flate ? deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1');
  return new Uint8Array(Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj << /Length ${body.length}${flate ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, 'latin1'),
    body, Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ]));
};

describe('document text', () => {
  test('text, Markdown and CSV are read as they are', () => {
    expect(documentText('text/csv', 'a.csv', new TextEncoder().encode('pan,gstin\nAAACA1234A,29AAACA1234A1Z5\n')).text).toContain('AAACA1234A');
    expect(documentText('text/markdown', 'a.md', new TextEncoder().encode('# PAN\nAAACA1234A')).note).toBeUndefined();
  });

  test('PDF text runs, plain and Flate-compressed', () => {
    const content = 'BT /F1 12 Tf (PERMANENT ACCOUNT NUMBER) Tj ET BT [(AAAC) -20 (A1234A)] TJ ET';
    for (const flate of [false, true]) expect(pdfText(pdf(content, flate)).split('\n')).toEqual(['PERMANENT ACCOUNT NUMBER', 'AAACA1234A']);
    const r = documentText('application/pdf', 'pan.pdf', pdf(content, true));
    expect(r.text).toContain('AAACA1234A');
    expect(r.note).toContain('best effort');
  });

  test('a PDF with no text (a scan) says so', () => {
    expect(documentText('application/pdf', 'scan.pdf', pdf('q 100 0 0 100 0 0 cm /Im0 Do Q', true))).toEqual({ text: '', note: expect.stringContaining('may be a scan') });
  });
});
