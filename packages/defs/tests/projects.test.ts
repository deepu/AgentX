// Stage 3 (docs/memwise/26-projects-and-pages.md §3, D93): apps, projects, overrides, the checks,
// template updates and save as template, on copies of the eTMF example.
import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  checkProject, createProjectFiles, indexProject, loadProject, projectIdFor, publishAppVersion, saveAsTemplate, takeTemplateUpdate,
  templateUpdate, type Diagnostic, type IndexedDefinition, type ProjectDefs,
} from '../src/index.ts';
import { SAMPLE } from './fixture.ts';

const EXAMPLES = join(import.meta.dir, '..', '..', '..', 'examples');
const ETMF = join(EXAMPLES, 'etmf');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A copy of the eTMF example to change. */
function etmfCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mw-projects-'));
  dirs.push(dir);
  cpSync(ETMF, dir, { recursive: true });
  return dir;
}

function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

const codes = (ds: Diagnostic[]) => ds.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.file ?? ''}`).sort();
const waitFor = (p: ProjectDefs, id: string) => p.projects![id]!.workflows['chase-missing']!.states.wait_for_documents!.wait?.timeout;
const ROLES = { roles: ['tmf_specialist', 'study_manager', 'cra', 'data_manager', 'qa'] };
async function load(dir: string) {
  const { project, diagnostics } = await loadProject(dir);
  return { project, all: [...diagnostics, ...checkProject(project, { tools: {}, ...ROLES })] };
}

describe('apps and projects', () => {
  test("today's single-domain examples load as one implicit project each", async () => {
    for (const [ex, app] of [['intake', 'domain'], ['literature', 'literature']] as const) {
      const { project } = await loadProject(ex === 'intake' ? SAMPLE : join(EXAMPLES, ex));
      expect(Object.keys(project.apps!)).toEqual([app]);
      const projects = Object.values(project.projects!);
      expect(projects.map((p) => [p.id, p.app])).toEqual([[app, app]]);
    }
    const { project } = await loadProject(SAMPLE);
    const p = project.projects!.domain!;
    expect(p).toMatchObject({ implicit: true, version: 1, overrides: [] });
    // The implicit project runs the template's own playbooks (no copies).
    expect(p.workflows['client-intake']).toBe(project.workflows['client-intake']!);
  });

  test('the eTMF app: three studies from the Phase 3 template, MW-301 waiting 5 days', async () => {
    const { project, all } = await load(ETMF);
    expect(codes(all)).toEqual([]);
    expect(project.apps!.etmf).toMatchObject({
      title: 'eTMF', version: 4, nouns: { one: 'study', many: 'studies' }, home: { title: 'TMF across studies', link: 'All studies' },
      templates: [{ id: 'phase3', title: 'Phase 3 study', description: 'Many sites, visits' }, { id: 'phase1', title: 'Phase 1 study', without: ['workflows/chase-missing'] }],
    });
    // eTMF has its three studies; EDC its two (Stage 6 Part B), each naming its study and reading it
    // from Rave through its connection. Neither app has an implicit project.
    expect(Object.keys(project.projects!).sort()).toEqual(['edc-mw207', 'edc-mw301', 'mw207', 'mw301', 'mw310']);
    expect(project.projects!['edc-mw301']).toMatchObject({
      app: 'edc', apps: ['edc'], study: 'MW-301', connections: [{ id: 'rave', title: 'Medidata Rave', plugin: 'memwise/medidata-rave', access: 'read' }],
    });
    expect(project.projects!.mw301).toMatchObject({
      app: 'etmf', name: 'Study MW-301', study: 'MW-301', version: 4, status: 'active', template: 'phase3',
      from: { template: 'phase3', version: 4 }, overrides: ['workflows/chase-missing/workflow.yaml'],
    });
    expect(project.projects!.mw301!.people.map((p) => `${p.name}:${p.roles}`)).toEqual(['Anika Rao:study_manager', 'Priya Shah:cra', 'Tom Okafor:tmf_specialist']);
    expect(project.projects!.mw310).toMatchObject({ status: 'draft', from: { project: 'mw301' } });
    expect(project.entities['etmf.Sponsor']!.scope).toBe('app');

    // The template says 3 days; MW-301's override says 5; MW-207 takes the template.
    expect(project.workflows['chase-missing']!.states.wait_for_documents!.wait?.timeout).toMatchObject({ afterMs: 3 * 86_400_000 });
    expect(waitFor(project, 'mw301')).toMatchObject({ afterMs: 5 * 86_400_000 });
    expect(waitFor(project, 'mw207')).toMatchObject({ afterMs: 3 * 86_400_000 });
    const mine = project.projects!.mw301!.workflows['chase-missing']!;
    expect(mine).toMatchObject({ project: 'mw301', domain: 'etmf', overridden: ['workflow.yaml'], version: 2 });
    // Every study has its own copy of each playbook, with a hash of its own, and steps from the template.
    const theirs = project.projects!.mw207!.workflows['chase-missing']!;
    expect(new Set([mine.hash, theirs.hash, project.workflows['chase-missing']!.hash]).size).toBe(3);
    expect(mine.steps.send_reminder!.hash).toBe(project.workflows['chase-missing']!.steps.send_reminder!.hash);
    expect(project.projects!.mw207!.workflows['file-document']!.project).toBe('mw207');
  });

  test('indexing writes apps, projects with their playbook hashes, and each project\'s own copies', async () => {
    const { project } = await loadProject(ETMF);
    const defs: IndexedDefinition[] = [];
    await indexProject(project, { upsert: async (d) => { defs.push(...d); }, getWorkflow: async () => undefined, latestWorkflow: async () => undefined });
    const row = (kind: string, id: string) => defs.filter((d) => d.kind === kind && d.id === id);
    expect(row('app', 'etmf')[0]!.body).toMatchObject({ version: 4 });
    const mw301 = row('project', 'mw301')[0]!.body as { workflows: Record<string, string>; app: string };
    expect(mw301.app).toBe('etmf');
    expect(mw301.workflows['chase-missing']).toBe(project.projects!.mw301!.workflows['chase-missing']!.hash);
    expect(row('project_workflow', 'chase-missing').map((d) => (d.body as { project: string }).project).sort()).toEqual(['mw207', 'mw301', 'mw310']);
    // The template stays the only `workflow` row of an id: "latest" never picks a project's copy.
    expect(row('workflow', 'chase-missing').length).toBe(1);
    expect(row('project_workflow', 'activate-site').length).toBe(3);
  });

  test('checks: override-unknown-file, override-not-allowed, project-unknown-app, without-unknown, app-scope-ref, roles, policy', async () => {
    const dir = etmfCopy();
    write(dir, {
      'projects/mw301/overrides/workflows/chase-missing/steps/nope.md': '---\ntitle: x\n---\n',
      'projects/mw301/overrides/entities/site.yaml': 'entity: Site\nfields: { site_number: Text }\n',
      'projects/mw301/overrides/policy.yaml': 'effects: { outbound: allow, irreversible: deny }\n',
      'projects/stray/project.yaml': 'app: tmf\nname: Stray\n',
      'projects/mw207/project.yaml': 'app: etmf\nversion: 4\nname: Study MW-207\nstudy: MW-207\nwithout: [pages/nothing]\npeople:\n  - { email: x@y.example, roles: [pilot] }\n',
      'projects/mw999/project.yaml': 'app: etmf\nversion: 7\nname: Study MW-999\n',
    });
    // A shared Sponsor may not point at one study's records.
    const sponsor = join(dir, 'domains/etmf/entities/sponsor.yaml');
    writeFileSync(sponsor, readFileSync(sponsor, 'utf8').replace('fields:\n  name: { type: Text, required: true }\n', 'fields:\n  name: { type: Text, required: true }\n  lead_study: Ref<Study>\n'));
    const { all } = await load(dir);
    const got = codes(all);
    expect(got).toContain('override-unknown-file projects/mw301/overrides/workflows/chase-missing/steps/nope.md');
    expect(got).toContain('override-not-allowed projects/mw301/overrides/entities/site.yaml');
    expect(got).toContain('project-unknown-app projects/stray/project.yaml');
    expect(got).toContain('without-unknown projects/mw207/project.yaml');
    expect(got).toContain('unknown-role projects/mw207/project.yaml');
    expect(got).toContain('project-unknown-version projects/mw999/project.yaml');
    expect(got).toContain('project-policy-loosened projects/mw301/overrides/policy.yaml');
    expect(got).toContain('app-scope-ref domains/etmf/entities/sponsor.yaml');
    expect(all.find((d) => d.code === 'app-scope-ref')!.message).toContain('etmf.Study');
  });

  test('a project that leaves a playbook out has no copy of it', async () => {
    const dir = etmfCopy();
    write(dir, { 'projects/mw501/project.yaml': 'app: etmf\ntemplate: phase1\nname: Study MW-501\nwithout: [workflows/chase-missing]\n' });
    const { project, all } = await load(dir);
    expect(codes(all)).toEqual([]);
    expect(project.projects!.mw501!.workflows['chase-missing']).toBeUndefined();
    expect(project.projects!.mw501!.workflows['file-document']).toBeDefined();
  });
});

describe('the app home and app playbooks', () => {
  test('home: columns read per project, settings and the next milestone; an unknown entity is an error', async () => {
    const { project } = await load(ETMF);
    expect(project.apps!.etmf!.home).toEqual({
      title: 'TMF across studies', link: 'All studies', next: 'next_milestone',
      columns: [
        { label: 'Phase', setting: 'phase' },
        { label: 'Sites', value: { count: 'Site' } },
        { label: 'Filed', value: { percent: 'ExpectedDocument', where: "status = 'filed'" }, format: 'percent' },
        { label: 'Missing', value: { count: 'ExpectedDocument', where: "status = 'missing'" } },
        { label: 'Waiting for QC', value: { count: 'Document', where: "status = 'in_qc'" } },
      ],
    });
    const dir = etmfCopy();
    const app = readFileSync(join(dir, 'domains/etmf/app.yaml'), 'utf8').replace('{ count: Site }', '{ count: Visit }');
    write(dir, { 'domains/etmf/app.yaml': app });
    expect(codes((await load(dir)).all)).toEqual(['app-home-unknown-entity domains/etmf/app.yaml']);
  });

  test('also: a project runs other apps too (D105); an app it runs gets no project of its own', async () => {
    const dir = etmfCopy();
    write(dir, {
      'projects/ops/project.yaml': 'app: etmf\nalso: [edc, nowhere]\nname: Trial operations\n',
      'domains/edc/workflows/edc-check/workflow.yaml': 'workflow: edc-check\nversion: 1\ntitle: Check a site\nstart: check\nsteps:\n  check: { on: { done: end } }\n',
      'domains/edc/workflows/edc-check/case.yaml': 'case: edc_check\nfields:\n  note: Text\n',
      'domains/edc/workflows/edc-check/steps/check.md': '---\ntitle: Check\nperformer: person\nassignee: cra\nwrites:\n  note: Text\noutcomes: [done]\n---\nCheck the site.\n',
    });
    const { project, all } = await load(dir);
    expect(codes(all)).toEqual(['project-unknown-app projects/ops/project.yaml']);
    const ops = project.projects!.ops!;
    expect(ops.apps).toEqual(['etmf', 'edc']);
    // EDC's playbooks are copied into it, like the template's own.
    const edcWorkflows = Object.values(project.workflows).filter((w) => w.domain === 'edc' && !w.project).map((w) => w.id).sort();
    expect(edcWorkflows).toEqual(['chase-old-queries', 'edc-check']);
    for (const id of edcWorkflows) expect(ops.workflows[id]).toMatchObject({ project: 'ops', domain: 'edc' });
    // EDC is run by "ops" now: it has no implicit project; the studies still have only eTMF.
    expect(project.projects!.edc).toBeUndefined();
    expect(project.projects!.mw301!.apps).toEqual(['etmf']);
    // A copy keeps its source's apps.
    const { createProjectFiles } = await import('../src/project-files.ts');
    write(dir, { 'projects/ops/project.yaml': 'app: etmf\nalso: [edc]\nname: Trial operations\n' });
    const again = await load(dir);
    await createProjectFiles(again.project, { id: 'ops2', name: 'Ops 2', copyFrom: 'ops' });
    expect((await load(dir)).project.projects!.ops2!.apps).toEqual(['etmf', 'edc']);
  });

  test("a project's own binding serves its connection; without one, the app's does", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mw-projects-'));
    dirs.push(dir);
    cpSync(join(EXAMPLES, 'literature'), dir, { recursive: true });
    const before = await loadProject(dir);
    expect(before.project.projects!.literature!.bindings).toBeUndefined();
    expect(before.project.bindings!['claude/pubmed']).toBeDefined();
    const text = readFileSync(join(dir, 'domain/bindings/claude__pubmed.yaml'), 'utf8');
    write(dir, { 'projects/literature/bindings/claude__pubmed.yaml': text });
    const after = await loadProject(dir);
    expect(after.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(after.project.projects!.literature!.bindings!['claude/pubmed']).toMatchObject({ plugin: 'claude/pubmed', file: 'projects/literature/bindings/claude__pubmed.yaml' });
    expect(after.project.projects!.literature!.hash).not.toBe(before.project.projects!.literature!.hash);
    // One that isn't frozen is reported, and the app's binding keeps serving.
    write(dir, { 'projects/literature/bindings/claude__pubmed.yaml': text.replace(/frozen:\n  by: example\n  at: [^\n]+\n/, '') });
    const unfrozen = await loadProject(dir);
    expect(unfrozen.project.projects!.literature!.bindings).toBeUndefined();
    expect(unfrozen.diagnostics.map((d) => d.code)).toContain('binding-not-frozen');
  });

  test('create-project is the app\'s own: projects get no copy of it', async () => {
    const { project } = await load(ETMF);
    expect(project.workflows['create-project']).toBeDefined();
    for (const p of Object.values(project.projects!)) expect(p.workflows['create-project']).toBeUndefined();
    expect(Object.keys(project.projects!.mw301!.workflows).sort()).toEqual(['activate-site', 'chase-missing', 'file-document', 'fix-rejected-document', 'new-coordinator', 'remind-site', 'route-message', 'watch-expiries']);
  });
});

describe('template updates', () => {
  test('version 5: MW-207 gets the change, MW-301 already does it; MW-207 keeps running version 4 until it takes it', async () => {
    const dir = etmfCopy();
    let { project } = await loadProject(dir);
    const v5Chase = readFileSync(join(dir, 'projects/mw301/overrides/workflows/chase-missing/workflow.yaml'), 'utf8')
      .replace(/# MW-301's own copy[^\n]*\n[^\n]*\n/, '# Sites get 5 days for their missing documents (version 5 of the template).\n');
    const policy = readFileSync(join(dir, 'domains/etmf/policy.yaml'), 'utf8');
    const version = await publishAppVersion(project, 'etmf', {
      'workflows/chase-missing/workflow.yaml': v5Chase,
      'policy.yaml': policy.replace('tokens: 200000', 'tokens: 250000'),
    });
    expect(version).toBe(5);
    expect(existsSync(join(dir, 'domains/etmf/versions/4/workflows/chase-missing/workflow.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'domains/etmf/versions/4/entities'))).toBe(false);

    ({ project } = await loadProject(dir));
    expect(project.apps!.etmf).toMatchObject({ version: 5, versions: [4] });
    // MW-207 still runs version 4 (from versions/4/), with its 3 days.
    expect(project.projects!.mw207!.version).toBe(4);
    expect(waitFor(project, 'mw207')).toMatchObject({ afterMs: 3 * 86_400_000 });
    expect(project.projects!.mw207!.workflows['chase-missing']!.dir).toBe('domains/etmf/versions/4/workflows/chase-missing');
    expect(project.projects!.mw207!.policy!.budgets?.tokens).toBe(200_000);

    const for207 = (await templateUpdate(project, 'mw207'))!;
    expect(for207).toMatchObject({ from: 4, to: 5, workflowsChanged: ['chase-missing'], policyChanged: true });
    expect(for207.changes).toEqual([
      { path: 'policy.yaml', kind: 'changed', project: 'takes' },
      { path: 'workflows/chase-missing/workflow.yaml', kind: 'changed', workflow: 'chase-missing', project: 'takes' },
    ]);
    const for301 = (await templateUpdate(project, 'mw301'))!;
    expect(for301.changes.find((c) => c.workflow === 'chase-missing')).toMatchObject({ project: 'overridden-same' });
    expect(for301.workflowsChanged).toEqual([]);

    // MW-301 takes it: its override says what the template now says, so it goes.
    expect(await takeTemplateUpdate(project, 'mw301')).toEqual({ version: 5, removed: ['workflows/chase-missing/workflow.yaml'], leftOutGone: [] });
    ({ project } = await loadProject(dir));
    expect(project.projects!.mw301).toMatchObject({ version: 5, overrides: [] });
    expect(waitFor(project, 'mw301')).toMatchObject({ afterMs: 5 * 86_400_000 });
    expect(await templateUpdate(project, 'mw301')).toBeUndefined();
    // MW-207 takes it too, and now waits 5 days.
    await takeTemplateUpdate(project, 'mw207');
    ({ project } = await loadProject(dir));
    expect(waitFor(project, 'mw207')).toMatchObject({ afterMs: 5 * 86_400_000 });
    const { all } = await load(dir);
    expect(codes(all)).toEqual([]);
  });

  test('publishing refuses any path outside the template: .., ., empty segments, backslashes, absolute paths', async () => {
    const dir = etmfCopy();
    const { project } = await loadProject(dir);
    const site = readFileSync(join(dir, 'domains/etmf/entities/site.yaml'), 'utf8');
    for (const path of [
      'workflows/x/../../..', 'workflows/../entities/site.yaml', 'workflows/chase-missing/../../entities/site.yaml', 'pages/../entities/site.yaml',
      'workflows/x/./a.yaml', 'workflows//a.yaml', 'workflows\\x\\..\\..\\entities\\site.yaml', '/etc/passwd', `${dir}/domains/etmf/entities/site.yaml`,
      'entities/site.yaml', '../../../outside.yaml', '',
    ]) {
      await expect(publishAppVersion(project, 'etmf', { [path]: 'x: 1\n' })).rejects.toThrow(/not a template file|outside the app/);
      await expect(publishAppVersion(project, 'etmf', { [path]: null })).rejects.toThrow(/not a template file|outside the app/);
    }
    // One bad path refuses the whole publish before anything is written or kept.
    await expect(publishAppVersion(project, 'etmf', { 'policy.yaml': 'x: 1\n', 'workflows/../entities/site.yaml': null })).rejects.toThrow('not a template file');
    expect(readFileSync(join(dir, 'domains/etmf/entities/site.yaml'), 'utf8')).toBe(site);
    expect(existsSync(join(dir, 'domains/etmf/versions/4'))).toBe(false);
    expect(existsSync(join(dir, '..', 'outside.yaml'))).toBe(false);
    expect((await loadProject(dir)).project.apps!.etmf!.version).toBe(4);
  });

  test("a project whose overridden file the new version drops loses that override when it takes it, and still checks", async () => {
    const dir = etmfCopy();
    let { project } = await loadProject(dir);
    // MW-301 overrides chase-missing; version 5 drops the playbook, and Phase 1's left-out one too.
    write(dir, { 'projects/mw301/overrides/workflows/watch-expiries/workflow.yaml': readFileSync(join(dir, 'domains/etmf/workflows/watch-expiries/workflow.yaml'), 'utf8').replace(/^title: .*$/m, 'title: Watch expiries (MW-301)') });
    ({ project } = await loadProject(dir));
    const files: Record<string, null> = {};
    for (const f of ['workflow.yaml', ...readdirSync(join(dir, 'domains/etmf/workflows/watch-expiries')).filter((x) => x !== 'workflow.yaml')]) {
      if (statSync(join(dir, 'domains/etmf/workflows/watch-expiries', f)).isFile()) files[`workflows/watch-expiries/${f}`] = null;
    }
    expect(await publishAppVersion(project, 'etmf', files)).toBe(5);
    ({ project } = await loadProject(dir));
    const r = await takeTemplateUpdate(project, 'mw301');
    expect(r.removed).toContain('workflows/watch-expiries/workflow.yaml');
    expect(existsSync(join(dir, 'projects/mw301/overrides/workflows/watch-expiries/workflow.yaml'))).toBe(false);
    const { all } = await load(dir);
    expect(codes(all).filter((c) => c.includes('projects/mw301'))).toEqual([]);
  });

  test('a copy of MW-301 takes its way of working, never its records; save as template makes a version or a new app', async () => {
    const dir = etmfCopy();
    let { project } = await loadProject(dir);
    const id = projectIdFor('Study MW-320', Object.keys(project.projects!));
    expect(id).toBe('study-mw-320');
    await createProjectFiles(project, { id, name: 'Study MW-320', copyFrom: 'mw301', study: 'MW-320', status: 'draft' });
    await createProjectFiles(project, { id: 'mw330', name: 'Study MW-330', app: 'etmf', template: 'phase1' });
    ({ project } = await loadProject(dir));
    expect(project.projects![id]).toMatchObject({ app: 'etmf', status: 'draft', from: { project: 'mw301' }, overrides: ['workflows/chase-missing/workflow.yaml'] });
    expect(waitFor(project, id)).toMatchObject({ afterMs: 5 * 86_400_000 });
    expect(project.projects!.mw330).toMatchObject({ from: { template: 'phase1', version: 4 }, without: ['workflows/chase-missing'] });
    await expect(createProjectFiles(project, { id: 'mw301', name: 'Again', app: 'etmf' })).rejects.toThrow('already exists');
    // An app's id is its own project's (D107): no project.yaml may take it.
    await expect(createProjectFiles(project, { id: 'etmf', name: 'eTMF', app: 'etmf' })).rejects.toThrow('is the id of an app');
    await expect(createProjectFiles(project, { id: 'edc', name: 'EDC', app: 'etmf' })).rejects.toThrow('is the id of an app');

    // MW-301 as the next eTMF version: only its own change differs from the template.
    expect(await saveAsTemplate(project, 'mw301')).toEqual({ app: 'etmf', version: 5 });
    ({ project } = await loadProject(dir));
    expect(project.workflows['chase-missing']!.states.wait_for_documents!.wait?.timeout).toMatchObject({ afterMs: 5 * 86_400_000 });
    expect((await templateUpdate(project, 'mw207'))!.workflowsChanged).toEqual(['chase-missing']);

    // As a new app: the record types come along, no records, version 1.
    expect(await saveAsTemplate(project, 'mw301', { newApp: { id: 'mw301_setup', title: 'MW-301 setup' } })).toEqual({ app: 'mw301_setup', version: 1 });
    ({ project } = await loadProject(dir));
    expect(project.apps!.mw301_setup).toMatchObject({ title: 'MW-301 setup', version: 1 });
    expect(project.domains!.mw301_setup!.intake).toBeUndefined();
    expect(project.entities['mw301_setup.Site']).toBeDefined();
    expect(project.projects!.mw301_setup).toMatchObject({ implicit: true });
  });
});
