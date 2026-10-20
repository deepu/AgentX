/**
 * What the channel tools have sent, by idempotency key. The gateway's effect ledger already
 * returns a finished call's result without running it again; this covers the gap it leaves to the
 * provider: a call that was started, whose result was lost (a crash mid-send), is retried with the
 * same key, and neither SMTP nor the WhatsApp API dedupes. A key found here returns what was sent.
 * Recorded after the provider accepted the message, so a crash in between can still send twice;
 * the email's Message-ID is the same each time, so mail clients show it once.
 */
import type pg from 'pg'

export interface SentStore {
  get(key: string): Promise<Record<string, unknown> | undefined>
  put(key: string, tool: string, result: Record<string, unknown>): Promise<void>
}

export function memorySentStore(): SentStore {
  const rows = new Map<string, Record<string, unknown>>()
  return {
    get: async (key) => rows.get(key),
    put: async (key, _tool, result) => { rows.set(key, result) },
  }
}

const SENT_SQL = `
create schema if not exists mw_channels;
create table if not exists mw_channels.sent (
  idempotency_key  text primary key,
  tool             text not null,
  result           jsonb not null,
  sent_at          timestamptz not null default now()
);`

type Queryable = Pick<pg.Pool, 'query'>

/** The kernel database's `mw_channels.sent`, made on first use. */
export function pgSentStore(pool: () => Queryable): SentStore {
  let ready: Promise<unknown> | undefined
  const db = async () => {
    const p = pool()
    ready ??= p.query(SENT_SQL).catch((e: unknown) => { ready = undefined; throw e })
    await ready
    return p
  }
  return {
    async get(key) {
      const { rows } = await (await db()).query('select result from mw_channels.sent where idempotency_key = $1', [key])
      return rows[0]?.result as Record<string, unknown> | undefined
    },
    async put(key, tool, result) {
      await (await db()).query(
        'insert into mw_channels.sent (idempotency_key, tool, result) values ($1, $2, $3) on conflict (idempotency_key) do nothing',
        [key, tool, JSON.stringify(result)],
      )
    },
  }
}
