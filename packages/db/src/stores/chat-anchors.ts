/**
 * Chat anchors (19 §6): a chat session opened from a case or a step. One anchor per chat.
 * `anchor_kind` is free text (no check constraint), so new kinds need no migration:
 * `workflow` (a chat about a playbook) and, from doc 25 §6, `record`, whose `anchor_id` is
 * `<entity key>:<record id>` (`recordAnchorId`).
 */
import type { Queryable } from '../pool.ts';
import { compact, iso } from '../rows.ts';

export type ChatAnchorKind = 'case' | 'step' | 'workflow' | 'record';

/** The `anchor_id` of a record anchor: `literature.topic:rec_1`. Entity keys have no colon. */
export function recordAnchorId(entity: string, id: string): string {
  return `${entity}:${id}`;
}

/** A record anchor's entity key and record id, or undefined when `anchorId` isn't one. */
export function parseRecordAnchorId(anchorId: string): { entity: string; id: string } | undefined {
  const at = anchorId.indexOf(':');
  if (at <= 0 || at === anchorId.length - 1) return undefined;
  return { entity: anchorId.slice(0, at), id: anchorId.slice(at + 1) };
}

export interface ChatAnchor {
  chatId: string;
  anchorKind: ChatAnchorKind;
  anchorId: string;
  personId?: string;
  createdAt: string;
  updatedAt: string;
}

export class PgChatAnchorStore {
  /** Anchors the chat (or re-anchors it). */
  async set(db: Queryable, a: Pick<ChatAnchor, 'chatId' | 'anchorKind' | 'anchorId' | 'personId'>): Promise<ChatAnchor> {
    const { rows } = await db.query<AnchorRow>(
      `insert into mw.chat_anchors (chat_id, anchor_kind, anchor_id, person_id) values ($1, $2, $3, $4)
       on conflict (chat_id) do update
         set anchor_kind = excluded.anchor_kind, anchor_id = excluded.anchor_id, person_id = excluded.person_id, updated_at = now()
       returning *`, [a.chatId, a.anchorKind, a.anchorId, a.personId ?? null]);
    return toAnchor(rows[0]!);
  }

  async get(db: Queryable, chatId: string): Promise<ChatAnchor | undefined> {
    const { rows } = await db.query<AnchorRow>('select * from mw.chat_anchors where chat_id = $1', [chatId]);
    return rows[0] && toAnchor(rows[0]);
  }

  /** Chats anchored to a case, step or record (optionally only one person's), most recent first. */
  async forAnchor(db: Queryable, anchorKind: ChatAnchor['anchorKind'], anchorId: string, personId?: string): Promise<ChatAnchor[]> {
    const { rows } = await db.query<AnchorRow>(
      `select * from mw.chat_anchors where anchor_kind = $1 and anchor_id = $2 and ($3::text is null or person_id = $3)
       order by updated_at desc, chat_id`, [anchorKind, anchorId, personId ?? null]);
    return rows.map(toAnchor);
  }

  /** Needs the system actor (the app role may not delete). */
  async remove(db: Queryable, chatId: string): Promise<void> {
    await db.query('delete from mw.chat_anchors where chat_id = $1', [chatId]);
  }
}

interface AnchorRow { chat_id: string; anchor_kind: ChatAnchorKind; anchor_id: string; person_id: string | null; created_at: Date; updated_at: Date }

function toAnchor(r: AnchorRow): ChatAnchor {
  return {
    chatId: r.chat_id, anchorKind: r.anchor_kind, anchorId: r.anchor_id, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
    ...compact({ personId: r.person_id }),
  };
}
