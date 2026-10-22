import { describe, expect, test } from 'bun:test';
import { indexProject, loadProject, type DefinitionRef, type DefinitionStore, type IndexedDefinition, type WorkflowDef } from '../src/index.ts';
import { SAMPLE } from './fixture.ts';

/** In-memory DefinitionStore, keyed like mw.definitions (kind, id, hash). */
class FakeStore implements DefinitionStore {
  calls = 0;
  defs = new Map<string, IndexedDefinition>();
  refs = new Map<string, DefinitionRef>();
  async upsert(defs: IndexedDefinition[], refs: DefinitionRef[]) {
    this.calls++;
    for (const d of defs) this.defs.set(`${d.kind}/${d.id}/${d.hash}`, d);
    for (const r of refs) this.refs.set(JSON.stringify(r), r);
  }
  async getWorkflow(id: string, hash: string) {
    return this.defs.get(`workflow/${id}/${hash}`)?.body as WorkflowDef | undefined;
  }
  async latestWorkflow(id: string) {
    return [...this.defs.values()].filter((d) => d.kind === 'workflow' && d.id === id).at(-1)?.body as WorkflowDef | undefined;
  }
}

describe('indexProject', () => {
  test('indexes the sample project in one upsert', async () => {
    const { project } = await loadProject(SAMPLE);
    const store = new FakeStore();
    const counts = await indexProject(project, store);
    expect(store.calls).toBe(1);
    expect(counts).toEqual({ definitions: store.defs.size, refs: store.refs.size });

    const all = [...store.defs.values()].map((d) => `${d.kind} ${d.id} ${d.path}`).sort();
    // The meta playbooks (Phase 3) are indexed like any other.
    expect(all).toContain('workflow create-playbook workflows/create-playbook');
    expect(all).toContain('workflow change-playbook workflows/change-playbook');
    const rows = all.filter((r) => !/(create|change)-playbook|bind-plugin|plugin_binding|refresh-page|page_refresh/.test(r));
    expect(rows).toEqual([
      // Stage 3: the default domain is an app with one (implicit) project.
      'app domain domain',
      'case_type client_intake workflows/client-intake/case.yaml',
      'entity_type Customer domain/entities/customer.yaml',
      'entity_type Engagement domain/entities/engagement.yaml',
      'policy client-intake workflows/client-intake/policy.yaml',
      'policy domain domain/policy.yaml',
      'project domain domain',
      'step client-intake/check workflows/client-intake/steps/check.md',
      'step client-intake/fill workflows/client-intake/steps/fill.md',
      'step client-intake/invite workflows/client-intake/steps/invite.md',
      'step client-intake/onboard workflows/client-intake/steps/onboard.md',
      'step client-intake/prepare workflows/client-intake/steps/prepare.md',
      'step client-intake/verify workflows/client-intake/steps/verify.md',
      'workflow client-intake workflows/client-intake',
    ]);

    const wf = project.workflows['client-intake']!;
    expect(await store.getWorkflow('client-intake', wf.hash)).toBe(wf);
    expect([...store.defs.values()].find((d) => d.kind === 'policy' && d.id === 'domain')!.body).toBe(project.domainPolicy);

    const refsFrom = (fromId: string) => [...store.refs.values()].filter((r) => r.fromId === fromId).map((r) => `${r.toKind} ${r.toId}`).sort();
    expect(refsFrom('client-intake')).toEqual([
      'case_type client_intake', 'policy client-intake', 'policy domain',
      'step client-intake/check', 'step client-intake/fill', 'step client-intake/invite', 'step client-intake/onboard',
      'step client-intake/prepare', 'step client-intake/verify',
    ]);
    expect(refsFrom('client-intake/check')).toEqual([
      'case_field client_intake.annual_turnover', 'case_field client_intake.client_email', 'case_field client_intake.client_message',
      'case_field client_intake.client_name',
      'case_field client_intake.documents', 'case_field client_intake.flags', 'case_field client_intake.gstin', 'case_field client_intake.gstin_ok',
      'case_field client_intake.legal_name', 'case_field client_intake.pan',
      'model_role checker',
      'tool gst.validate_gstin', 'tool intake.extract_fields', 'tool recall.similar_cases', 'tool recall.step_record',
    ]);
    expect(refsFrom('client_intake')).toEqual(['entity_type Customer']);
    expect(refsFrom('Customer')).toEqual(['entity_type Engagement']);
    expect(refsFrom('Engagement')).toEqual(['entity_type Customer']);
    const fromHash = [...store.refs.values()].find((r) => r.fromId === 'client-intake/check')!.fromHash;
    expect(fromHash).toBe(wf.steps.check!.hash);
  });

  test('is idempotent: indexing again writes the same rows', async () => {
    const { project } = await loadProject(SAMPLE);
    const store = new FakeStore();
    const first = await indexProject(project, store);
    const second = await indexProject((await loadProject(SAMPLE)).project, store);
    expect(second).toEqual(first);
    expect(store.defs.size).toBe(first.definitions);
    expect(store.refs.size).toBe(first.refs);
  });
});
