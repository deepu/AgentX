/**
 * Uploads (19 §5): bytes content-addressed in a directory (desktop: `~/.memwise/files/<sha256>`),
 * metadata in mw.files. The same bytes uploaded twice are stored once; each upload gets its
 * own id and name.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ulid } from '../ids.ts';
import type { Queryable } from '../pool.ts';

/** A Document or File case value; same shape as `DocumentValue` in @memwise/runtime. */
export interface StoredFile { id: string; name: string; mime: string; size: number; sha256: string }

export class PgFileStore {
  constructor(readonly dir: string) {}

  async save(db: Queryable, input: { name: string; mime: string; data: Uint8Array }, createdBy?: string): Promise<StoredFile> {
    const sha256 = crypto.createHash('sha256').update(input.data).digest('hex');
    this.writeBytes(sha256, input.data);
    const meta: StoredFile = { id: `file_${ulid()}`, name: input.name, mime: input.mime || 'application/octet-stream', size: input.data.byteLength, sha256 };
    await db.query(
      'insert into mw.files (id, name, mime, size, sha256, created_by) values ($1, $2, $3, $4, $5, $6)',
      [meta.id, meta.name, meta.mime, meta.size, meta.sha256, createdBy ?? null]);
    return meta;
  }

  async meta(db: Queryable, id: string): Promise<StoredFile | undefined> {
    const { rows } = await db.query<{ id: string; name: string; mime: string; size: string; sha256: string }>(
      'select id, name, mime, size, sha256 from mw.files where id = $1', [id]);
    const r = rows[0];
    return r && { id: r.id, name: r.name, mime: r.mime, size: Number(r.size), sha256: r.sha256 };
  }

  /** Metadata and bytes; undefined when the id is unknown or the bytes are missing. */
  async read(db: Queryable, id: string): Promise<{ meta: StoredFile; data: Uint8Array } | undefined> {
    const meta = await this.meta(db, id);
    if (!meta) return undefined;
    const data = this.readBytes(meta.sha256);
    return data && { meta, data };
  }

  /** The bytes for a hash, verified; undefined when missing or corrupt. */
  readBytes(sha256: string): Uint8Array | undefined {
    try {
      const data = new Uint8Array(fs.readFileSync(this.pathOf(sha256)));
      return crypto.createHash('sha256').update(data).digest('hex') === sha256 ? data : undefined;
    } catch {
      return undefined;
    }
  }

  pathOf(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Not a sha256: ${sha256}`);
    return path.join(this.dir, sha256);
  }

  private writeBytes(sha256: string, data: Uint8Array): void {
    const target = this.pathOf(sha256);
    if (fs.existsSync(target)) return;
    fs.mkdirSync(this.dir, { recursive: true });
    // Write then rename, so a crash never leaves a partial file under the final name.
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  }
}
