/**
 * Drafts as plain files (Phase 3, docs/memwise/20-phase-3-interfaces.md §1): make one, edit it,
 * keep or discard edits, diff it against live, publish it. The file layer only; no database.
 * The layout is in draft-types.ts.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { bindingPath, bindingToYaml, parseBindingFile, pluginIdOfSlug, pluginSlug } from './binding-file.ts';
import { lineDiff, structuralDiff } from './diff.ts';
import { DRAFTS_DIR, type DraftDiff, type DraftEdit, type DraftKind, type DraftMeta, type DraftReport, type DraftTestRunSummary, type FileChange } from './draft-types.ts';
import { loadProject, loadWorkflow } from './load.ts';
import { parseWorkflowFile } from './parse-workflow.ts';
import { PLUGIN_ID_PATTERN, type BindingDef } from './plugin-types.ts';
import { isRecord } from './source.ts';
import type { Diagnostic, ProjectDefs, WorkflowDef } from './types.ts';

/** Publishing would overwrite live files that changed since the draft was made. */
export class DraftConflictError extends Error {
  constructor(readonly paths: string[]) {
    super(`the live ${paths.length === 1 ? 'file' : 'files'} ${paths.join(', ')} changed since the draft was made; make a new draft or copy the change over by hand`);
    this.name = 'DraftConflictError';
  }
}

/** The draft changed after it was checked (its content hash is not the one approved). */
export class DraftStaleError extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super('the draft changed after it was checked; check it again');
    this.name = 'DraftStaleError';
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const hashOf = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** `<root>/drafts/<id>`, refusing ids that could name anything else. */
export function draftDir(root: string, id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error(`\`${id}\` is not a draft id`);
  return join(resolve(root), DRAFTS_DIR, id);
}

async function isFile(p: string): Promise<boolean> {
  try { return (await stat(p)).isFile(); } catch { return false; }
}

/** Every file under `dir` relative to it, sorted; dotfiles skipped (as load.ts does). */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  let entries;
  try { entries = await readdir(join(dir, prefix), { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The playbook's folder in the project: `workflows/<id>`, or its domain's (`domains/<d>/workflows/<id>`, Stage 4). */
export function draftPlaybookFolder(meta: Pick<DraftMeta, 'workflowId' | 'folder'>): string {
  return meta.folder ?? `workflows/${meta.workflowId}`;
}

/** `domains/<d>` for a playbook in a domain's folder, else undefined. */
function domainFolderOf(folder: string | undefined): string | undefined {
  const m = folder ? /^(domains\/[^/]+)\/workflows\/[^/]+$/.exec(folder) : null;
  return m?.[1];
}

/** Where a live playbook's folder is: `workflows/<id>`, else the first `domains/<d>/workflows/<id>`; undefined when none. */
export async function findPlaybookFolder(root: string, workflowId: string): Promise<string | undefined> {
  const abs = resolve(root);
  if (await isFile(join(abs, 'workflows', workflowId, 'workflow.yaml'))) return `workflows/${workflowId}`;
  let domains: string[] = [];
  try { domains = (await readdir(join(abs, 'domains'), { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort(); } catch { /* none */ }
  for (const d of domains) {
    if (await isFile(join(abs, 'domains', d, 'workflows', workflowId, 'workflow.yaml'))) return `domains/${d}/workflows/${workflowId}`;
  }
  return undefined;
}

/**
 * The project-relative files a draft is about, in a project folder (live or the draft's own):
 * `domain/` and the playbook's folder; for a binding draft, `domain/` only. A playbook in a
 * domain's folder (Stage 4) also takes what it loads with: `workspace.yaml` and every domain's
 * definitions except their playbooks, so the draft still loads as a project.
 */
async function contentFiles(root: string, workflowId: string, kind?: DraftKind, folder?: string): Promise<string[]> {
  const out = (await listFiles(join(root, 'domain'))).map((f) => `domain/${f}`);
  if (kind === 'binding') return out;
  if (domainFolderOf(folder)) {
    if (await isFile(join(root, 'workspace.yaml'))) out.push('workspace.yaml');
    out.push(...(await listFiles(join(root, 'domains'))).map((f) => `domains/${f}`).filter((f) => !/^domains\/[^/]+\/workflows\//.test(f)));
  }
  const pb = folder ?? `workflows/${workflowId}`;
  out.push(...(await listFiles(join(root, pb))).map((f) => `${pb}/${f}`));
  return out;
}

async function readText(p: string): Promise<string | null> {
  try { return await readFile(p, 'utf8'); } catch { return null; }
}

/**
 * Sets `version:` in a workflow.yaml text, touching only that line (comments and layout stay):
 * replaces the value, or adds the line after `workflow:` when there is none.
 */
export function setWorkflowVersion(text: string, version: number): string {
  if (/^version:/m.test(text)) return text.replace(/^(version:[ \t]*)[^\s#]*/m, `$1${version}`);
  if (/^workflow:.*$/m.test(text)) return text.replace(/^(workflow:.*)$/m, `$1\nversion: ${version}`);
  return `version: ${version}\n${text}`;
}

// ---------------------------------------------------------------- meta, edits, report

async function writeMeta(dir: string, meta: DraftMeta): Promise<void> {
  const clean = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined));
  await writeFile(join(dir, 'draft.yaml'), stringifyYaml(clean));
}

async function readMeta(dir: string): Promise<DraftMeta | undefined> {
  const text = await readText(join(dir, 'draft.yaml'));
  if (text === null) return undefined;
  const data = parseYaml(text) as unknown;
  if (!isRecord(data) || typeof data.id !== 'string' || typeof data.workflowId !== 'string') return undefined;
  return { ...(data as unknown as DraftMeta), base: isRecord(data.base) ? data.base as Record<string, string> : {} };
}

async function readEdits(dir: string): Promise<DraftEdit[]> {
  const text = await readText(join(dir, 'edits.jsonl'));
  if (!text) return [];
  const out: DraftEdit[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as DraftEdit); } catch { /* a torn last line from a crash: skip it */ }
  }
  return out;
}

async function writeEdits(dir: string, edits: DraftEdit[]): Promise<void> {
  const tmp = join(dir, `.edits.jsonl.${randomBytes(4).toString('hex')}`);
  await writeFile(tmp, edits.map((e) => `${JSON.stringify(e)}\n`).join(''));
  await rename(tmp, join(dir, 'edits.jsonl'));
}

async function requireMeta(root: string, id: string): Promise<{ dir: string; meta: DraftMeta }> {
  const dir = draftDir(root, id);
  const meta = await readMeta(dir);
  if (!meta) throw new Error(`there is no draft ${id}`);
  return { dir, meta };
}

function requireOpen(meta: DraftMeta): void {
  if (meta.status !== 'open') throw new Error(`draft ${meta.id} is ${meta.status}; it can't be changed`);
}

// ---------------------------------------------------------------- create, list, read

export interface CreateDraftInput {
  workflowId: string;
  title: string;
  /** Default: `change` when the playbook exists live, else `create`. */
  kind?: DraftKind;
  createdBy: string;
  runId?: string;
  /** Stage 4: the chat that started it (a playbook's own chat drafting a change). */
  chatId?: string;
  /** Stage 4: a new playbook in this domain's folder (`domains/<domain>/workflows/<id>`). */
  domain?: string;
}

/**
 * Makes a draft: copies `domain/` and (for a change) the playbook's folder, records the hash of
 * every copied file as `base`, and sets the copy's `version:` to the live version + 1.
 */
export async function createDraft(root: string, input: CreateDraftInput): Promise<DraftMeta> {
  const abs = resolve(root);
  const { workflowId } = input;
  if (input.kind === 'binding') throw new Error('a binding draft is made with createBindingDraft');
  if (!WORKFLOW_ID_PATTERN.test(workflowId)) throw new Error(`\`${workflowId}\` can't be a playbook id: use letters, digits, - and _`);
  const found = await findPlaybookFolder(abs, workflowId);
  const exists = !!found;
  const kind = input.kind ?? (exists ? 'change' : 'create');
  if (kind === 'change' && !exists) throw new Error(`there is no playbook ${workflowId} (workflows/${workflowId}/workflow.yaml) to change`);
  if (kind === 'create' && (exists || existsSync(join(abs, 'workflows', workflowId)))) throw new Error(`a playbook ${workflowId} already exists; make a change draft instead`);
  if (input.domain !== undefined && !ID_PATTERN.test(input.domain)) throw new Error(`\`${input.domain}\` is not a domain id`);
  const folder = found ?? (input.domain ? `domains/${input.domain}/workflows/${workflowId}` : `workflows/${workflowId}`);
  const liveDir = join(abs, folder);
  const inDomain = folder !== `workflows/${workflowId}`;

  let live: WorkflowDef | undefined;
  if (kind === 'change') {
    live = (await loadWorkflow(liveDir, abs)).workflow;
    if (!live) throw new Error(`the playbook ${workflowId} doesn't load; fix workflows/${workflowId}/workflow.yaml first`);
  }

  const now = new Date();
  let id = `${workflowId}-${now.getTime().toString(36)}`;
  for (let n = 2; existsSync(draftDir(abs, id)); n++) id = `${workflowId}-${now.getTime().toString(36)}-${n}`;
  const dir = draftDir(abs, id);
  await mkdir(dir, { recursive: true });

  const base: Record<string, string> = {};
  const files = kind === 'change' || inDomain
    ? (await contentFiles(abs, workflowId, kind, inDomain ? folder : undefined)).filter((f) => kind === 'change' || !f.startsWith(`${folder}/`))
    : (await listFiles(join(abs, 'domain'))).map((f) => `domain/${f}`);
  for (const rel of files) {
    const bytes = await readFile(join(abs, rel));
    base[rel] = hashOf(bytes);
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), bytes);
  }
  await mkdir(join(dir, folder), { recursive: true });
  if (live) {
    // The bump is part of making the draft, not an edit: the diff shows it, discard can't undo it.
    const shape = join(dir, folder, 'workflow.yaml');
    await writeFile(shape, setWorkflowVersion(await readFile(shape, 'utf8'), live.version + 1));
  }

  const meta: DraftMeta = {
    id,
    title: input.title,
    workflowId,
    kind,
    status: 'open',
    ...(live ? { baseVersion: live.version, baseHash: live.hash } : {}),
    base,
    createdBy: input.createdBy,
    createdAt: now.toISOString(),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.chatId ? { chatId: input.chatId } : {}),
    ...(inDomain ? { folder } : {}),
  };
  await writeMeta(dir, meta);
  await writeFile(join(dir, 'edits.jsonl'), '');
  return meta;
}

export interface CreateBindingDraftInput {
  pluginId: string;
  pluginVersion: string;
  title: string;
  createdBy: string;
  /** The bind-plugin run making it, if any. */
  runId?: string;
  /** The proposed binding, written as `domain/bindings/<slug>.yaml` in the draft. */
  binding: BindingDef;
}

/**
 * Makes a binding draft (Phase 4, 22 §3): copies `domain/` only, records the base hashes, and
 * writes the binding into the copy. Its `workflowId` is the plugin's slug. Writing the binding is
 * part of making the draft, not an edit: the diff shows it, discard can't undo it.
 */
export async function createBindingDraft(root: string, input: CreateBindingDraftInput): Promise<DraftMeta> {
  const abs = resolve(root);
  const slug = pluginSlug(input.pluginId);
  if (!PLUGIN_ID_PATTERN.test(input.pluginId)) throw new Error(`\`${input.pluginId}\` is not a plugin id`);
  const now = new Date();
  let id = `${slug}-${now.getTime().toString(36)}`;
  for (let n = 2; existsSync(draftDir(abs, id)); n++) id = `${slug}-${now.getTime().toString(36)}-${n}`;
  const dir = draftDir(abs, id);
  await mkdir(dir, { recursive: true });

  const base: Record<string, string> = {};
  for (const rel of await contentFiles(abs, slug, 'binding')) {
    const bytes = await readFile(join(abs, rel));
    base[rel] = hashOf(bytes);
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), bytes);
  }
  const file = bindingPath(input.pluginId);
  await mkdir(dirname(join(dir, file)), { recursive: true });
  await writeFile(join(dir, file), bindingToYaml({ ...input.binding, plugin: input.pluginId, pluginVersion: input.pluginVersion, file }));

  const meta: DraftMeta = {
    id,
    title: input.title,
    workflowId: slug,
    plugin: { id: input.pluginId, version: input.pluginVersion },
    kind: 'binding',
    status: 'open',
    base,
    createdBy: input.createdBy,
    createdAt: now.toISOString(),
    ...(input.runId ? { runId: input.runId } : {}),
  };
  await writeMeta(dir, meta);
  await writeFile(join(dir, 'edits.jsonl'), '');
  return meta;
}

/** Every draft in the project, newest first. Folders without a readable draft.yaml are skipped. */
export async function listDrafts(root: string): Promise<DraftMeta[]> {
  const parent = join(resolve(root), DRAFTS_DIR);
  let names: string[];
  try {
    names = (await readdir(parent, { withFileTypes: true })).filter((e) => e.isDirectory() && ID_PATTERN.test(e.name)).map((e) => e.name);
  } catch { return []; }
  const out: DraftMeta[] = [];
  for (const name of names) {
    try {
      const meta = await readMeta(join(parent, name));
      if (meta) out.push(meta);
    } catch { /* unreadable draft.yaml: not a draft */ }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** A draft's meta, its edits (oldest first) and its last report; undefined when there is no such draft. */
export async function readDraft(root: string, id: string): Promise<{ meta: DraftMeta; edits: DraftEdit[]; report?: DraftReport } | undefined> {
  const dir = draftDir(root, id);
  const meta = await readMeta(dir);
  if (!meta) return undefined;
  const reportText = await readText(join(dir, 'report.json'));
  let report: DraftReport | undefined;
  try { report = reportText ? JSON.parse(reportText) as DraftReport : undefined; } catch { report = undefined; }
  return { meta, edits: await readEdits(dir), ...(report ? { report } : {}) };
}

/** Changes draft.yaml (not its id). */
export async function updateDraftMeta(root: string, id: string, patch: Partial<Omit<DraftMeta, 'id'>>): Promise<DraftMeta> {
  const { dir, meta } = await requireMeta(root, id);
  const next = { ...meta, ...patch, id: meta.id } as DraftMeta;
  await writeMeta(dir, next);
  return next;
}

export async function writeDraftReport(root: string, id: string, report: DraftReport): Promise<void> {
  const { dir } = await requireMeta(root, id);
  await writeFile(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}

/**
 * Stage 4: the draft's last test run on one record (`test-run.json`), or undefined. Only its
 * summary is kept: a file written before that (with the values the run saw) is read as one.
 */
export async function readDraftTestRun(root: string, id: string): Promise<DraftTestRunSummary | undefined> {
  const text = await readText(join(draftDir(root, id), 'test-run.json'));
  try { return text ? testRunSummary(JSON.parse(text) as DraftTestRunSummary) : undefined; } catch { return undefined; }
}

/** Writes the run's summary only (D121): never the values it saw or the arguments of its calls. */
export async function writeDraftTestRun(root: string, id: string, run: DraftTestRunSummary): Promise<void> {
  const { dir } = await requireMeta(root, id);
  await writeFile(join(dir, 'test-run.json'), `${JSON.stringify(testRunSummary(run), null, 2)}\n`);
}

export function testRunSummary(r: DraftTestRunSummary): DraftTestRunSummary {
  return {
    draftId: r.draftId, workflowId: r.workflowId, hash: r.hash, at: r.at, by: r.by,
    record: { entity: r.record.entity, id: r.record.id }, status: r.status,
  };
}

// ---------------------------------------------------------------- edits

export type DraftFiles = { path: string; content: string | null }[] | Record<string, string | null>;

export interface WriteDraftOptions {
  by: string;
  via: DraftEdit['via'];
  chatId?: string;
  summary: string;
}

/**
 * Why a path can't be written in a draft of `workflowId` (a binding draft: `domain/` only), or
 * undefined when it can. A playbook in a domain's folder (`folder`) may also change its domain's
 * definitions, not the domain's other playbooks.
 */
export function badDraftPath(path: string, workflowId: string, kind?: DraftKind, folder?: string): string | undefined {
  if (!path || path.includes('\\') || path.includes('\0')) return 'use a project-relative path with / between folders';
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return 'use a path relative to the project, not an absolute one';
  const parts = path.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return 'a path has no empty, `.` or `..` parts';
  if (parts.some((p) => p.startsWith('.'))) return 'files and folders starting with a dot are not part of a playbook';
  const inDomain = parts[0] === 'domain' && parts.length > 1;
  if (kind === 'binding') return inDomain ? undefined : 'a binding draft only holds domain/...';
  const domainFolder = domainFolderOf(folder);
  if (domainFolder) {
    if (path.startsWith(`${folder}/`)) return undefined;
    if (path.startsWith(`${domainFolder}/`) && !path.startsWith(`${domainFolder}/workflows/`)) return undefined;
    if (inDomain) return undefined;
    return `a draft of ${workflowId} only holds ${folder}/... and its domain's definitions (${domainFolder}/..., not its other playbooks)`;
  }
  const inPlaybook = parts[0] === 'workflows' && parts[1] === workflowId && parts.length > 2;
  if (!inDomain && !inPlaybook) return `a draft of ${workflowId} only holds domain/... and workflows/${workflowId}/...`;
  return undefined;
}

const fileList = (files: DraftFiles) => (Array.isArray(files) ? files : Object.entries(files).map(([path, content]) => ({ path, content })));

/**
 * Writes (or, with content null, deletes) whole files in a draft and records them as one edit:
 * `pending` from chat until kept or discarded, `kept` at once otherwise. Files that don't change
 * are left out; when nothing changes the edit is returned but not recorded.
 */
export async function writeDraftFiles(root: string, id: string, files: DraftFiles, opts: WriteDraftOptions): Promise<DraftEdit> {
  const { dir, meta } = await requireMeta(root, id);
  requireOpen(meta);
  const list = fileList(files);
  const seen = new Set<string>();
  for (const f of list) {
    const why = badDraftPath(f.path, meta.workflowId, meta.kind, meta.folder);
    if (why) throw new Error(`can't write \`${f.path}\`: ${why}`);
    if (f.content !== null && typeof f.content !== 'string') throw new Error(`can't write \`${f.path}\`: the content is text, or null to delete the file`);
    if (seen.has(f.path)) throw new Error(`\`${f.path}\` is written twice in one edit`);
    seen.add(f.path);
  }
  const changes: DraftEdit['files'] = [];
  for (const f of list) {
    const before = await readText(join(dir, f.path));
    if (before === f.content) continue;
    changes.push({ path: f.path, before, after: f.content });
  }
  for (const c of changes) {
    const target = join(dir, c.path);
    if (c.after === null) await rm(target, { force: true });
    else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, c.after);
    }
  }
  const edit: DraftEdit = {
    id: `e-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    at: new Date().toISOString(),
    by: opts.by,
    via: opts.via,
    ...(opts.chatId ? { chatId: opts.chatId } : {}),
    summary: opts.summary,
    files: changes,
    status: opts.via === 'chat' ? 'pending' : 'kept',
  };
  if (changes.length) await appendFile(join(dir, 'edits.jsonl'), `${JSON.stringify(edit)}\n`);
  return edit;
}

/** Marks an edit kept (or discarded, without touching the files: use discardDraftEdit to undo it). */
export async function setDraftEditStatus(root: string, id: string, editId: string, status: DraftEdit['status']): Promise<DraftEdit> {
  const { dir } = await requireMeta(root, id);
  const edits = await readEdits(dir);
  const edit = edits.find((e) => e.id === editId);
  if (!edit) throw new Error(`draft ${id} has no edit ${editId}`);
  edit.status = status;
  await writeEdits(dir, edits);
  return edit;
}

/**
 * Undoes an edit: every file it changed goes back to its `before`, unless the file changed again
 * since (then nothing is undone and `conflicts` names those files).
 */
export async function discardDraftEdit(root: string, id: string, editId: string): Promise<{ applied: boolean; conflicts?: string[]; message?: string; edit?: DraftEdit }> {
  const { dir, meta } = await requireMeta(root, id);
  if (meta.status !== 'open') return { applied: false, message: `draft ${id} is ${meta.status}` };
  const edits = await readEdits(dir);
  const edit = edits.find((e) => e.id === editId);
  if (!edit) return { applied: false, message: `draft ${id} has no edit ${editId}` };
  if (edit.status === 'discarded') return { applied: false, message: 'that edit was already discarded', edit };
  const conflicts: string[] = [];
  for (const f of edit.files) if ((await readText(join(dir, f.path))) !== f.after) conflicts.push(f.path);
  if (conflicts.length) {
    return { applied: false, conflicts, edit, message: `${conflicts.join(', ')} changed again after this edit, so it can't be undone on its own` };
  }
  for (const f of edit.files) {
    const target = join(dir, f.path);
    if (f.before === null) await rm(target, { force: true });
    else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, f.before);
    }
  }
  edit.status = 'discarded';
  await writeEdits(dir, edits);
  return { applied: true, edit };
}

// ---------------------------------------------------------------- hash, load, diff

/**
 * sha256 over the draft's domain/ and workflows/ files (sorted path, NUL, bytes, NUL); not its
 * metadata. A draft of a playbook in a domain's folder also counts domains/ and workspace.yaml.
 */
export async function draftContentHash(root: string, id: string): Promise<string> {
  const dir = draftDir(root, id);
  const h = createHash('sha256');
  for (const top of ['domain', 'workflows', 'domains']) {
    for (const f of await listFiles(join(dir, top))) h.update(`${top}/${f}`).update('\0').update(await readFile(join(dir, top, f))).update('\0');
  }
  if (await isFile(join(dir, 'workspace.yaml'))) h.update('workspace.yaml').update('\0').update(await readFile(join(dir, 'workspace.yaml'))).update('\0');
  return h.digest('hex');
}

/** The draft folder loaded as a project, and the playbook it's about when that loads. */
export async function loadDraft(root: string, id: string): Promise<{ project: ProjectDefs; diagnostics: Diagnostic[]; workflow?: WorkflowDef; meta: DraftMeta }> {
  const { dir, meta } = await requireMeta(root, id);
  // A binding draft's binding isn't frozen yet; its checks and dry run count it all the same.
  const { project, diagnostics } = await loadProject(dir, meta.kind === 'binding' && meta.plugin ? { unfrozen: [meta.plugin.id] } : {});
  const workflow = project.workflows[meta.workflowId];
  return { project, diagnostics, meta, ...(workflow ? { workflow } : {}) };
}

interface PendingChange { path: string; draft: string | null; live: string | null; conflict: boolean }

/**
 * The files a draft changed compared with its base (only these are published), each with the
 * live content now and whether the live file changed since the draft was made.
 */
async function changedFiles(root: string, dir: string, meta: DraftMeta): Promise<PendingChange[]> {
  const abs = resolve(root);
  const draftFiles = await contentFiles(dir, meta.workflowId, meta.kind, meta.folder);
  const paths = [...new Set([...Object.keys(meta.base), ...draftFiles])].sort();
  const out: PendingChange[] = [];
  for (const path of paths) {
    const draftBytes = (await isFile(join(dir, path))) ? await readFile(join(dir, path)) : null;
    const baseHash = meta.base[path];
    const draftHash = draftBytes ? hashOf(draftBytes) : undefined;
    if (draftHash === baseHash) continue; // the draft didn't touch it
    const liveBytes = (await isFile(join(abs, path))) ? await readFile(join(abs, path)) : null;
    const liveHash = liveBytes ? hashOf(liveBytes) : undefined;
    if (liveHash === draftHash) continue; // live already has exactly this
    out.push({ path, draft: draftBytes?.toString('utf8') ?? null, live: liveBytes?.toString('utf8') ?? null, conflict: liveHash !== baseHash });
  }
  return out;
}

/**
 * Files of the draft's playbook that changed live since the draft was made, whether or not the
 * draft touched them: once another draft of the same playbook is published, this one was made
 * from an older version and would publish an unreviewed mix of both under the same number.
 */
async function playbookMovedOn(root: string, meta: DraftMeta): Promise<string[]> {
  if (meta.kind === 'binding') {
    // The binding file is to a binding draft what the playbook is to a change draft.
    const file = bindingPath(meta.plugin?.id ?? pluginIdOfSlug(meta.workflowId));
    const full = join(resolve(root), file);
    const liveHash = (await isFile(full)) ? hashOf(await readFile(full)) : undefined;
    return liveHash !== meta.base[file] ? [file] : [];
  }
  const folder = draftPlaybookFolder(meta);
  const prefix = `${folder}/`;
  const live = (await listFiles(join(resolve(root), folder))).map((f) => prefix + f);
  const paths = [...new Set([...Object.keys(meta.base).filter((p) => p.startsWith(prefix)), ...live])].sort();
  const out: string[] = [];
  for (const path of paths) {
    const full = join(resolve(root), path);
    const liveHash = (await isFile(full)) ? hashOf(await readFile(full)) : undefined;
    if (liveHash !== meta.base[path]) out.push(path);
  }
  return out;
}

/** Conflicts: changed files whose live copy moved on, and any file of the playbook that did. */
async function conflictsOf(root: string, meta: DraftMeta, changes: PendingChange[]): Promise<string[]> {
  return [...new Set([...changes.filter((c) => c.conflict).map((c) => c.path), ...(await playbookMovedOn(root, meta))])].sort();
}

/** What publishing the draft would change in the live project: file diffs, structure, conflicts. */
export async function diffDraft(root: string, id: string, opts: { context?: number } = {}): Promise<DraftDiff> {
  const { dir, meta } = await requireMeta(root, id);
  const changes = await changedFiles(root, dir, meta);
  const files: FileChange[] = changes.map((c) => ({
    path: c.path,
    status: c.live === null ? 'added' : c.draft === null ? 'deleted' : 'modified',
    ...(c.live !== null ? { before: c.live } : {}),
    ...(c.draft !== null ? { after: c.draft } : {}),
    hunks: lineDiff(c.live ?? '', c.draft ?? '', opts.context ?? 3),
    ...(c.conflict ? { conflict: true } : {}),
  }));
  const diff: DraftDiff = { draftId: id, workflowId: meta.workflowId, files, conflicts: await conflictsOf(root, meta, changes) };
  if (meta.kind === 'binding') return diff; // no playbook, so no structural diff
  const draft = await loadProject(dir);
  const after = draft.project.workflows[meta.workflowId];
  if (after) {
    const live = await loadProject(root);
    diff.structure = structuralDiff(live.project.workflows[meta.workflowId], after, {
      before: Object.keys(live.project.roles),
      after: Object.keys(draft.project.roles),
    });
  }
  return diff;
}

// ---------------------------------------------------------------- publish

/**
 * Publishes a draft: copies the files it changed over the live ones (deleting those it deleted)
 * and marks it published. Refuses with DraftConflictError, changing nothing, when a live file it
 * changed, or any file of its playbook, changed since the draft was made; with `hash`, refuses
 * with DraftStaleError when the draft's content isn't the one checked. A binding draft publishes
 * its changed `domain/` files (the binding, and any entity or role it added), and returns the
 * binding's `version`. Files are written under temporary names first and renamed into
 * place; if anything fails, the live files are put back.
 */
export async function applyDraft(root: string, id: string, opts: { hash?: string } = {}): Promise<{ workflowId: string; version: number; files: string[] }> {
  const abs = resolve(root);
  const { dir, meta } = await requireMeta(abs, id);
  requireOpen(meta);
  if (opts.hash !== undefined) {
    const actual = await draftContentHash(abs, id);
    if (actual !== opts.hash) throw new DraftStaleError(opts.hash, actual);
  }
  const changes = await changedFiles(abs, dir, meta);
  const conflicts = await conflictsOf(abs, meta, changes);
  if (conflicts.length) throw new DraftConflictError(conflicts);

  let version: number;
  if (meta.kind === 'binding') {
    const file = bindingPath(meta.plugin?.id ?? pluginIdOfSlug(meta.workflowId));
    const text = await readText(join(dir, file));
    if (text === null) throw new Error(`the draft has no ${file}, so there is nothing to publish`);
    version = parseBindingFile(text, file).value?.version ?? 0;
  } else {
    const folder = draftPlaybookFolder(meta);
    const shapeText = await readText(join(dir, folder, 'workflow.yaml'));
    if (shapeText === null) throw new Error(`the draft has no ${folder}/workflow.yaml, so there is nothing to publish`);
    version = parseWorkflowFile(shapeText, 'workflow.yaml').value?.version ?? 1;
  }

  const suffix = `.mw-publish-${randomBytes(4).toString('hex')}`;
  // Dotfile names, so a watcher re-indexing meanwhile never reads a half-written file.
  const tmpOf = (path: string) => join(abs, dirname(path), `.${basename(path)}${suffix}`);
  const done: PendingChange[] = [];
  try {
    for (const c of changes) {
      if (c.draft === null) continue;
      await mkdir(dirname(join(abs, c.path)), { recursive: true });
      await writeFile(tmpOf(c.path), c.draft);
    }
    for (const c of changes) {
      if (c.draft === null) await rm(join(abs, c.path), { force: true });
      else await rename(tmpOf(c.path), join(abs, c.path));
      done.push(c);
    }
  } catch (e) {
    // Put back what was already replaced, then drop the temporary files.
    for (const c of done.reverse()) {
      try {
        if (c.live === null) await rm(join(abs, c.path), { force: true });
        else await writeFile(join(abs, c.path), c.live);
      } catch { /* best effort; the error below says publishing failed */ }
    }
    for (const c of changes) if (c.draft !== null) await rm(tmpOf(c.path), { force: true }).catch(() => {});
    throw e;
  }
  await updateDraftMeta(abs, id, { status: 'published', publishedVersion: version, publishedAt: new Date().toISOString() });
  return { workflowId: meta.workflowId, version, files: changes.map((c) => c.path) };
}
