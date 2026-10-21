/**
 * Actors (19 §2, D32): everything the kernel does for someone runs under one, and Postgres
 * row rules read it from transaction-local settings. `withActor` is the only place those
 * settings are made, so the database, not the app, decides what a person or an agent sees.
 * Phase 6 adds `mw.grants` (a person's grants as JSON); the write context (`mw.reason`, `mw.via`,
 * `mw.transition`, `mw.by`) is `withRecordContext`'s.
 */
import type { Grant, StepToken } from '@memwise/defs';
import type pg from 'pg';
import { withTransaction } from './pool.ts';

/** Who is acting. Same shape as `Actor` in @memwise/runtime (which re-exports this one). */
export type Actor =
  /** Phase 6: `roles` are workspace-wide; `grants` are roles in one domain, maybe limited to records (24 §2). */
  | { kind: 'person'; personId: string; roles: string[]; grants?: Grant[] }
  | { kind: 'step'; token: StepToken }
  | { kind: 'system' };

/** The Postgres role people and step tokens act as (created by migration 0002). */
export const APP_ROLE = 'memwise_app';

/**
 * Runs `fn` in one transaction as `actor`. People and step tokens switch to `memwise_app`, so
 * RLS applies to them; the system actor stays the owner (migrations, the run driver).
 * Settings are transaction-local: nothing leaks to the next user of the pooled connection.
 */
export async function withActor<T>(pool: pg.Pool, actor: Actor, fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(pool, async (client) => {
    await setActor(client, actor);
    return fn(client);
  });
}

/** Applies `actor` to a client that is already inside a transaction. */
export async function setActor(client: pg.ClientBase, actor: Actor): Promise<void> {
  if (actor.kind !== 'system') await client.query(`set local role ${APP_ROLE}`);
  const s = actorSettings(actor);
  await client.query(
    `select set_config('mw.actor_kind', $1, true), set_config('mw.person', $2, true),
            set_config('mw.roles', $3, true), set_config('mw.step_token', $4, true),
            set_config('mw.grants', $5, true)`,
    [s.kind, s.person, s.roles, s.stepToken, s.grants],
  );
}

export function actorSettings(actor: Actor): { kind: string; person: string; roles: string; stepToken: string; grants: string } {
  switch (actor.kind) {
    case 'person':
      return {
        kind: 'person', person: actor.personId, roles: actor.roles.filter((r) => !r.includes(',')).join(','), stepToken: '',
        grants: actor.grants?.length ? JSON.stringify(actor.grants) : '',
      };
    case 'step':
      return { kind: 'step', person: actor.token.onBehalfOf ?? '', roles: '', stepToken: JSON.stringify(actor.token), grants: '' };
    case 'system':
      return { kind: 'system', person: '', roles: '', stepToken: '', grants: '' };
  }
}

/** A short label for provenance and logs: the person id, the step run, or `system`. */
export function actorLabel(actor: Actor): string {
  return actor.kind === 'person' ? actor.personId : actor.kind === 'step' ? actor.token.stepRunId : 'system';
}
