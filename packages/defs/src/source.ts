/**
 * Reading one YAML text into a plain value plus diagnostics, and finding the line of any
 * path inside it. Lines are kept beside the parsed definitions (in a WeakMap) so the checks
 * can point at the right line without the definition model carrying positions.
 */
import { createHash } from 'node:crypto';
import { isMap, isScalar, LineCounter, parseDocument, type Document } from 'yaml';
import type { z } from 'zod';
import type { Diagnostic, Severity } from './types.ts';

export type PathKey = string | number;
/** 1-based line of a path inside a file, or undefined when it isn't there. */
export type Locator = (path: PathKey[]) => number | undefined;

export interface YamlSource {
  file: string;
  /** The parsed value, or undefined when the text isn't valid YAML. */
  data: unknown;
  locate: Locator;
  diagnostics: Diagnostic[];
}

export function sha256(...parts: (string | Uint8Array)[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
}

/**
 * Parses YAML text. `lineOffset` shifts every line (a step's front matter starts on line 2).
 * Syntax errors become `yaml-syntax` diagnostics; `data` is still returned when the yaml
 * library could recover a value.
 */
export function readYaml(text: string, file: string, lineOffset = 0): YamlSource {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: true });
  const diagnostics: Diagnostic[] = [];
  for (const err of [...doc.errors, ...doc.warnings]) {
    diagnostics.push({
      severity: doc.errors.includes(err) ? 'error' : 'warning',
      code: 'yaml-syntax',
      message: err.message.split('\n')[0]!,
      file,
      line: err.linePos ? err.linePos[0].line + lineOffset : undefined,
    });
  }
  const locate: Locator = (path) => {
    const offset = offsetOf(doc, path);
    return offset === undefined ? undefined : lineCounter.linePos(offset).line + lineOffset;
  };
  return { file, data: doc.errors.length ? safeToJS(doc) : doc.toJS(), locate, diagnostics };
}

function safeToJS(doc: Document): unknown {
  try { return doc.toJS(); } catch { return undefined; }
}

/** Offset of the deepest node on the path; for a map entry, the key's position. */
function offsetOf(doc: Document, path: PathKey[]): number | undefined {
  let node: unknown = doc.contents;
  let offset = (doc.contents as { range?: number[] } | null)?.range?.[0];
  for (const key of path) {
    if (isMap(node)) {
      const pair = node.items.find((p) => (isScalar(p.key) ? p.key.value : p.key) === key);
      if (!pair) break;
      offset = (pair.key as { range?: number[] })?.range?.[0] ?? offset;
      node = pair.value;
    } else if (node && typeof node === 'object' && 'items' in node && typeof key === 'number') {
      const item = (node as { items: unknown[] }).items[key];
      if (!item) break;
      offset = (item as { range?: number[] }).range?.[0] ?? offset;
      node = item;
    } else break;
  }
  return offset;
}

/** Dotted path for messages: `steps.check.on.failed`, `flags.0`. */
export function dotted(path: readonly PropertyKey[]): string {
  return path.map(String).join('.');
}

/** Collects diagnostics for one file, with lines from its locator. */
export class Reporter {
  readonly diagnostics: Diagnostic[] = [];
  constructor(readonly file: string, readonly locate: Locator) {}

  add(severity: Severity, code: string, message: string, path: PathKey[] = []): void {
    this.diagnostics.push({
      severity, code, message, file: this.file,
      line: this.locate(path),
      ...(path.length ? { path: dotted(path) } : {}),
    });
  }
  error(code: string, message: string, path?: PathKey[]): void { this.add('error', code, message, path); }
  warn(code: string, message: string, path?: PathKey[]): void { this.add('warning', code, message, path); }

  /**
   * Structural check against a file format. Unknown keys are warnings (`unknown-key`):
   * usually a typo, and the rest of the file still means what it says.
   */
  validate(schema: z.ZodType, data: unknown): void {
    const result = schema.safeParse(data);
    if (result.success) return;
    for (const issue of result.error.issues) {
      const path = issue.path.filter((k): k is PathKey => typeof k !== 'symbol');
      if (issue.code === 'unrecognized_keys') {
        for (const key of issue.keys) this.warn('unknown-key', `unknown key \`${key}\``, [...path, key]);
      } else {
        const where = path.length ? `\`${dotted(path)}\`: ` : '';
        this.error('invalid-format', `${where}${issue.message}`, path);
      }
    }
  }
}

// ---------------------------------------------------------------- line lookup for checks

const locators = new WeakMap<object, Locator>();

export function rememberLocator(def: object, locate: Locator): void {
  locators.set(def, locate);
}

export function locatorOf(def: object): Locator | undefined {
  return locators.get(def);
}

/** The line of a path in the file a definition was loaded from, when it was loaded in this process. */
export function lineOf(def: object, path: PathKey[]): number | undefined {
  return locators.get(def)?.(path);
}

/** What every file parser returns: the definition when the file could be read at all, and what was wrong. */
export interface ParseResult<T> { value?: T; diagnostics: Diagnostic[] }

/** Drops keys whose value is undefined, so parsed definitions stay clean JSON. */
export function compact<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

// ---------------------------------------------------------------- tolerant readers for unvalidated data

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
export function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
export function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
export function asRecord(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}
