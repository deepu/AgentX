// Stage 4 with Stage 3 (docs/memwise/26-projects-and-pages.md §3, §5): a draft of a project's own
// copy of a playbook starts from that copy (the template plus the project's overrides) and
// publishes the files it changed as the project's overrides; the template and the app's other
// projects don't change.
import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyDraft, createDraft, diffDraft, loadDraft, loadProject, writeDraftFiles } from '../src/index.ts';

const ETMF = resolve(import.meta.dir, '../../../examples/etmf');
const CHASE = 'domains/etmf/workflows/chase-missing';
const OVERRIDES = 'projects/mw301/overrides/workflows/chase-missing';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'mw-project-draft-'));
  dirs.push(root);
  cpSync(ETMF, root, { recursive: true });
  return root;
}

describe('a draft of a project\'s copy of a playbook', () => {
  test('starts from the project\'s copy and publishes as its overrides', async () => {
    const root = workspace();
    const template = readFileSync(join(root, CHASE, 'steps/escalate.md'), 'utf8');
    const meta = await createDraft(root, { workflowId: 'chase-missing', title: 'Call sooner', createdBy: 'person_a', project: 'mw301' });
    expect(meta.project).toEqual({ id: 'mw301', dir: 'projects/mw301' });
    expect(meta.folder).toBe(CHASE);
    // MW-301's own wait (5 days), and its own version + 1.
    const draft = await loadDraft(root, meta.id);
    expect(draft.workflow!.version).toBe(3);
    expect(readFileSync(join(root, 'drafts', meta.id, CHASE, 'workflow.yaml'), 'utf8')).toContain('timeout: 5d → escalate');

    await writeDraftFiles(root, meta.id, { [`${CHASE}/steps/escalate.md`]: template.replace('agree a date', 'agree a date this week') }, { by: 'person_a', via: 'editor', summary: 'Sooner' });
    const diff = await diffDraft(root, meta.id);
    expect(diff.conflicts).toEqual([]);
    expect(diff.files.map((f) => [f.path, f.writesTo])).toEqual([
      [`${CHASE}/steps/escalate.md`, `${OVERRIDES}/steps/escalate.md`],
      [`${CHASE}/workflow.yaml`, `${OVERRIDES}/workflow.yaml`],
    ]);

    const published = await applyDraft(root, meta.id);
    expect(published.files.sort()).toEqual([`${OVERRIDES}/steps/escalate.md`, `${OVERRIDES}/workflow.yaml`]);
    expect(readFileSync(join(root, CHASE, 'steps/escalate.md'), 'utf8')).toBe(template);
    const { project, diagnostics } = await loadProject(root);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(project.projects!.mw301!.workflows['chase-missing']!.version).toBe(3);
    expect(project.projects!.mw301!.workflows['chase-missing']!.steps.escalate!.instructions).toContain('this week');
    expect(project.projects!.mw207!.workflows['chase-missing']!.steps.escalate!.instructions).not.toContain('this week');
  });

  test('changes only the playbook\'s existing files', async () => {
    const root = workspace();
    const meta = await createDraft(root, { workflowId: 'chase-missing', title: 'Too much', createdBy: 'person_a', project: 'mw301' });
    const write = (path: string, content: string | null) => writeDraftFiles(root, meta.id, { [path]: content }, { by: 'person_a', via: 'editor', summary: 'x' });
    await expect(write(`${CHASE}/steps/new_step.md`, '---\ntitle: New\n---\n')).rejects.toThrow('existing files');
    await expect(write(`${CHASE}/steps/escalate.md`, null)).rejects.toThrow("can't remove");
    await expect(write('domains/etmf/entities/site.yaml', 'entity: Site\n')).rejects.toThrow('record types, roles');
    expect(existsSync(join(root, 'drafts', meta.id, CHASE, 'steps/new_step.md'))).toBe(false);
  });

  test('a project with no folder of its own, or a new playbook, is refused', async () => {
    const root = workspace();
    await expect(createDraft(root, { workflowId: 'chase-missing', title: 'x', createdBy: 'a', project: 'etmf' })).rejects.toThrow('no project etmf');
    await expect(createDraft(root, { workflowId: 'brand-new', title: 'x', createdBy: 'a', project: 'mw301', domain: 'etmf' })).rejects.toThrow('own copy');
  });
});
