/**
 * MemWise context of an anchored chat (docs/memwise/20-phase-3-interfaces.md §4).
 *
 * A chat opened on a case, a step or a conversation step (building or changing a playbook)
 * gets its context as a per-session system-prompt block (`<memwise_context>`), not as a
 * message. The block is set before the first turn and kept in its own file next to the
 * transcript (`sessions/{id}/memwise-context.json`), not in the JSONL header: the header is
 * read 8 KB at a time for the session list and the block can be larger. Both backends pin
 * it with the rest of the system prompt on the first turn (Claude snapshots its system
 * prompt per SDK session, so later changes would not reach the model anyway); the
 * `playbook_*` tools give a conversation chat the live state, and the `record_*` tools a chat
 * anchored to a record (docs/memwise/25-literature-poc.md §6).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSessionPath } from './storage.ts';

export const MEMWISE_CONTEXT_FILE = 'memwise-context.json';

/** Largest block kept; longer ones are shortened (the system prompt has to stay reasonable). */
export const MEMWISE_CONTEXT_MAX_CHARS = 24_000;

/** What a chat is anchored to. A record anchor names its entity key (`literature.topic`). */
export type MemwiseChatAnchor =
  | { kind: 'case' | 'step' | 'workflow'; id: string }
  | { kind: 'record'; entity: string; id: string };

export interface SessionMemwiseContext {
  /** What the chat is anchored to. A conversation step is a `step` anchor with `conversation`. */
  anchor: MemwiseChatAnchor;
  /** The chat answers a conversation step: the `playbook_*` tools are offered. */
  conversation?: boolean;
  /**
   * Stage 3 (26 §3): the conversation step is an app's create-project step ("Describe it in
   * chat"): `project_options` and `project_draft` are offered instead of the playbook tools.
   */
  project?: boolean;
  /**
   * Record chats: entity keys (in the record's domain) that say `keep_from_chat`, with their
   * names. Non-empty: `record_keep` is offered (25 §6).
   */
  keep?: { entity: string; name: string }[];
  /** Record chats: the chat was opened on a draft from a domain's question box; `record_update` fills it in. */
  draft?: boolean;
  /** The block's text (inside `<memwise_context>`), already assembled by the host. */
  block: string;
  /** Who the chat acts for, by name (for the rules line). */
  personName?: string;
  setAt: number;
}

export function memwiseContextPath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), MEMWISE_CONTEXT_FILE);
}

export function writeSessionMemwiseContext(workspaceRootPath: string, sessionId: string, ctx: Omit<SessionMemwiseContext, 'setAt'> & { setAt?: number }): SessionMemwiseContext {
  const dir = getSessionPath(workspaceRootPath, sessionId);
  mkdirSync(dir, { recursive: true });
  const value: SessionMemwiseContext = {
    anchor: ctx.anchor.kind === 'record'
      ? { kind: 'record', entity: ctx.anchor.entity, id: ctx.anchor.id }
      : { kind: ctx.anchor.kind, id: ctx.anchor.id },
    ...(ctx.conversation ? { conversation: true } : {}),
    ...(ctx.conversation && ctx.project ? { project: true } : {}),
    ...(ctx.anchor.kind === 'record' && ctx.keep?.length ? { keep: ctx.keep.map((k) => ({ entity: k.entity, name: k.name })) } : {}),
    ...(ctx.anchor.kind === 'record' && ctx.draft ? { draft: true } : {}),
    block: ctx.block.length > MEMWISE_CONTEXT_MAX_CHARS ? `${ctx.block.slice(0, MEMWISE_CONTEXT_MAX_CHARS)}\n… (shortened)` : ctx.block,
    ...(ctx.personName ? { personName: ctx.personName } : {}),
    setAt: ctx.setAt ?? Date.now(),
  };
  const file = join(dir, MEMWISE_CONTEXT_FILE);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
  return value;
}

/** The session's MemWise context, or null when it has none (an ordinary chat) or it can't be read. */
export function readSessionMemwiseContext(workspaceRootPath: string, sessionId: string): SessionMemwiseContext | null {
  try {
    const file = memwiseContextPath(workspaceRootPath, sessionId);
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SessionMemwiseContext>;
    if (!parsed || typeof parsed.block !== 'string' || !parsed.anchor || typeof parsed.anchor.id !== 'string') return null;
    if (parsed.anchor.kind === 'record' && typeof (parsed.anchor as { entity?: unknown }).entity !== 'string') return null;
    return parsed as SessionMemwiseContext;
  } catch {
    return null;
  }
}

/**
 * Whether the session is a conversation-step chat: it gets the `memwise` callbacks (the
 * `playbook_*` tools, or in a create-project chat the `project_*` tools).
 */
export function sessionHasPlaybookTools(workspaceRootPath: string | undefined, sessionId: string | undefined): boolean {
  if (!workspaceRootPath || !sessionId) return false;
  return readSessionMemwiseContext(workspaceRootPath, sessionId)?.conversation === true;
}

/** Whether the session is a chat anchored to a record (offers `record_get` and `record_query`). */
export function sessionHasRecordTools(workspaceRootPath: string | undefined, sessionId: string | undefined): boolean {
  if (!workspaceRootPath || !sessionId) return false;
  return readSessionMemwiseContext(workspaceRootPath, sessionId)?.anchor.kind === 'record';
}

/**
 * Which MemWise session tools a session is offered: `playbook_*` in a conversation-step chat
 * (`project_*` instead when it makes a project),
 * `record_get`/`record_query` in a record chat, and `record_keep` too when the record's domain
 * has an entity with `keep_from_chat`. One read of the context file for all three.
 */
export function memwiseSessionToolOptions(workspaceRootPath: string | undefined, sessionId: string | undefined): {
  includePlaybookTools: boolean;
  includeProjectTools: boolean;
  includeRecordTools: boolean;
  includeRecordKeep: boolean;
  includeRecordUpdate: boolean;
} {
  const ctx = workspaceRootPath && sessionId ? readSessionMemwiseContext(workspaceRootPath, sessionId) : null;
  const record = ctx?.anchor.kind === 'record';
  return {
    includePlaybookTools: ctx?.conversation === true && ctx.project !== true,
    includeProjectTools: ctx?.conversation === true && ctx.project === true,
    includeRecordTools: record,
    includeRecordKeep: record && !!ctx?.keep?.length,
    includeRecordUpdate: record && ctx?.draft === true,
  };
}
