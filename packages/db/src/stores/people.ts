/**
 * People, roles and sign-in (19 §2, D32). Implements `PeopleService` from @memwise/runtime
 * (the shapes are repeated here because runtime depends on this package, not the reverse).
 *
 * Passwords: scrypt (node:crypto), stored as `scrypt$N$r$p$salt$hash`. Tokens: 32 random
 * bytes base64url, shown once, stored as sha256 hex. Runs as the system actor: the app role
 * cannot read password hashes or tokens at all.
 */
import crypto from 'node:crypto';
import type { Grant } from '@memwise/defs';
import type pg from 'pg';
import type { Actor } from '../actor.ts';
import { ulid } from '../ids.ts';
import type { Queryable } from '../pool.ts';
import { withTransaction } from '../pool.ts';
import { compact, iso, json } from '../rows.ts';
import { PgGrantStore } from './grants.ts';

export interface Person {
  id: string; name: string; email: string; roles: string[]; disabled?: boolean; createdAt: string;
  /** Phase 6: roles granted in one domain (24 §2). */
  grants?: Grant[];
  /** Phase 6: locked after failed signatures until then (24 §9). */
  lockedUntil?: string;
}

/** Sign-in events kept for regulated accounts (24 §9). */
export type AuthEventKind = 'signature-ok' | 'signature-failed' | 'locked';

/** Failed signatures count within this window (the kernel decides what to do with the count). */
export const AUTH_FAILURE_WINDOW_MS = 15 * 60_000;
export interface Role { id: string; title: string; description?: string }

export const newPersonId = () => `person_${ulid()}`;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export class PgPeopleStore {
  constructor(private readonly pool: pg.Pool) {}

  async list(): Promise<Person[]> {
    return this.select('true order by p.created_at, p.id');
  }

  async get(personId: string): Promise<Person | undefined> {
    return (await this.select('p.id = $1', [personId]))[0];
  }

  async byEmail(email: string): Promise<Person | undefined> {
    return (await this.select('p.email = $1', [normEmail(email)]))[0];
  }

  /** Creates a person. An email already in use is refused (`Error`, code `email-taken`). */
  async create(input: { name: string; email: string; roles?: string[]; password?: string; id?: string }): Promise<Person> {
    const email = normEmail(input.email);
    if (!email.includes('@')) throw new Error(`Not an email address: ${input.email}`);
    const name = input.name.trim();
    if (!name) throw new Error('A person needs a name');
    const id = input.id ?? newPersonId();
    const hash = input.password !== undefined ? await hashPassword(input.password) : null;
    await withTransaction(this.pool, async (db) => {
      const r = await db.query(
        `insert into mw.people (id, name, email, password_hash) values ($1, $2, $3, $4)
         on conflict do nothing`, [id, name, email, hash]);
      if (!r.rowCount) throw Object.assign(new Error(`Someone with the email ${email} already exists`), { code: 'email-taken' });
      await writeRoles(db, id, input.roles ?? []);
    });
    return (await this.get(id))!;
  }

  async setRoles(personId: string, roles: string[]): Promise<Person> {
    await withTransaction(this.pool, async (db) => {
      await this.mustExist(db, personId);
      await db.query('delete from mw.person_roles where person_id = $1', [personId]);
      await writeRoles(db, personId, roles);
    });
    return (await this.get(personId))!;
  }

  async setDisabled(personId: string, disabled: boolean): Promise<void> {
    await this.pool.query('update mw.people set disabled = $2 where id = $1', [personId, disabled]);
  }

  async setPassword(personId: string, password: string): Promise<void> {
    const r = await this.pool.query('update mw.people set password_hash = $2 where id = $1', [personId, await hashPassword(password)]);
    if (!r.rowCount) throw new Error(`No person ${personId}`);
  }

  /** The person when the password matches and they are not disabled. */
  async verifyPassword(email: string, password: string): Promise<Person | undefined> {
    const { rows } = await this.pool.query<{ id: string; password_hash: string | null; disabled: boolean }>(
      'select id, password_hash, disabled from mw.people where email = $1', [normEmail(email)]);
    const row = rows[0];
    if (!row?.password_hash || row.disabled) {
      // Same work either way, so timing doesn't say whether the email exists.
      await hashPassword(password);
      return undefined;
    }
    return (await checkPassword(password, row.password_hash)) ? this.get(row.id) : undefined;
  }

  async issueToken(personId: string, label?: string, ttlMs?: number): Promise<string> {
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = ttlMs !== undefined ? new Date(Date.now() + ttlMs) : null;
    await withTransaction(this.pool, async (db) => {
      await this.mustExist(db, personId);
      await db.query('insert into mw.auth_tokens (token_hash, person_id, label, expires_at) values ($1, $2, $3, $4)',
        [sha256(token), personId, label ?? null, expires]);
    });
    return token;
  }

  /** The token's person, if it is known, unexpired and the person not disabled; records its use. */
  async verifyToken(token: string): Promise<Person | undefined> {
    if (!token) return undefined;
    const { rows } = await this.pool.query<{ person_id: string }>(
      `update mw.auth_tokens t set last_used_at = now()
       from mw.people p
       where t.token_hash = $1 and p.id = t.person_id and not p.disabled
         and (t.expires_at is null or t.expires_at > now())
       returning t.person_id`, [sha256(token)]);
    return rows[0] ? this.get(rows[0].person_id) : undefined;
  }

  async revokeToken(token: string): Promise<void> {
    await this.pool.query('delete from mw.auth_tokens where token_hash = $1', [sha256(token)]);
  }

  async roles(): Promise<Role[]> {
    const { rows } = await this.pool.query<{ id: string; title: string; description: string | null }>(
      'select id, title, description from mw.roles order by id');
    return rows.map((r) => ({ id: r.id, title: r.title, ...compact({ description: r.description }) }));
  }

  /**
   * Makes mw.roles match the definitions (domain/roles.yaml): upserts every role and removes
   * roles no longer defined. People keep role ids that disappear; they simply match nothing.
   */
  async syncRoles(roles: Record<string, Partial<Role>> | Role[]): Promise<void> {
    const list: Role[] = Array.isArray(roles)
      ? roles
      : Object.entries(roles).map(([id, r]) => ({ id: r.id ?? id, title: r.title ?? id, ...compact({ description: r.description }) }));
    await withTransaction(this.pool, async (db) => {
      for (const r of list) {
        await db.query(
          `insert into mw.roles (id, title, description) values ($1, $2, $3)
           on conflict (id) do update set title = excluded.title, description = excluded.description`,
          [r.id, r.title, r.description ?? null]);
      }
      await db.query('delete from mw.roles where not (id = any($1::text[]))', [list.map((r) => r.id)]);
    });
  }

  /** The actor for a person, with roles read now. A missing or disabled person is refused. */
  async actorFor(personId: string): Promise<Extract<Actor, { kind: 'person' }>> {
    const p = await this.get(personId);
    if (!p) throw new Error(`No person ${personId}`);
    if (p.disabled) throw new Error(`${p.name} is disabled`);
    return { kind: 'person', personId: p.id, roles: p.roles, ...(p.grants?.length ? { grants: p.grants } : {}) };
  }

  // ---------------------------------------------------------------- Phase 6 (24 §2, §9)

  async grants(personId: string): Promise<Grant[]> {
    return new PgGrantStore().list(this.pool, personId);
  }

  async setGrants(personId: string, grants: Grant[]): Promise<Grant[]> {
    return withTransaction(this.pool, async (db) => {
      await this.mustExist(db, personId);
      return new PgGrantStore().set(db, personId, grants);
    });
  }

  /**
   * Logs a signing attempt or a lock. A `locked` event with `detail.until` (ISO time) also sets
   * the person's `locked_until`.
   */
  async recordAuthEvent(personId: string, kind: AuthEventKind, detail: Record<string, unknown> = {}): Promise<void> {
    await withTransaction(this.pool, async (db) => {
      await db.query('insert into mw.auth_events (id, person_id, kind, detail) values ($1, $2, $3, $4)',
        [`auth_${ulid()}`, personId, kind, json(detail)]);
      if (kind === 'locked' && typeof detail.until === 'string') {
        await db.query('update mw.people set locked_until = $2 where id = $1', [personId, detail.until]);
      }
    });
  }

  /** Sets or clears (null) the time a person is locked until. */
  async setLockedUntil(personId: string, until: string | Date | null): Promise<void> {
    await this.pool.query('update mw.people set locked_until = $2 where id = $1', [personId, until]);
  }

  /**
   * Whether the person is locked now, and how many signatures failed in the last 15 minutes
   * since their last good one.
   */
  async lockState(personId: string): Promise<{ lockedUntil?: string; recentFailures: number }> {
    const { rows } = await this.pool.query<{ locked_until: Date | null; failures: number }>(
      `select case when p.locked_until > now() then p.locked_until end as locked_until,
              (select count(*)::int from mw.auth_events e
                where e.person_id = p.id and e.kind = 'signature-failed' and e.at > now() - $2::interval
                  and e.at > coalesce((select max(o.at) from mw.auth_events o where o.person_id = p.id and o.kind = 'signature-ok'), '-infinity')) as failures
       from mw.people p where p.id = $1`, [personId, `${AUTH_FAILURE_WINDOW_MS} milliseconds`]);
    const r = rows[0];
    if (!r) throw new Error(`No person ${personId}`);
    return { ...(r.locked_until ? { lockedUntil: iso(r.locked_until) } : {}), recentFailures: r.failures };
  }

  /** The sign-in events of a person, newest first (the audit export). */
  async authEvents(personId: string, limit = 100): Promise<{ id: string; kind: AuthEventKind; detail: Record<string, unknown>; at: string }[]> {
    const { rows } = await this.pool.query<{ id: string; kind: AuthEventKind; detail: Record<string, unknown>; at: Date }>(
      'select id, kind, detail, at from mw.auth_events where person_id = $1 order by at desc, id desc limit $2', [personId, limit]);
    return rows.map((r) => ({ id: r.id, kind: r.kind, detail: r.detail, at: iso(r.at) }));
  }

  private async select(where: string, values: unknown[] = []): Promise<Person[]> {
    const { rows } = await this.pool.query<{
      id: string; name: string; email: string; disabled: boolean; created_at: Date; roles: string[]; grants: Grant[]; locked_until: Date | null;
    }>(
      `select p.id, p.name, p.email, p.disabled, p.created_at,
              coalesce(array(select role_id from mw.person_roles r where r.person_id = p.id order by role_id), '{}') as roles,
              coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('role', g.role_id, 'domain', g.domain, 'scope', g.scope))
                                   order by g.domain, g.role_id, g.id)
                        from mw.grants g where g.person_id = p.id), '[]'::jsonb) as grants,
              case when p.locked_until > now() then p.locked_until end as locked_until
       from mw.people p where ${where}`, values);
    return rows.map((r) => ({
      id: r.id, name: r.name, email: r.email, roles: r.roles, createdAt: iso(r.created_at),
      ...(r.disabled ? { disabled: true } : {}),
      ...(r.grants.length ? { grants: r.grants } : {}),
      ...(r.locked_until ? { lockedUntil: iso(r.locked_until) } : {}),
    }));
  }

  private async mustExist(db: Queryable, personId: string): Promise<void> {
    const { rowCount } = await db.query('select 1 from mw.people where id = $1', [personId]);
    if (!rowCount) throw new Error(`No person ${personId}`);
  }
}

async function writeRoles(db: Queryable, personId: string, roles: string[]): Promise<void> {
  const unique = [...new Set(roles.map((r) => r.trim()).filter(Boolean))];
  if (unique.some((r) => r.includes(','))) throw new Error('A role id cannot contain a comma');
  if (unique.length) {
    await db.query('insert into mw.person_roles (person_id, role_id) select $1, unnest($2::text[]) on conflict do nothing',
      [personId, unique]);
  }
}

const normEmail = (email: string) => email.trim().toLowerCase();

export const sha256 = (s: string | Uint8Array) => crypto.createHash('sha256').update(s).digest('hex');

function scrypt(password: string, salt: Buffer, opts: { N: number; r: number; p: number }, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize('NFKC'), salt, keylen, { ...opts, maxmem: 64 * 1024 * 1024 }, (err, key) => err ? reject(err) : resolve(key));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT, SCRYPT.keylen);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scrypt(password, Buffer.from(salt, 'base64url'), { N: Number(N), r: Number(r), p: Number(p) }, expected.length);
  return crypto.timingSafeEqual(key, expected);
}
