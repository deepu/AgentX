// kernel.audit (24 §9): a record's audit trail and its export. The trail is everything an
// inspector asks for about one record: its values now, every version with who, when (server
// time), why and its hash, whether the hash chain still holds, the signatures and whether each
// still matches the record, the cases and step runs that touched it, and its flags. The export
// is the same as JSON, or as a plain paginated PDF (title page, versions, signature manifest,
// chain result).
import { PgEntityStore, PgFlagStore, PgRecordVersions, withActor } from '@memwise/db';
import { keyOf, type EntityTypeDef } from '@memwise/defs';
import type { Actor, AuditService, AuditTrail } from '../types.ts';
import { domainDef, domainOfEntity, entityByName, recordTitle, type RecordsDeps } from '../records/context.ts';
import { byLabels, signatureViews, versionSummary } from '../records/page.ts';
import { PdfDocument } from './pdf.ts';

const entityStore = new PgEntityStore();
const versionStore = new PgRecordVersions();
const flagStore = new PgFlagStore();

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

/** "25 years" from a retention in milliseconds. */
export function retentionText(ms: number | undefined): string {
  if (!ms) return 'not set';
  const day = 86_400_000;
  const years = ms / (365 * day);
  if (years >= 1 && Number.isInteger(Math.round(years * 100) / 100)) return `${Math.round(years)} year${Math.round(years) === 1 ? '' : 's'}`;
  return `${Math.round(ms / day)} days`;
}

const shown = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '-';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.name === 'string' && typeof o.sha256 === 'string') return `${o.name} (sha256 ${String(o.sha256).slice(0, 12)}…)`;
    return JSON.stringify(v);
  }
  return String(v);
};

export function createAuditService(deps: RecordsDeps): AuditService {
  const defOf = (entity: string): EntityTypeDef => {
    const def = entityByName(deps.entities(), entity);
    if (!def) throw new Error(`there is no entity type ${entity}`);
    return def;
  };

  async function trail(entity: string, id: string, actor: Actor): Promise<AuditTrail | undefined> {
    const def = defOf(entity);
    const key = keyOf(def);
    const project = deps.project();
    const domain = domainDef(project, domainOfEntity(def));
    const row = await withActor(deps.pool, actor, (db) => entityStore.get(db, def, id));
    if (!row) return undefined;
    const values: Record<string, unknown> = { ...row.values, ...(row.lifecycle ? { status: row.lifecycle } : {}) };

    const versions = await versionStore.list(deps.pool, key, id);
    const labels = await byLabels(deps, versions);
    const chain = await versionStore.verifyChain(deps.pool, key, id);
    const signatures = await signatureViews(deps.pool, def, id, row.values);
    const flags = [
      ...(await flagStore.list(deps.pool, { entity: key, recordId: id, open: true, limit: 1000 })),
      ...(await flagStore.list(deps.pool, { entity: key, recordId: id, open: false, limit: 1000 })),
    ];

    // The cases that touched it: by the step runs that wrote its versions or signed it, and the
    // cases whose values name it.
    const stepRuns = new Set<string>();
    for (const v of versions) {
      if (v.by.startsWith('step:')) stepRuns.add(v.by.slice(5));
      if (v.via && v.via !== 'app' && v.via.includes('/')) stepRuns.add(v.via);
    }
    for (const s of signatures) if (s.stepRunId) stepRuns.add(s.stepRunId);
    const caseIds = new Set<string>(signatures.map((s) => s.caseId).filter(Boolean));
    if (stepRuns.size) {
      const { rows } = await deps.pool.query<{ case_id: string }>('select distinct case_id from mw.step_runs where id = any($1::text[])', [[...stepRuns]]);
      for (const r of rows) caseIds.add(r.case_id);
    }
    {
      const { rows } = await deps.pool.query<{ id: string }>(
        `select id from mw.cases c where exists (select 1 from jsonb_each(c.values) e where e.value ->> 'value' = $1)`, [id]);
      for (const r of rows) caseIds.add(r.id);
    }
    const cases: AuditTrail['cases'] = [];
    if (caseIds.size) {
      const { rows: caseRows } = await deps.pool.query<{ id: string; workflow_id: string; workflow_hash: string; created_at: Date }>(
        'select id, workflow_id, workflow_hash, created_at from mw.cases where id = any($1::text[]) order by created_at, id', [[...caseIds]]);
      const { rows: runRows } = await deps.pool.query<{
        id: string; case_id: string; step_id: string; performer: string; outcome: string | null; decided_by: string | null; started_at: Date; finished_at: Date | null;
      }>(
        `select id, case_id, step_id, performer, outcome, decided_by, started_at, finished_at from mw.step_runs
          where case_id = any($1::text[]) order by started_at, id`, [[...caseIds]]);
      for (const c of caseRows) {
        const wf = await deps.defs.workflow(c.workflow_id, c.workflow_hash).catch(() => undefined);
        cases.push({
          caseId: c.id, workflowId: c.workflow_id, title: wf?.title ?? c.workflow_id,
          stepRuns: runRows.filter((r) => r.case_id === c.id).map((r) => ({
            stepRunId: r.id, stepId: r.step_id, performer: r.performer, ...(r.outcome ? { outcome: r.outcome } : {}),
            ...(r.decided_by ? { decidedBy: r.decided_by } : {}), at: iso(r.finished_at ?? r.started_at),
          })),
        });
      }
    }

    return {
      entity: key, id, title: recordTitle(def, id, values), domain: domain.id, regulated: !!domain.regulated,
      ...(domain.retentionMs !== undefined ? { retentionMs: domain.retentionMs } : {}),
      values,
      versions: versions.map((v) => ({ ...versionSummary(v, labels), values: v.values, prevHash: v.prevHash })),
      chain, signatures, cases, flags: flags.map(({ domain: _d, ...f }) => f), exportedAt: new Date().toISOString(),
    };
  }

  return {
    trail,
    async verifyChain(entity, id) {
      const def = defOf(entity);
      return versionStore.verifyChain(deps.pool, keyOf(def), id);
    },
    async export(entity, id, format, actor) {
      const t = await trail(entity, id, actor);
      if (!t) return undefined;
      const base = `audit-${t.entity.replace(/[^A-Za-z0-9]+/g, '-')}-${id}`.replace(/-+/g, '-');
      if (format === 'json') {
        return { name: `${base}.json`, mime: 'application/json', data: new TextEncoder().encode(`${JSON.stringify(t, null, 2)}\n`) };
      }
      return { name: `${base}.pdf`, mime: 'application/pdf', data: auditPdf(t, deps.project()?.workspace?.name) };
    },
  };
}

/** The audit trail as a PDF: title page, current values, versions, signature manifest, cases, chain result. */
export function auditPdf(t: AuditTrail, workspace?: string): Uint8Array {
  const pdf = new PdfDocument({
    title: `Audit trail: ${t.title}`, subject: `${t.entity} ${t.id}`, author: workspace ?? 'MemWise',
    footer: `${workspace ? `${workspace} · ` : ''}Audit trail of ${t.entity} ${t.id}`, createdAt: new Date(t.exportedAt),
  });
  pdf.heading('Audit trail', 20).text(t.title, { size: 14, bold: true, after: 10 });
  pdf.pairs([
    ['Record', `${t.entity} ${t.id}`],
    ['Domain', `${t.domain}${t.regulated ? ' (regulated)' : ''}`],
    ['Retention', retentionText(t.retentionMs)],
    ['Versions', String(t.versions.length)],
    ['Signatures', String(t.signatures.length)],
    ['Hash chain', t.chain.ok ? 'intact: every version matches its hash and follows the one before' : `BROKEN at version ${t.chain.brokenAt ?? '?'}: ${t.chain.message ?? ''}`],
    ['Exported', `${t.exportedAt} (server time, UTC)`],
  ]);
  pdf.space(12).heading('Current values');
  pdf.pairs(Object.entries(t.values).map(([k, v]) => [k, shown(v)]));

  pdf.newPage().heading('Versions');
  pdf.table(['#', 'When (UTC)', 'Who', 'Why', 'Changed', 'Hash'],
    t.versions.map((v) => [String(v.version), v.at.replace('T', ' ').slice(0, 19), v.byLabel ?? v.by, v.reason ?? '-', v.changed.join(', ') || '-', v.hash.slice(0, 16)]),
    [0.05, 0.17, 0.18, 0.28, 0.17, 0.15]);
  for (const v of t.versions) {
    pdf.space(6).text(`Version ${v.version}`, { bold: true, size: 9 });
    pdf.text(`previous hash ${v.prevHash}`, { size: 7 }).text(`hash ${v.hash}`, { size: 7 });
    pdf.text(Object.entries(v.values).map(([k, x]) => `${k}: ${shown(x)}`).join('; ') || '(no values)', { size: 8 });
  }

  pdf.newPage().heading('Signature manifest');
  if (!t.signatures.length) pdf.text('No signatures.');
  for (const s of t.signatures) {
    pdf.pairs([
      ['Signed by', `${s.name} (${s.personId})`],
      ['Meaning', s.meaning],
      ['When', `${s.at} (server time, UTC)`],
      ['Content hash', s.contentHash],
      ['Case / step', `${s.caseId || '-'} / ${s.stepRunId || '-'}`],
      ['Still matches', s.changedSince ? 'no: the record changed since it was signed' : 'yes'],
    ]).space(8);
  }

  pdf.space(6).heading('Cases and steps');
  if (!t.cases.length) pdf.text('No cases touched this record.');
  for (const c of t.cases) {
    pdf.text(`${c.title} (case ${c.caseId})`, { bold: true, size: 10 });
    pdf.table(['Step', 'Done by', 'Outcome', 'When (UTC)'],
      c.stepRuns.map((r) => [r.stepId, r.decidedBy ?? r.performer, r.outcome ?? '-', r.at.replace('T', ' ').slice(0, 19)]), [0.3, 0.3, 0.2, 0.2]);
    pdf.space(6);
  }

  pdf.space(6).heading('Flags');
  if (!t.flags.length) pdf.text('No flags.');
  else pdf.table(['Rule', 'Raised', 'Closed'], t.flags.map((f) => [f.invariant, f.raisedAt.slice(0, 19), f.closedAt?.slice(0, 19) ?? 'open']), [0.6, 0.2, 0.2]);

  pdf.space(10).heading('Chain check');
  pdf.text(t.chain.ok
    ? `The ${t.versions.length} versions form an unbroken hash chain: each version's hash covers its content and the hash of the one before.`
    : `The chain is broken at version ${t.chain.brokenAt ?? '?'}: ${t.chain.message ?? 'a version does not match its hash'}.`);
  return pdf.bytes();
}
