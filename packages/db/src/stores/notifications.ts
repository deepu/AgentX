/** Notifications (19 §4): reminders and other notes for a role or a person, shown in the inbox. */
import { ulid } from '../ids.ts';
import type { Queryable } from '../pool.ts';
import { compact, iso } from '../rows.ts';

export interface Notification {
  id: string;
  runId: string;
  stepRunId?: string;
  /** The role it is for; with neither role nor person it is for everyone. */
  role?: string;
  personId?: string;
  kind: string;
  text: string;
  createdAt: string;
  readAt?: string;
}

export type NewNotification = Omit<Notification, 'id' | 'createdAt' | 'readAt'> & {
  /** Pass a stable id (e.g. from the timer) so a repeated write adds nothing. */
  id?: string;
};

export class PgNotificationStore {
  /** Idempotent on `id`: a second add with the same id returns the first row. */
  async add(db: Queryable, n: NewNotification): Promise<Notification> {
    const id = n.id ?? `note_${ulid()}`;
    await db.query(
      `insert into mw.notifications (id, run_id, step_run_id, role, person_id, kind, text)
       values ($1, $2, $3, $4, $5, $6, $7) on conflict (id) do nothing`,
      [id, n.runId, n.stepRunId ?? null, n.role ?? null, n.personId ?? null, n.kind, n.text]);
    return (await this.get(db, id))!;
  }

  async get(db: Queryable, id: string): Promise<Notification | undefined> {
    const { rows } = await db.query<NotificationRow>('select * from mw.notifications where id = $1', [id]);
    return rows[0] && toNotification(rows[0]);
  }

  /** Unread notifications for a person: addressed to them, to one of their roles, or to everyone. Oldest first. */
  async unread(db: Queryable, who: { personId: string; roles: string[] }): Promise<Notification[]> {
    const { rows } = await db.query<NotificationRow>(
      `select * from mw.notifications
       where read_at is null
         and (person_id = $1 or role = any($2::text[]) or (person_id is null and role is null))
       order by created_at, id`, [who.personId, who.roles]);
    return rows.map(toNotification);
  }

  async forRun(db: Queryable, runId: string): Promise<Notification[]> {
    const { rows } = await db.query<NotificationRow>('select * from mw.notifications where run_id = $1 order by created_at, id', [runId]);
    return rows.map(toNotification);
  }

  /** Marks it read; false when it was already read or doesn't exist. */
  async markRead(db: Queryable, id: string): Promise<boolean> {
    const r = await db.query('update mw.notifications set read_at = now() where id = $1 and read_at is null', [id]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Marks every unread notification of a step run read (e.g. once the step is answered). */
  async markReadForStep(db: Queryable, stepRunId: string): Promise<number> {
    const r = await db.query('update mw.notifications set read_at = now() where step_run_id = $1 and read_at is null', [stepRunId]);
    return r.rowCount ?? 0;
  }
}

interface NotificationRow {
  id: string; run_id: string; step_run_id: string | null; role: string | null; person_id: string | null;
  kind: string; text: string; created_at: Date; read_at: Date | null;
}

function toNotification(r: NotificationRow): Notification {
  return {
    id: r.id, runId: r.run_id, kind: r.kind, text: r.text, createdAt: iso(r.created_at),
    ...compact({ stepRunId: r.step_run_id, role: r.role, personId: r.person_id, readAt: iso(r.read_at) }),
  };
}
