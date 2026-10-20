/**
 * Connections: a pg pool, the `Queryable` type every store takes, and a transaction helper.
 */
import pg from 'pg';

/**
 * Anything that can run a query: a pool, a pooled client or a plain client. Stores take this
 * so a caller can pass a client that is inside its own transaction.
 */
export interface Queryable {
  query<R extends pg.QueryResultRow = any>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

export interface PoolOptions {
  max?: number;
  /** Fail a connection attempt after this long instead of waiting forever (S3 caveat). */
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  applicationName?: string;
}

export function createPool(url: string, opts: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 10,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 10_000,
    idleTimeoutMillis: opts.idleTimeoutMillis ?? 10_000,
    application_name: opts.applicationName ?? 'memwise',
  });
  // An idle client that loses its server (restart, crash) emits 'error' on the pool; without a
  // listener that would crash the process. The next query simply gets a fresh connection.
  pool.on('error', () => {});
  return pool;
}

/** Run `fn` inside one transaction on a client from the pool: commit on success, roll back on throw. */
export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback').catch((err: Error) => { broken = err; });
    throw e;
  } finally {
    // A client whose rollback failed is in an unknown state: destroy it rather than reuse it.
    client.release(broken);
  }
}
