// A project's audit log (26 §8, D77, D118): record versions, signatures and settled step records
// (written by triggers, so no write path skips them), and what the kernel adds: change requests,
// inspector views and downloads, exports. Each entry is chained to the one before; the export is
// signed with the kernel's Ed25519 key, so `memwise audit verify` can check a file on its own.
import crypto from 'node:crypto';
import {
  canonicalJson, checkAuditChain, PgAuditLog, PgEntityStore, type AuditEntryRow, type NewAuditEntry, type Queryable,
} from '@memwise/db';
import { keyOf, type EntityTypeDef } from '@memwise/defs';
import type pg from 'pg';
import { kernelKey } from '../external/links.ts';
import { entityByName, recordTitle } from '../records/context.ts';
import type { Actor } from '../types.ts';
import type { DefinitionCache } from '../views.ts';
import type { AuditEntry, AuditEntryView, AuditExport, AuditLogService, AuditQuery, AuditVerifyResult } from './types.ts';

export const AUDIT_EXPORT_FORMAT = 'memwise-audit/1';
const SIGNING_KEY = 'audit-export-ed25519';
/** Entries one export holds at most. */
const MAX_EXPORT = 100_000;

export interface AuditLogDeps {
  pool: pg.Pool;
  entities(): Record<string, EntityTypeDef>;
  defs: DefinitionCache;
  people: import('@memwise/db').PgPeopleStore;
}

const log = new PgAuditLog();
const entityStore = new PgEntityStore();

// PKCS#8 DER prefix of an Ed25519 private key; the 32-byte seed follows it.
const ED25519_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');

/** The kernel's audit signing key pair, from a seed in mw.kernel_keys (made on first use). */
export async function auditSigningKey(db: Queryable): Promise<{ privateKey: crypto.KeyObject; publicKey: string }> {
  const seed = await kernelKey(db, SIGNING_KEY);
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, seed]), format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
  return { privateKey, publicKey };
}

/** What the signature covers: the canonical JSON of the export without its signature. */
const signedBytes = (doc: Omit<AuditExport, 'signature'>) => Buffer.from(canonicalJson(doc), 'utf8');

const toEntry = (r: AuditEntryRow): AuditEntry => ({ ...r });

function asRows(entries: unknown): AuditEntryRow[] | undefined {
  if (!Array.isArray(entries)) return undefined;
  for (const e of entries) {
    if (!e || typeof e !== 'object') return undefined;
    const x = e as Record<string, unknown>;
    if (typeof x.id !== 'string' || typeof x.hash !== 'string' || typeof x.prevHash !== 'string' || typeof x.seq !== 'number') return undefined;
  }
  return entries as AuditEntryRow[];
}

/**
 * Checks an export with no database: every entry's hash, the links between entries, and the
 * signature over the file (by the public key in it; `trustedKey` says whether that key is ours).
 */
export function verifyAuditExport(doc: unknown, trustedKey?: string): AuditVerifyResult {
  const d = doc as Partial<AuditExport> | null;
  const entries = asRows(d?.entries);
  if (!d || d.format !== AUDIT_EXPORT_FORMAT || !entries) {
    return { ok: false, entries: 0, chain: { ok: false, message: 'not a MemWise audit export' }, message: 'This is not a MemWise audit export.' };
  }
  const chain = checkAuditChain(entries, { complete: d.complete === true });
  let signature: AuditVerifyResult['signature'];
  if (typeof d.publicKey === 'string' && typeof d.signature === 'string') {
    let ok = false;
    try {
      const { signature: sig, ...rest } = d as AuditExport;
      const key = crypto.createPublicKey({ key: Buffer.from(d.publicKey, 'base64'), format: 'der', type: 'spki' });
      ok = crypto.verify(null, signedBytes(rest), key, Buffer.from(sig, 'base64'));
    } catch { ok = false; }
    signature = { ok, publicKey: d.publicKey, ...(trustedKey ? { trusted: trustedKey === d.publicKey } : {}) };
  } else {
    signature = { ok: false, publicKey: '' };
  }
  const ok = chain.ok && signature.ok && signature.trusted !== false;
  const message = !chain.ok ? `The chain is broken: ${chain.message}.`
    : !signature.ok ? 'The chain holds, but the signature does not match: the file was changed after it was exported.'
    : signature.trusted === false ? 'The chain and signature hold, but the file was signed by another key than this workspace\'s.'
    : `The chain holds for all ${entries.length} entries and the signature is valid.`;
  return { ok, entries: entries.length, chain: { ok: chain.ok, ...(chain.brokenAt ? { brokenAt: chain.brokenAt } : {}), ...(chain.message ? { message: chain.message } : {}) }, signature, message };
}

/** The cases that touched a record: their values name it, or their step runs wrote or signed it. */
async function casesOfRecord(db: Queryable, entity: string, recordId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `select c.id from mw.cases c where exists (select 1 from jsonb_each(c.values) e where e.value ->> 'value' = $2)
     union select s.case_id from mw.signatures s where s.entity = $1 and s.record_id = $2 and s.case_id is not null
     union select st.case_id from mw.record_versions v join mw.step_runs st on st.id = v.via where v.entity = $1 and v.record_id = $2`,
    [entity, recordId]);
  return rows.map((r) => r.id);
}

export function createAuditLogService(deps: AuditLogDeps): AuditLogService {
  /** Titles of the records, steps and playbooks entries name. */
  async function readable(entries: AuditEntryRow[]): Promise<AuditEntryView[]> {
    const titles = new Map<string, string>();
    const entities = deps.entities();
    for (const e of entries) {
      if (!e.entity || !e.recordId) continue;
      const k = `${e.entity}:${e.recordId}`;
      if (titles.has(k)) continue;
      const def = entityByName(entities, e.entity);
      if (!def) continue;
      const row = await entityStore.get(deps.pool, def, e.recordId).catch(() => undefined);
      if (row) titles.set(k, recordTitle(def, e.recordId, { ...row.values, ...(row.lifecycle ? { status: row.lifecycle } : {}) }));
    }
    const workflows = new Map<string, import('@memwise/defs').WorkflowDef | undefined>();
    const workflowOf = async (id: string) => {
      if (!workflows.has(id)) workflows.set(id, await deps.defs.latest(id).catch(() => undefined));
      return workflows.get(id);
    };
    const out: AuditEntryView[] = [];
    for (const e of entries) {
      const v: AuditEntryView = toEntry(e);
      const title = e.entity && e.recordId ? titles.get(`${e.entity}:${e.recordId}`) : undefined;
      if (title) v.recordTitle = title;
      const wfId = typeof e.data.workflow === 'string' ? e.data.workflow : undefined;
      if (wfId) {
        const wf = await workflowOf(wfId);
        if (wf?.title) v.playbookTitle = wf.title;
        const step = typeof e.data.step === 'string' ? wf?.steps[e.data.step] : undefined;
        if (step?.title) v.stepTitle = step.title;
      }
      out.push(v);
    }
    return out;
  }

  async function rows(q: AuditQuery, limit: number): Promise<AuditEntryRow[]> {
    let caseIds: string[] | undefined;
    if (q.entity && q.recordId) {
      const def = entityByName(deps.entities(), q.entity);
      caseIds = await casesOfRecord(deps.pool, def ? keyOf(def) : q.entity, q.recordId);
    }
    const def = q.entity ? entityByName(deps.entities(), q.entity) : undefined;
    return log.list(deps.pool, {
      project: q.project, ...(q.entity ? { entity: def ? keyOf(def) : q.entity } : {}), ...(q.recordId ? { recordId: q.recordId } : {}),
      ...(caseIds ? { caseIds } : {}), ...(q.caseId ? { caseId: q.caseId } : {}), ...(q.actorKinds?.length ? { actorKinds: q.actorKinds } : {}),
      ...(q.actions?.length ? { actions: q.actions } : {}), ...(q.afterSeq ? { afterSeq: q.afterSeq } : {}), limit,
    });
  }

  const actorName = async (actor: Actor) => actor.kind === 'person' ? (await deps.people.get(actor.personId))?.name ?? actor.personId : 'system';

  return {
    async list(q, actor) {
      void actor;
      const entries = await rows(q, Math.min(q.limit ?? 500, 5000));
      const chain = await log.verify(deps.pool, q.project);
      return { entries: await readable(entries), chain: { ok: chain.ok, ...(chain.message ? { message: chain.message } : {}) } };
    },

    async export(q, actor) {
      const entries = await rows({ ...q, afterSeq: 0 }, MAX_EXPORT);
      const filtered = !!(q.entity || q.recordId || q.caseId || q.actorKinds?.length || q.actions?.length);
      const { privateKey, publicKey } = await auditSigningKey(deps.pool);
      const by = actor.kind === 'person' ? actor.personId : 'system';
      const doc: Omit<AuditExport, 'signature'> = {
        format: AUDIT_EXPORT_FORMAT, project: q.project,
        filter: {
          ...(q.entity ? { entity: q.entity } : {}), ...(q.recordId ? { recordId: q.recordId } : {}), ...(q.caseId ? { caseId: q.caseId } : {}),
          ...(q.actorKinds?.length ? { actorKinds: q.actorKinds } : {}), ...(q.actions?.length ? { actions: q.actions } : {}),
        },
        complete: !filtered,
        exportedAt: new Date().toISOString(), exportedBy: await actorName(actor),
        entries: entries.map(toEntry), publicKey,
      };
      const signature = crypto.sign(null, signedBytes(doc), privateKey).toString('base64');
      await log.append(deps.pool, {
        project: q.project, actorKind: actor.kind === 'person' ? 'person' : 'system', actor: by,
        ...(actor.kind === 'person' ? { actorLabel: doc.exportedBy } : {}), action: 'audit.exported',
        ...(q.entity ? { entity: q.entity } : {}), ...(q.recordId ? { recordId: q.recordId } : {}),
        data: { entries: entries.length, complete: doc.complete, lastSeq: entries.at(-1)?.seq ?? 0 },
      });
      return { ...doc, signature };
    },

    async verify(input) {
      if ('export' in input) {
        const { publicKey } = await auditSigningKey(deps.pool);
        return verifyAuditExport(input.export, publicKey);
      }
      const chain = await log.verify(deps.pool, input.project);
      return {
        ok: chain.ok, entries: chain.entries,
        chain: { ok: chain.ok, ...(chain.brokenAt ? { brokenAt: chain.brokenAt } : {}), ...(chain.message ? { message: chain.message } : {}) },
        message: chain.ok ? `The chain holds for all ${chain.entries} entries.` : `The chain is broken: ${chain.message}.`,
      };
    },

    append: (entry: NewAuditEntry) => log.append(deps.pool, entry),
  };
}
