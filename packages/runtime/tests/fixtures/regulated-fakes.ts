// Fakes for the regulated-project tests (Stage 5, 26 §8) on the eTMF example: a classifier that
// reads which CV it was given from the file's name, and a verifier that reads the rules it is
// asked to check (no real model). Shared by the kernel test and server-core's exit test.
//
// The classifier: turn 0 reads the Document record (its file name is the evidence), turn 1
// finishes `classified` with the index the test registered for that file, quoting the artifact
// from the file name; an unsigned CV says so in its rationale. The verifier fails a rule about a
// signature when the proposal or its evidence says the document isn't signed, and passes every
// other rule: so a playbook without a signature rule lets an unsigned CV through, and one with it
// doesn't.
import type { ScriptedTurn } from '@memwise/defs';
import { scriptedProvider, type ModelProvider, type ModelRequest, type ModelRoleConfig } from '@memwise/gateway';
import type { DocumentValue, Kernel, PersonActor } from '../../src/types.ts';

export const FAKE_CLASSIFIER_MODEL = 'fake-classifier-1';
export const FAKE_VERIFIER_MODEL = 'fake-verifier-1';
const ROLES = ['router', 'classifier', 'checker', 'verifier', 'extractor', 'explainer'];

export function fakeModelRoles(): Record<string, ModelRoleConfig> {
  return Object.fromEntries(ROLES.map((r) => [r, { provider: 'fake', model: r === 'verifier' ? FAKE_VERIFIER_MODEL : FAKE_CLASSIFIER_MODEL }]));
}

/** What the classifier writes for a file, by file name. */
export interface FakeIndex {
  artifact: string;
  study: string;
  site: string;
  about?: string;
  expected_document: string;
  document_date: string;
  version?: string;
  signed: boolean;
}

const requestText = (r: ModelRequest) => [r.systemPrompt, ...r.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))].join('\n');

/** The rules a verifier request lists, in order. */
function rulesOf(text: string): string[] {
  const block = text.split('## Rules')[1]?.split('## Proposed result')[0] ?? '';
  return block.split('\n').map((l) => /^\d+\.\s+(.*)$/.exec(l.trim())?.[1]).filter((r): r is string => !!r);
}

const UNSIGNED = /not signed|unsigned|no signature|signature line is empty/i;

export function fakeRegulatedProvider(index: Map<string, FakeIndex>): ModelProvider & { calls: { role: string; model: string }[] } {
  const calls: { role: string; model: string }[] = [];
  return {
    id: 'fake',
    calls,
    async complete(model, request, options) {
      calls.push({ role: options.role, model });
      const text = requestText(request);
      let turns: ScriptedTurn[] = [];
      if (options.role === 'verifier') {
        const [, proposal = ''] = text.split('## Proposed result');
        turns = [{ toolCalls: [{ name: 'checkpoint.verdict', args: { results: rulesOf(text).map((rule, i) => {
          const fails = /\bsign/i.test(rule) && UNSIGNED.test(proposal);
          return { rule: i + 1, passed: !fails, reason: fails ? 'The document is not signed, as the result itself says.' : 'Holds on the evidence.' };
        }) } }] }];
      } else if (options.role === 'classifier') {
        const doc = /\bdocu_[A-Za-z0-9]+/.exec(text)?.[0];
        const name = [...index.keys()].find((n) => text.includes(n));
        const ix = name ? index.get(name) : undefined;
        if (doc && name && ix) {
          const { signed, ...writes } = ix;
          turns = [
            { toolCalls: [{ name: 'etmf.document.get', args: { id: doc } }] },
            { toolCalls: [{ name: 'step.finish', args: {
              outcome: 'classified', writes,
              quotes: { artifact: ix.artifact },
              rationale: signed
                ? `${ix.artifact}, signed and dated on the last page; the expected document of its site.`
                : `${ix.artifact}: the CV is not signed, the signature line is empty.`,
            } }] },
          ];
        }
      }
      return scriptedProvider({ [options.role]: turns }).complete(model, request, options);
    },
  };
}

/** A file to classify: its name is how the fake classifier knows it. */
export function cvFile(name: string): { name: string; mime: string; data: Uint8Array } {
  return { name, mime: 'application/pdf', data: new TextEncoder().encode(`%PDF-1.4\n% ${name}\n`) };
}

export async function until<T>(what: string, get: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)?.slice(0, 2000)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Starts "File a TMF document" for a file and waits until it waits at QC (or ended elsewhere). */
export async function fileAtQc(kernel: Kernel, file: DocumentValue): Promise<{ runId: string; caseId: string }> {
  const started = await kernel.startRun({
    workflowId: 'file-document', by: 'test',
    case: { original: file, sender: 'coordinator@site.example', received_at: new Date().toISOString() },
  });
  const run = await kernel.waitForRun(started.runId, { until: (r) => r.state === 'qc' || r.status !== 'active' || r.state === 'needs_person', timeoutMs: 60_000 });
  if (run.state !== 'qc') {
    const view = await kernel.getCaseView(started.caseId, { kind: 'system' });
    const why = view?.stepRuns.map((s) => `${s.stepId}:${s.status}:${s.outcome ?? ''}:${s.rationale ?? ''}`).join(' | ');
    const records = await Promise.all((view?.stepRuns ?? []).map((s) => kernel.getStepRecord(s.stepRunId)));
    const checks = records.map((r) => JSON.stringify(r?.journal.map((j) => [j.journalKey, j.error, JSON.stringify(j.response)?.slice(0, 300)]) ?? [])).join(' | ');
    throw new Error(`the case of ${file.name} went to ${run.state} (${run.status}), not QC: ${why} ${checks}`);
  }
  return started;
}

/** The TMF specialist's QC answer, signed. */
export async function answerQc(kernel: Kernel, by: PersonActor, password: string, caseId: string, outcome: 'approved' | 'sent_back', comment?: string) {
  const item = await until('the QC item', () => kernel.inbox(by), (xs) => xs.some((i) => 'caseId' in i && i.caseId === caseId && 'stepId' in i && i.stepId === 'qc'));
  const qc = item.find((i) => 'caseId' in i && i.caseId === caseId && 'stepId' in i && i.stepId === 'qc')! as { stepRunId: string };
  const r = await kernel.submitStep({
    stepRunId: qc.stepRunId, outcome, by, signature: { password },
    values: outcome === 'sent_back' ? { qc_comment: comment ?? 'Not signed. Please sign and date it and send it again.' } : { ...(comment ? { qc_comment: comment } : {}) },
  });
  if (!r.applied) throw new Error(`QC was not applied: ${r.status} ${r.message ?? ''}`);
  return r;
}
