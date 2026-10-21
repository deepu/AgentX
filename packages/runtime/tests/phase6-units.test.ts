// Phase 6 records helpers without a database: review inference, record titles, what a signature
// covers, start fields, the password rule and plain-words flags.
import { describe, expect, test } from 'bun:test';
import { loadProject, type ProjectDefs } from '@memwise/defs';
import { fileURLToPath } from 'node:url';
import { groupLabel } from '../src/records/browse.ts';
import { flagMessage } from '../src/records/consumers.ts';
import { entityByName, recordTitle } from '../src/records/context.ts';
import { stepReview } from '../src/records/review.ts';
import { recordContentHash, signableValues } from '../src/regulated/content.ts';
import { checkPasswordRule } from '../src/regulated/passwords.ts';
import { isRegulatedPlaybook, signedRecordField, signingStep } from '../src/regulated/signatures.ts';
import { startFields } from '../src/start.ts';

const PROJECT = fileURLToPath(new URL('./fixtures/records-project', import.meta.url));
const load = async (): Promise<ProjectDefs> => (await loadProject(PROJECT)).project;

describe('Phase 6 records helpers', () => {
  test('entity types by key or bare name in a domain; titles from the template', async () => {
    const p = await load();
    expect(entityByName(p.entities, 'Instrument', 'lab')?.domain).toBe('lab');
    expect(entityByName(p.entities, 'Instrument', 'qa')?.domain).toBe('qa');
    expect(entityByName(p.entities, 'lab.Instrument')?.entity).toBe('Instrument');
    const lab = p.entities['lab.Instrument']!;
    expect(recordTitle(lab, 'inst_1', { serial: 'SN-1', model: 'Autoclave' })).toBe('SN-1 · Autoclave');
    expect(recordTitle(lab, 'inst_1', { serial: 'SN-1' })).toBe('SN-1');
    expect(recordTitle(lab, 'inst_1', {})).toBe('inst_1');
    expect(groupLabel(p.entities['qa.Batch']!)).toBe('Batches');
    expect(groupLabel({ ...lab, entity: 'ExpectedDocument' })).toBe('Expected documents');
  });

  test('a review step covers its record; the signature hashes its own values, not status or calculated ones', async () => {
    const p = await load();
    const wf = p.workflows['review-report']!;
    expect(stepReview(wf, wf.steps.review!, p.entities)).toMatchObject({ kind: 'document', field: 'report' });
    expect(signedRecordField(wf, wf.steps.review!, p.entities)?.field).toBe('report');
    const report = p.entities['qa.Report']!;
    const values = { title: 'T', batch: 'b1', score: 90, status: 'in_review', released_pct: 4, remarks: null };
    expect(signableValues(report, values)).toEqual({ title: 'T', batch: 'b1', score: 90 });
    const a = recordContentHash(report, 'r1', values).hash;
    expect(recordContentHash(report, 'r1', { ...values, status: 'released' }).hash).toBe(a);
    expect(recordContentHash(report, 'r1', { ...values, score: 91 }).hash).not.toBe(a);
  });

  test('a regulated playbook review is signed only when it approves', async () => {
    const p = await load();
    expect(isRegulatedPlaybook(p, 'review-report')).toBe(true);
    const step = { ...p.workflows['review-report']!.steps.review!, sign: undefined, outcomes: ['approved', 'changes_requested'] };
    const meta = { ...p.workflows['review-report']!, id: 'change-playbook' };
    const deps = { people: undefined as never, entities: () => p.entities, project: () => p };
    expect(signingStep(deps, meta, step, 'approved', { playbook: { value: 'review-report' } }).sign).toContain('playbook change');
    expect(signingStep(deps, meta, step, 'changes_requested', { playbook: { value: 'review-report' } }).sign).toBeUndefined();
  });

  test('a Ref no step writes is a start field (the record the case is about)', async () => {
    const p = await load();
    expect(startFields(p.workflows['review-report']!).sort()).toEqual(['report', 'review_note']);
  });

  test('passwords in a regulated workspace are at least 12 characters; flags say what broke', async () => {
    const p = await load();
    expect(() => checkPasswordRule(p, 'short')).toThrow(/12 characters/);
    expect(() => checkPasswordRule(p, 'long enough password')).not.toThrow();
    expect(() => checkPasswordRule({ ...p, domains: {} }, 'short')).not.toThrow();
    expect(flagMessage(p.entities['qa.Report']!, 'score <= 100', { score: 120 })).toBe('This Report breaks a rule of its domain: score <= 100 (score is 120)');
  });
});
