// The audit export's PDF writer (src/audit/pdf.ts): the file's structure checked as a reader
// would read it: header, objects at the offsets the xref table gives, the trailer and the pages.
import { expect, test } from 'bun:test';
import { PdfDocument } from '../src/audit/pdf.ts';

const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join('');

/** Checks the cross-reference table against the bytes; returns the file as text. */
export function checkPdfStructure(bytes: Uint8Array): { text: string; pages: number } {
  const text = latin1(bytes);
  expect(text.startsWith('%PDF-1.4\n')).toBe(true);
  expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1]);
  expect(text.slice(startxref, startxref + 4)).toBe('xref');
  const head = /xref\n0 (\d+)\n/.exec(text.slice(startxref))!;
  const size = Number(head[1]);
  const entries = text.slice(startxref + head[0].length).split('\n').slice(0, size);
  expect(entries[0]).toBe('0000000000 65535 f ');
  for (let id = 1; id < size; id++) {
    const offset = Number(entries[id]!.slice(0, 10));
    expect(text.slice(offset, offset + `${id} 0 obj`.length)).toBe(`${id} 0 obj`);
  }
  expect(text).toContain(`trailer\n<< /Size ${size} /Root 1 0 R`);
  // Each content stream's /Length is its byte length.
  for (const m of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = m.index! + m[0].length;
    expect(text.slice(start + Number(m[1]), start + Number(m[1]) + '\nendstream'.length)).toBe('\nendstream');
  }
  const pages = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(text)![1]);
  expect((text.match(/\/Type \/Page /g) ?? []).length).toBe(pages);
  return { text, pages };
}

test('a short document is one valid page, with text escaped and WinAnsi marks kept', () => {
  const pdf = new PdfDocument({ title: 'Audit trail (Document)', createdAt: new Date('2026-10-20T12:00:00Z'), footer: 'MemWise' });
  pdf.heading('Investigator CV · Dr. Lena Vogel');
  pdf.pairs([['Status', 'filed'], ['Chain', 'verified — 4 versions']]);
  pdf.text('A (bracketed) back\\slash and → arrow, ✓ tick and 漢字.');
  const { text, pages } = checkPdfStructure(pdf.bytes());
  expect(pages).toBe(1);
  expect(text).toContain('(Investigator CV \\267 Dr. Lena Vogel) Tj');
  expect(text).toContain('(verified \\227 4 versions) Tj');
  expect(text).toContain('A \\(bracketed\\) back\\\\slash and -> arrow, v tick and ??.');
  expect(text).toContain('(MemWise    Page 1 of 1)');
  expect(text).toContain('/CreationDate (D:20261020120000Z)');
});

test('long tables break pages, repeat their header and number every page', () => {
  const pdf = new PdfDocument({ title: 'Versions' });
  pdf.heading('Versions');
  const rows = Array.from({ length: 150 }, (_, i) => [String(i + 1), '2026-10-20T12:00:00.000Z', `step:run_${i}/3/qc`, 'a'.repeat(64)]);
  pdf.table(['#', 'When', 'By', 'Hash'], rows, [0.06, 0.24, 0.3, 0.4]);
  const { text, pages } = checkPdfStructure(pdf.bytes());
  expect(pages).toBe(pdf.pageCount);
  expect(pages).toBeGreaterThan(2);
  expect((text.match(/\(Hash\) Tj/g) ?? []).length).toBe(pages);
  expect(text).toContain(`Page ${pages} of ${pages})`);
  // A 64-character hash is wider than its column: it is cut, never lost.
  expect((text.match(/\(a+\) Tj/g) ?? []).map((m) => m.length - 5).reduce((a, b) => a + b, 0)).toBe(64 * 150);
});
