// A small PDF writer for the audit export (24 §9): A4 pages of Helvetica text, headings, wrapped
// paragraphs and simple tables, with "page n of N" footers. No dependency: PDF 1.4 written by hand,
// with a cross-reference table, so any reader opens it. Only WinAnsi text (Latin-1 and the usual
// typographic marks); anything else is replaced, so the bytes are always valid.

/** Helvetica glyph widths (1/1000 em) for ASCII 32–126, from the standard font metrics. */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
  556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** Characters outside Latin-1 that WinAnsiEncoding still has, by their byte. */
const WIN_ANSI: Record<string, number> = {
  '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, '‰': 0x89, '‹': 0x8b, '‘': 0x91, '’': 0x92,
  '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99, '›': 0x9b,
};
const REPLACE: Record<string, string> = { '→': '->', '←': '<-', '✓': 'v', '✗': 'x', '≥': '>=', '≤': '<=', '÷': '/' };

/** Text as WinAnsi bytes (one char per byte). */
function winAnsi(text: string): number[] {
  const out: number[] = [];
  for (const ch of text.normalize('NFC')) {
    const code = ch.codePointAt(0)!;
    if (code === 9) out.push(32);
    else if (code >= 32 && code < 127) out.push(code);
    else if (code >= 160 && code <= 255) out.push(code);
    else if (WIN_ANSI[ch] !== undefined) out.push(WIN_ANSI[ch]!);
    else if (REPLACE[ch]) out.push(...[...REPLACE[ch]!].map((c) => c.charCodeAt(0)));
    else if (code >= 32) out.push(63); // '?'
  }
  return out;
}

const widthOf = (bytes: number[], size: number, bold: boolean) =>
  (bytes.reduce((w, b) => w + (b >= 32 && b < 127 ? HELVETICA[b - 32]! : 556), 0) * size * (bold ? 1.06 : 1)) / 1000;

/** A PDF string literal of WinAnsi bytes: `(` `)` `\` escaped, bytes above 126 in octal. */
function literal(bytes: number[]): string {
  let s = '(';
  for (const b of bytes) {
    if (b === 40 || b === 41 || b === 92) s += `\\${String.fromCharCode(b)}`;
    else if (b > 126) s += `\\${b.toString(8).padStart(3, '0')}`;
    else s += String.fromCharCode(b);
  }
  return `${s})`;
}

export interface PdfOptions {
  title: string;
  author?: string;
  subject?: string;
  /** Footer text left of the page number. */
  footer?: string;
  /** Fixed creation date (tests); default now. */
  createdAt?: Date;
}

interface TextOp { x: number; y: number; size: number; bold: boolean; bytes: number[] }
interface LineOp { x1: number; y1: number; x2: number; y2: number }

const PAGE = { width: 595.28, height: 841.89, margin: 56 };

/**
 * Lays text out top to bottom, breaking pages as it goes. `bytes()` writes the file.
 *
 *   const pdf = new PdfDocument({ title: 'Audit trail' });
 *   pdf.heading('Versions'); pdf.table(['#', 'When'], rows); const bytes = pdf.bytes();
 */
export class PdfDocument {
  private pages: { texts: TextOp[]; lines: LineOp[] }[] = [];
  private y = 0;
  private readonly left = PAGE.margin;
  private readonly right = PAGE.width - PAGE.margin;
  private readonly bottom = PAGE.margin + 24; // room for the footer

  constructor(private readonly opts: PdfOptions) { this.newPage(); }

  get pageCount(): number { return this.pages.length; }

  newPage(): this {
    this.pages.push({ texts: [], lines: [] });
    this.y = PAGE.height - PAGE.margin;
    return this;
  }

  /** Vertical space; a new page when it doesn't fit. */
  space(points: number): this {
    this.y -= points;
    if (this.y < this.bottom) this.newPage();
    return this;
  }

  private ensure(points: number) {
    if (this.y - points < this.bottom) this.newPage();
  }

  private get page() { return this.pages[this.pages.length - 1]!; }

  private put(x: number, size: number, bold: boolean, bytes: number[]) {
    this.page.texts.push({ x, y: this.y, size, bold, bytes });
  }

  /** Words wrapped into lines no wider than `width`; a word longer than a line is cut. */
  private wrap(text: string, size: number, bold: boolean, width: number): number[][] {
    const lines: number[][] = [];
    for (const para of text.split('\n')) {
      let line: number[] = [];
      for (const word of para.split(/ +/)) {
        let w = winAnsi(word);
        const tryLine = line.length ? [...line, 32, ...w] : w;
        if (widthOf(tryLine, size, bold) <= width) { line = tryLine; continue; }
        if (line.length) lines.push(line);
        while (widthOf(w, size, bold) > width && w.length > 1) {
          let n = w.length - 1;
          while (n > 1 && widthOf(w.slice(0, n), size, bold) > width) n--;
          lines.push(w.slice(0, n));
          w = w.slice(n);
        }
        line = w;
      }
      lines.push(line);
    }
    return lines;
  }

  /** A paragraph of wrapped text. */
  text(text: string, opts: { size?: number; bold?: boolean; indent?: number; after?: number } = {}): this {
    const size = opts.size ?? 10;
    const bold = !!opts.bold;
    const x = this.left + (opts.indent ?? 0);
    for (const line of this.wrap(text, size, bold, this.right - x)) {
      this.ensure(size * 1.35);
      this.y -= size * 1.35;
      this.put(x, size, bold, line);
    }
    if (opts.after) this.space(opts.after);
    return this;
  }

  heading(text: string, size = 14): this {
    this.ensure(size * 3);
    this.space(size * 0.6);
    this.text(text, { size, bold: true, after: 4 });
    return this.rule();
  }

  /** A thin line across the page. */
  rule(): this {
    this.page.lines.push({ x1: this.left, y1: this.y, x2: this.right, y2: this.y });
    return this.space(6);
  }

  /** `label: value` pairs, aligned. */
  pairs(rows: [string, string][], labelWidth = 130): this {
    for (const [label, value] of rows) {
      const lines = this.wrap(value || '-', 10, false, this.right - this.left - labelWidth);
      this.ensure(13.5 * Math.min(lines.length, 3));
      lines.forEach((line, i) => {
        this.ensure(13.5);
        this.y -= 13.5;
        if (i === 0) this.put(this.left, 10, true, winAnsi(label));
        this.put(this.left + labelWidth, 10, false, line);
      });
    }
    return this.space(4);
  }

  /**
   * A table: column widths as fractions of the page width (default equal). Each cell wraps; a
   * header row repeats on every page the table continues on.
   */
  table(headers: string[], rows: string[][], fractions?: number[], size = 8.5): this {
    const total = this.right - this.left;
    const f = fractions ?? headers.map(() => 1 / headers.length);
    const widths = f.map((x) => x * total);
    const xs = widths.map((_, i) => this.left + widths.slice(0, i).reduce((a, b) => a + b, 0));
    const lineHeight = size * 1.3;
    const header = () => {
      this.ensure(lineHeight * 2);
      this.y -= lineHeight;
      headers.forEach((h, i) => this.put(xs[i]!, size, true, winAnsi(h)));
      this.y -= 3;
      this.page.lines.push({ x1: this.left, y1: this.y, x2: this.right, y2: this.y });
    };
    header();
    for (const row of rows) {
      const cells = row.map((c, i) => this.wrap(c ?? '', size, false, widths[i]! - 4));
      const height = Math.max(1, ...cells.map((c) => c.length)) * lineHeight + 2;
      if (this.y - height < this.bottom) { this.newPage(); header(); }
      const top = this.y;
      cells.forEach((lines, i) => lines.forEach((line, j) => {
        this.page.texts.push({ x: xs[i]!, y: top - lineHeight * (j + 1), size, bold: false, bytes: line });
      }));
      this.y = top - height;
    }
    return this.space(8);
  }

  /** The finished file. */
  bytes(): Uint8Array {
    const n = this.pages.length;
    const objects: string[] = [];
    // 1 catalog, 2 pages, 3 Helvetica, 4 Helvetica-Bold, 5 info, then page and content pairs.
    const pageId = (i: number) => 6 + i * 2;
    const contentId = (i: number) => 7 + i * 2;
    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[2] = `<< /Type /Pages /Kids [${this.pages.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] /Count ${n} >>`;
    objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
    const d = this.opts.createdAt ?? new Date();
    const pad = (x: number) => String(x).padStart(2, '0');
    const date = `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
    objects[5] = `<< /Title ${literal(winAnsi(this.opts.title))}${this.opts.author ? ` /Author ${literal(winAnsi(this.opts.author))}` : ''}`
      + `${this.opts.subject ? ` /Subject ${literal(winAnsi(this.opts.subject))}` : ''} /Producer (MemWise) /CreationDate (${date}) >>`;
    this.pages.forEach((p, i) => {
      const ops: string[] = ['0.6 w'];
      for (const l of p.lines) ops.push(`${l.x1.toFixed(2)} ${l.y1.toFixed(2)} m ${l.x2.toFixed(2)} ${l.y2.toFixed(2)} l S`);
      const footer = `${this.opts.footer ? `${this.opts.footer}    ` : ''}Page ${i + 1} of ${n}`;
      const texts = [...p.texts, { x: this.left, y: PAGE.margin - 8, size: 8, bold: false, bytes: winAnsi(footer) }];
      for (const t of texts) ops.push(`BT /${t.bold ? 'F2' : 'F1'} ${t.size} Tf ${t.x.toFixed(2)} ${t.y.toFixed(2)} Td ${literal(t.bytes)} Tj ET`);
      const stream = ops.join('\n');
      objects[pageId(i)] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] `
        + `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId(i)} 0 R >>`;
      objects[contentId(i)] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    });
    // Every string above is one byte per char (WinAnsi), so string length is byte length.
    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets: number[] = [];
    for (let id = 1; id < objects.length; id++) {
      offsets[id] = out.length;
      out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }
    const xref = out.length;
    out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
  }
}
