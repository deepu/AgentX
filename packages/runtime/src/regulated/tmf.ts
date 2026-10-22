// The TMF index (26 §7, D119): a study's trial master file by zone of the TMF Reference Model,
// expected documents (the study plan: ExpectedDocument records) against what is filed, missing,
// waiting for QC and filed late, per zone and per site. Read from a project's `Document` and
// `ExpectedDocument` records; a document's zone comes from its artifact's name.
import { PgEntityStore, withActor, type StoredEntityRow } from '@memwise/db';
import { keyOf, type EntityTypeDef } from '@memwise/defs';
import type pg from 'pg';
import { entityByName, recordTitle } from '../records/context.ts';
import type { Actor } from '../types.ts';
import type { TmfIndex, TmfService, TmfSiteRow, TmfZoneRow } from './types.ts';

/** The eleven zones of the TMF Reference Model (version 3). The app shows them translated by id. */
export const TMF_ZONES: { number: string; id: string; name: string }[] = [
  { number: '01', id: 'trial-management', name: 'Trial Management' },
  { number: '02', id: 'central-trial-documents', name: 'Central Trial Documents' },
  { number: '03', id: 'regulatory', name: 'Regulatory' },
  { number: '04', id: 'irb-iec-approvals', name: 'IRB or IEC and other Approvals' },
  { number: '05', id: 'site-management', name: 'Site Management' },
  { number: '06', id: 'ip-trial-supplies', name: 'IP and Trial Supplies' },
  { number: '07', id: 'safety-reporting', name: 'Safety Reporting' },
  { number: '08', id: 'central-local-testing', name: 'Central and Local Testing' },
  { number: '09', id: 'third-parties', name: 'Third Parties' },
  { number: '10', id: 'data-management', name: 'Data Management' },
  { number: '11', id: 'statistics', name: 'Statistics' },
];

/**
 * Artifact names to zones, by the words in the name (first match wins, so the more specific
 * patterns come first). Covers the artifacts studies file most; an artifact none matches is
 * listed as unplaced rather than guessed.
 */
const ARTIFACT_ZONES: [RegExp, string][] = [
  [/\b(protocol|investigator) signature page\b|\bsignature page\b/i, '05'],
  [/\blab(oratory)? (normal )?ranges?\b|\bnormal ranges?\b|\blab(oratory)? (certification|accreditation|certificate)\b/i, '08'],
  [/\b(ethics|irb|iec|institutional review|ethics committee)\b/i, '04'],
  [/\b(sae|susar|dsur|safety|adverse event|pharmacovigilance)\b/i, '07'],
  [/\b(statistical analysis|randomi[sz]ation|sap\b|statistic)/i, '11'],
  [/\b(data management|database|crf completion|data validation|edc)\b/i, '10'],
  [/\b(investigational product|\bip\b|imp\b|shipment|accountability|temperature log|drug|supply|supplies|label)/i, '06'],
  [/\b(regulatory|competent authority|clinical trial application|cta\b|import licen[cs]e|ind\b)/i, '03'],
  [/\b(vendor|third.party|subcontract|cro oversight)\b/i, '09'],
  [/\b(cv|curriculum vitae|delegation|site (signature|staff|contact|initiation|training)|medical licen[cs]e|gcp (training|certificate)|financial disclosure|monitoring visit|visit report|screening log|enrol?ment log|confidentiality agreement|clinical trial agreement|site agreement|feasibility)\b/i, '05'],
  [/\b(protocol|investigator'?s? brochure|informed consent|icf|crf\b|case report form|patient (materials|card|diary))\b/i, '02'],
  [/\b(trial management|tmf plan|monitoring plan|communication plan|project plan|meeting minutes|training plan|note to file|file note)\b/i, '01'],
];

/** The zone number an artifact belongs to, or undefined when the model doesn't place it. */
export function zoneOfArtifact(artifact: string | undefined): string | undefined {
  if (!artifact) return undefined;
  return ARTIFACT_ZONES.find(([re]) => re.test(artifact))?.[1];
}

/** Days after the document's date beyond which filing counts as late (inspectors ask about these). */
export const LATE_AFTER_DAYS = 30;
const DAY_MS = 86_400_000;

export interface TmfDeps {
  pool: pg.Pool;
  entities(): Record<string, EntityTypeDef>;
}

const entityStore = new PgEntityStore();

const zoneById = (z: string | undefined) => TMF_ZONES.find((x) => x.number === z || x.id === z);

export function createTmfService(deps: TmfDeps): TmfService {
  return {
    async index(input, actor) {
      const entities = deps.entities();
      const docDef = entityByName(entities, 'Document', input.project);
      const expDef = entityByName(entities, 'ExpectedDocument', input.project);
      if (!docDef || !expDef) throw new Error(`${input.project} keeps no TMF: it needs Document and ExpectedDocument records`);
      const siteDef = entityByName(entities, 'Site', input.project);
      const studyDef = entityByName(entities, 'Study', input.project);

      const [docs, expected, sites] = await withActor(deps.pool, actor as Actor, async (db) => [
        await entityStore.list(db, docDef, { limit: 100_000 }),
        await entityStore.list(db, expDef, { limit: 100_000 }),
        siteDef ? await entityStore.list(db, siteDef, { limit: 10_000 }) : [],
      ] as StoredEntityRow[][]);
      // Stage 3: a study project's records (and those every project of the app shares).
      const inProjects = (r: StoredEntityRow) => !input.projects || r.project === undefined || input.projects.includes(r.project);
      const inStudy = (r: StoredEntityRow) => inProjects(r) && (!input.study || r.values.study === input.study);
      const docRows = docs!.filter(inStudy);
      const expRows = expected!.filter(inStudy);
      const siteLabel = new Map(sites!.map((s) => [s.id, recordTitle(siteDef!, s.id, s.values)]));

      // When each document entered QC and was filed: the first version in that state.
      const ids = docRows.map((d) => d.id);
      const { rows: times } = ids.length ? await deps.pool.query<{ record_id: string; state: string; at: Date }>(
        `select record_id, "values" ->> 'status' as state, min(at) as at from mw.record_versions
          where entity = $1 and record_id = any($2::text[]) and "values" ->> 'status' in ('in_qc', 'filed')
          group by record_id, "values" ->> 'status'`, [keyOf(docDef), ids]) : { rows: [] };
      const enteredQc = new Map<string, number>();
      const filedAt = new Map<string, number>();
      for (const t of times) (t.state === 'in_qc' ? enteredQc : filedAt).set(t.record_id, t.at.getTime());

      const now = Date.now();
      const status = (r: StoredEntityRow) => r.lifecycle ?? String(r.values.status ?? '');
      const late = (d: StoredEntityRow) => {
        const filed = filedAt.get(d.id);
        const dated = typeof d.values.document_date === 'string' ? Date.parse(d.values.document_date) : NaN;
        return status(d) === 'filed' && filed !== undefined && Number.isFinite(dated) && filed - dated > LATE_AFTER_DAYS * DAY_MS;
      };
      // An expected document is filed, waiting for QC (a document that fills it is in QC), or missing.
      const inQcFor = new Map<string, StoredEntityRow>();
      for (const d of docRows) if (status(d) === 'in_qc' && typeof d.values.fills === 'string') inQcFor.set(d.values.fills, d);
      const expState = (e: StoredEntityRow): 'filed' | 'in_qc' | 'missing' =>
        status(e) === 'filed' ? 'filed' : inQcFor.has(e.id) ? 'in_qc' : 'missing';

      const unplaced = new Set<string>();
      const zoneOf = (artifact: unknown) => {
        const z = zoneOfArtifact(typeof artifact === 'string' ? artifact : undefined);
        if (!z && typeof artifact === 'string' && artifact) unplaced.add(artifact);
        return z;
      };
      const rowFor = (number: string): TmfZoneRow => {
        const z = TMF_ZONES.find((x) => x.number === number)!;
        return { number, id: z.id, name: z.name, expected: 0, filed: 0, missing: 0, inQc: 0, filedLate: 0 };
      };
      const zones = new Map(TMF_ZONES.map((z) => [z.number, rowFor(z.number)]));
      for (const e of expRows) {
        const row = zones.get(zoneOf(e.values.artifact) ?? '');
        if (!row) continue;
        row.expected++;
        const s = expState(e);
        if (s === 'filed') row.filed++; else if (s === 'in_qc') row.inQc++; else row.missing++;
      }
      for (const d of docRows) {
        const row = zones.get(zoneOf(d.values.artifact) ?? '');
        if (row && late(d)) row.filedLate++;
      }

      const inQcDocs = docRows.filter((d) => status(d) === 'in_qc');
      const oldest = inQcDocs.map((d) => enteredQc.get(d.id)).filter((t): t is number => t !== undefined).sort((a, b) => a - b)[0];
      const totals = [...zones.values()].reduce((acc, z) => ({ expected: acc.expected + z.expected, filed: acc.filed + z.filed, missing: acc.missing + z.missing, inQc: acc.inQc + z.inQc }), { expected: 0, filed: 0, missing: 0, inQc: 0 });
      const result: TmfIndex = {
        project: input.project,
        kpis: {
          ...totals, oldestInQcDays: oldest === undefined ? null : Math.floor((now - oldest) / DAY_MS),
          filedLate: docRows.filter(late).length, lateAfterDays: LATE_AFTER_DAYS,
        },
        zones: [...zones.values()],
        unplaced: [...unplaced].sort(),
      };
      if (input.study && studyDef) {
        const study = await withActor(deps.pool, actor as Actor, (db) => entityStore.get(db, studyDef, input.study!));
        if (study) result.study = { id: study.id, label: recordTitle(studyDef, study.id, study.values) };
      } else if (input.projects && studyDef) {
        // A study project holds its one Study record.
        const studies = (await withActor(deps.pool, actor as Actor, (db) => entityStore.list(db, studyDef, { limit: 1000 })))
          .filter((r) => r.project !== undefined && input.projects!.includes(r.project));
        if (studies.length === 1) result.study = { id: studies[0]!.id, label: recordTitle(studyDef, studies[0]!.id, studies[0]!.values) };
      }

      const zone = input.zone ? zoneById(input.zone) : undefined;
      if (input.zone && !zone) throw new Error(`there is no TMF zone ${input.zone}`);
      if (zone) {
        const inZone = (artifact: unknown) => zoneOf(artifact) === zone.number;
        const bySite = new Map<string, TmfSiteRow>();
        for (const e of expRows.filter((x) => inZone(x.values.artifact))) {
          const site = typeof e.values.site === 'string' ? e.values.site : '';
          const row = bySite.get(site) ?? { siteId: site, label: siteLabel.get(site) ?? site, expected: 0, filed: 0, missing: 0, inQc: 0 };
          row.expected++;
          const s = expState(e);
          if (s === 'filed') row.filed++; else if (s === 'in_qc') row.inQc++; else row.missing++;
          bySite.set(site, row);
        }
        result.zone = {
          row: zones.get(zone.number)!,
          sites: [...bySite.values()].sort((a, b) => a.label.localeCompare(b.label)),
          documents: docRows.filter((d) => inZone(d.values.artifact) && ['filed', 'in_qc'].includes(status(d))).map((d) => ({
            entity: keyOf(docDef), id: d.id, title: recordTitle(docDef, d.id, d.values),
            ...(typeof d.values.artifact === 'string' ? { artifact: d.values.artifact } : {}),
            ...(typeof d.values.site === 'string' ? { site: siteLabel.get(d.values.site) ?? d.values.site } : {}),
            status: status(d), filedLate: late(d),
            ...(status(d) === 'in_qc' && enteredQc.has(d.id) ? { inQcDays: Math.floor((now - enteredQc.get(d.id)!) / DAY_MS) } : {}),
          })),
          missing: expRows.filter((e) => inZone(e.values.artifact) && expState(e) === 'missing').map((e) => ({
            id: e.id, artifact: String(e.values.artifact ?? ''),
            ...(typeof e.values.site === 'string' ? { site: siteLabel.get(e.values.site) ?? e.values.site } : {}),
            ...(typeof e.values.due_date === 'string' ? { dueDate: e.values.due_date } : {}),
          })),
        };
      }
      return result;
    },
  };
}
