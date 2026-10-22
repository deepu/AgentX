// The walkthrough's regulated data (Stage 5, docs/memwise/26-projects-and-pages.md §11): CR-014 on
// "File a TMF document" (the eTMF example's closest playbook to MW-301's "Chase missing
// documents"), an inspector link for the MHRA inspection, and the project's audit trail, whose AI
// entries come from the cases the walkthrough files (they are never written here: the trail only
// records what happened). Idempotent: a second run finds what the first made.
import type { InspectorPerson } from '@memwise/db';
import type { Kernel, PersonActor } from '../types.ts';
import type { ChangeRequestView, InspectorLinkView } from './types.ts';

export interface RegulatedSeedOptions {
  /** The regulated domain (the project for now). Default `etmf`. */
  project?: string;
  /** Stage 3: the study the inspector link is for (it reaches only that study). Default: `project`. */
  inspectionProject?: string;
  /** The playbook CR-014 changes. Default `file-document`. */
  workflowId?: string;
  /** Raises the change request (a study manager). */
  raiser: PersonActor;
  /** Gives the inspectors access (a domain owner). Default: the raiser. */
  owner?: PersonActor;
  /** The request's number. Default 14 (the paper log ended at CR-013). */
  number?: number;
  inspection?: { name?: string; inspectors?: InspectorPerson[]; days?: number };
}

export interface RegulatedSeed {
  changeRequest: ChangeRequestView;
  /** The MHRA link; `token` and `url` only when this run made it (a token is shown once). */
  inspector: { link: InspectorLinkView; token?: string; url?: string };
  /** AI entries in the project's trail now (0 until a case has been through an AI step). */
  aiEntries: number;
}

export const SEED_CHANGE_TITLE = 'Skip QC for CVs that pass every AI check';
export const SEED_CHANGE_REASON = 'QC of investigator CVs repeats the AI check and holds up site activation. CVs that fail any AI check still go to QC.';
export const SEED_INSPECTION = 'MHRA inspection';

export async function seedRegulatedWalkthrough(kernel: Kernel, opts: RegulatedSeedOptions): Promise<RegulatedSeed> {
  const project = opts.project ?? 'etmf';
  const workflowId = opts.workflowId ?? 'file-document';
  const number = opts.number ?? 14;
  const owner = opts.owner ?? opts.raiser;

  let changeRequest = await kernel.changes.get(`CR-${String(number).padStart(3, '0')}`, opts.raiser, project);
  if (!changeRequest) {
    const existing = await kernel.changes.list({ project }, opts.raiser);
    if (!existing.some((c) => c.number >= number)) await kernel.changes.setNextNumber(project, number);
    changeRequest = await kernel.changes.open({ workflowId, title: SEED_CHANGE_TITLE, reason: SEED_CHANGE_REASON }, opts.raiser);
  }

  const name = opts.inspection?.name ?? SEED_INSPECTION;
  const inspectionProject = opts.inspectionProject ?? project;
  const links = await kernel.inspectors.list(inspectionProject, owner);
  const active = links.find((l) => l.name === name && l.status === 'active');
  let inspector: RegulatedSeed['inspector'];
  if (active) inspector = { link: active };
  else {
    const made = await kernel.inspectors.create({
      project: inspectionProject, name,
      inspectors: opts.inspection?.inspectors ?? [{ name: 'GCP inspector', organisation: 'MHRA' }],
      expiresAt: new Date(Date.now() + (opts.inspection?.days ?? 30) * 86_400_000).toISOString(),
    }, owner);
    inspector = { link: made.link, token: made.token, ...(made.url ? { url: made.url } : {}) };
  }

  const ai = await kernel.auditLog.list({ project, actorKinds: ['ai'], limit: 1000 }, owner);
  return { changeRequest, inspector, aiEntries: ai.entries.length };
}
