// Drafts and change control (20 §1-§5): the Authoring the app, the chat and the meta playbooks'
// tools use. Files are `@memwise/defs`'s drafts (no database); the kernel adds what needs one:
// the bound tools to check against, the cases a change would affect, past cases to replay, the
// version index, and the change runs themselves (create-playbook, change-playbook).
import { actorLabel, PgVersionStore } from '@memwise/db';
import {
  applyDraft, checkProject, createDraft, describeStructuralDiff, diffDraft, discardDraftEdit, DraftConflictError, draftContentHash,
  draftDir, draftPlaybookFolder, DraftStaleError, exampleToYaml, livePlaybookFolder, listDrafts, loadDraft, loadWorkflow, readDraft, SCALAR_TYPES, setDraftEditStatus,
  updateDraftMeta, WORKFLOW_ID_PATTERN, writeDraftFiles, writeDraftReport,
  type CheckEnvironment, type Diagnostic, type DraftReport, type ExampleCase, type ExampleOutcome, type Impact,
  type DiffNameKind, type ImpactTool, type PastCaseOutcome, type ProjectDefs, type StructuralDiff, type WorkflowDef,
} from '@memwise/defs';
import type { ToolGateway } from '@memwise/gateway';
import { compilePolicy, decide, extractDiagnostics, layersFor, pluginLayers, violationsToDiagnostics } from '@memwise/policy';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type pg from 'pg';
import { domainTools } from './domain-tools.ts';
import { PUBLISH_DRAFT_TOOL } from './authoring-tools.ts';
import { boundPlugins, pluginPolicies, pluginToolEnvironment } from './plugins/tools.ts';
import { newRunId } from './ids.ts';
import { exampleNameFor } from './replay.ts';
import { getTransitions, latestWorkflowDef, projectPolicyLayers } from './runs.ts';
import {
  CHANGE_PLAYBOOK, CREATE_PLAYBOOK, type Actor, type Authoring, type KernelChange, type RunRecord, type StartRunInput, type TestRunner,
  type Vocabulary,
} from './types.ts';
import { maySee, pathOf } from './views.ts';

export interface AuthoringDeps {
  projectDir: string;
  pool: pg.Pool;
  tools: () => ToolGateway;
  /** The live project as last indexed. */
  project(): Promise<{ project: ProjectDefs; diagnostics: Diagnostic[] }>;
  index(): Promise<Diagnostic[]>;
  /** startRun as the kernel itself: it may set fields a step normally writes (the draft). */
  startRun(input: StartRunInput): Promise<{ runId: string; caseId: string }>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  caseToExample(caseId: string, opts?: { name?: string; correction?: { step: string; outcome: string; note?: string } }): Promise<ExampleCase>;
  testRunner: TestRunner;
  emit(change: KernelChange): void;
  /**
   * Stage 5 (26 §8): change requests. A person's new change draft of a regulated domain's playbook
   * opens one; a draft with one is published only by it (QA's signature).
   */
  changes?: {
    onDraftCreated(meta: { id: string; workflowId: string; title: string; kind: string }, by: Actor): Promise<void>;
    publishRefusal(draftId: string, changeRequest: string | undefined): Promise<string | undefined>;
    regulated(workflowId: string): boolean;
  };
}

/** Past cases replayed by a check, by default. */
const PAST_CASES = 5;
const PAST_PREFIX = 'past-';

const byLabel = (by: Actor) => (by.kind === 'person' ? by.personId : actorLabel(by));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const errorCount = (ds: Diagnostic[]) => ds.filter((d) => d.severity === 'error').length;

/** Value type names and the forms they take (04 §4). */
const VALUE_FORMS = ['Identifier(<scheme>)', 'Quantity(<unit>)', 'Enum[<a>, <b>]', 'List<T>', 'Ref<Entity>'];

/** A project-relative path a draft or the live project may be read at. */
function readablePath(path: string): boolean {
  const parts = path.split('/');
  if (path === 'workspace.yaml') return true;
  return (parts[0] === 'domain' || parts[0] === 'workflows' || parts[0] === 'domains') && parts.length > 1
    && !parts.some((p) => p === '' || p === '.' || p === '..' || p.startsWith('.')) && !path.includes('\\');
}

/** `domains/<d>/workflows/<id>` → `d`. */
const domainOfFolder = (folder: string) => /^domains\/([^/]+)\/workflows\//.exec(`${folder}/`)?.[1];

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
  return out.sort();
}

/** `client_name` → "Client name". */
const inWords = (id: string) => {
  const w = id.replace(/[_.-]+/g, ' ').trim();
  return w ? w[0]!.toUpperCase() + w.slice(1) : id;
};

/** A tool by what it does: `intake.extract_fields` → "Extract fields", `domain.customer.create` → "Create customer". */
function toolInWords(tool: string): string {
  const parts = tool.split('.');
  const last = parts.at(-1) ?? tool;
  if (parts.length === 3 && parts[0] === 'domain') return inWords(`${last} ${parts[1]}`);
  if (parts.length === 2 && !/[_-]/.test(last)) return inWords(`${last} ${parts[0]}`);
  return inWords(last);
}

/**
 * Names for a review card's summary (people read it, not the CLI): steps by their titles,
 * everything else in words, in quotes; no ids in code formatting.
 */
function namesInWords(...workflows: (WorkflowDef | undefined)[]): (kind: DiffNameKind, id: string) => string {
  return (kind, id) => {
    if (kind === 'tool') return `“${toolInWords(id)}”`;
    if (kind === 'state') {
      if (id === 'end') return '“End”';
      const title = workflows.map((w) => w?.steps[id]?.title).find(Boolean);
      return `“${title ?? inWords(id)}”`;
    }
    if (kind === 'playbook') return `“${workflows.map((w) => w?.title).find(Boolean) ?? inWords(id)}”`;
    return `“${inWords(id)}”`;
  };
}

/**
 * An example case's file name from its name: lower case, words joined by hyphens
 * (`Unreadable GST certificate` → `unreadable-gst-certificate`). Empty when nothing is left.
 */
export function exampleFileSlug(name: string): string {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 64).replace(/-+$/, '');
}

/** Tools a step uses: allowed, required, and those its writes come from. */
function toolsOf(workflow: WorkflowDef): Map<string, string> {
  const by = new Map<string, string>();
  for (const step of Object.values(workflow.steps)) {
    for (const t of [...step.tools.required, ...step.tools.allowed]) if (!by.has(t)) by.set(t, step.id);
    for (const w of Object.values(step.writes)) if (w.from.kind === 'tool' && !by.has(w.from.tool)) by.set(w.from.tool, step.id);
  }
  return by;
}

/** Roles a playbook names: owner, assignees, approvers. */
function rolesOf(workflow: WorkflowDef): Set<string> {
  const roles = new Set<string>();
  if (workflow.owner) roles.add(workflow.owner);
  for (const s of Object.values(workflow.states)) if (s.assignee) roles.add(s.assignee);
  for (const s of Object.values(workflow.steps)) {
    if (s.assignee) roles.add(s.assignee);
    for (const r of s.policy?.approvals?.by ?? []) roles.add(r);
  }
  for (const r of workflow.policy?.approvals?.by ?? []) roles.add(r);
  return roles;
}

/** Entity types a playbook uses: in its case type, and through the domain tools its steps call. */
function entitiesOf(workflow: WorkflowDef, entities: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const walk = (t: { kind: string; of?: unknown; entity?: string; name?: string }) => {
    if (t.kind === 'list') walk(t.of as typeof t);
    else if (t.kind === 'ref' && t.entity) out.add(t.entity);
    else if (t.kind === 'named' && t.name && entities[t.name]) out.add(t.name);
  };
  for (const f of Object.values(workflow.caseType.fields)) walk(f.type);
  for (const r of Object.values(workflow.caseType.types)) for (const f of Object.values(r.fields)) walk(f.type);
  for (const tool of toolsOf(workflow).keys()) {
    const m = /^domain\.([^.]+)\./.exec(tool);
    const name = m && Object.keys(entities).find((e) => e.toLowerCase() === m[1]!.toLowerCase());
    if (name) out.add(name);
  }
  return out;
}

/** A regulated domain's playbook changes only through a change request (26 §8, D115). */
const regulatedRefusal = (name: string) =>
  new Error(`${name} is in a regulated domain: a change to it is a change request (open one, then QA's signature makes it live)`);

export function createAuthoring(deps: AuthoringDeps): Authoring {
  const root = resolve(deps.projectDir);
  const versions = new PgVersionStore();
  const emit = (draftId: string) => deps.emit({ kind: 'drafts', draftId });

  async function requireDraft(draftId: string) {
    const d = await readDraft(root, draftId);
    if (!d) throw new Error(`there is no draft ${draftId}`);
    return d;
  }

  /**
   * Every bound tool, plus the domain tools of the draft's own entity types (a draft may add one)
   * and the tools of the plugins its bindings bind (Phase 4), known without connecting to them.
   */
  function environment(project: ProjectDefs): CheckEnvironment {
    const gateway = deps.tools();
    const tools: CheckEnvironment['tools'] = {};
    for (const [name, b] of Object.entries(gateway.bound())) tools[name] = { effect: b.effect, inputSchema: gateway.get(name)?.inputSchema };
    for (const t of domainTools(project.entities)) {
      tools[t.name] ??= { effect: typeof t.effect === 'string' ? t.effect : undefined, inputSchema: t.inputSchema };
    }
    for (const [name, t] of Object.entries(pluginToolEnvironment(boundPlugins(project)))) tools[name] ??= t;
    return { tools };
  }

  async function quickCheck(draftId: string): Promise<Diagnostic[]> {
    const { project, diagnostics, meta } = await loadDraft(root, draftId);
    const env = environment(project);
    const all = [...diagnostics, ...checkProject(project, env)];
    // Policy tightening per step, as `memwise check` does (the workflow layer is in every step's stack).
    const seen = new Set<string>();
    const workflow = project.workflows[meta.workflowId];
    if (workflow) {
      const policies = pluginPolicies(boundPlugins(project));
      for (const step of [undefined, ...Object.values(workflow.steps)]) {
        const plugins = pluginLayers(policies, workflow, step);
        const { effective, violations } = compilePolicy(layersFor({ ...projectPolicyLayers(project, workflow), plugins, workflow, step }));
        for (const d of [...violationsToDiagnostics(violations), ...extractDiagnostics(step, effective, env.tools)]) {
          const key = `${d.file}|${d.path}|${d.message}`;
          if (!seen.has(key)) { seen.add(key); all.push(d); }
        }
      }
    }
    // Only what this draft is about: its playbook's folder and the domain (a named domain's own folder).
    const folder = draftPlaybookFolder(meta);
    const named = domainOfFolder(folder);
    const mine = (file?: string) => !file || file.startsWith(`${folder}/`) || file === folder
      || (named ? file === `domains/${named}` || (file.startsWith(`domains/${named}/`) && !file.startsWith(`domains/${named}/workflows/`))
        : file.startsWith('domain/') || file === 'domain');
    return all.filter((d) => mine(d.file));
  }

  async function liveWorkflow(workflowId: string): Promise<WorkflowDef | undefined> {
    const { project } = await deps.project();
    return project.workflows[workflowId] ?? (await latestWorkflowDef(deps.pool, workflowId));
  }

  /**
   * Recent finished cases of the playbook, replayed as examples on the draft: the live version's
   * first, then cases that finished on earlier versions (a case started before the last change
   * finishes on its own version, and is still the best evidence of what the playbook is for).
   */
  async function pastCaseExamples(live: WorkflowDef | undefined, n: number): Promise<{ caseId: string; title: string; livePath: string[]; example: ExampleCase }[]> {
    if (!live || n <= 0) return [];
    const { rows } = await deps.pool.query(
      `select r.id, r.case_id, c.values from mw.runs r join mw.cases c on c.id = r.case_id
        where r.workflow_id = $1 and r.status = 'done'
        order by (r.workflow_hash = $2) desc, r.updated_at desc, r.id desc limit $3`,
      [live.id, live.hash, n]);
    const out = [];
    for (const r of rows) {
      try {
        const example = await deps.caseToExample(r.case_id, { name: `${PAST_PREFIX}${r.case_id.replace(/^case_/, '').slice(-8).toLowerCase()}` });
        const transitions = await getTransitions(deps.pool, r.id);
        // A title from the first text value anyone may see: a field the live version still has, unrestricted
        // (a case from an older version may hold fields that were restricted or have since gone).
        const fields = live.caseType.fields;
        const firstText = Object.entries((r.values ?? {}) as Record<string, { value: unknown }>)
          .filter(([k]) => fields[k] && !fields[k].access?.length).map(([, v]) => v.value).find((v) => typeof v === 'string');
        out.push({ caseId: r.case_id as string, title: (firstText as string | undefined) ?? r.case_id, livePath: pathOf(transitions[0]?.from ?? live.start, transitions), example });
      } catch { /* a case that can't be turned into a replay is left out */ }
    }
    return out;
  }

  function pastOutcome(p: { caseId: string; title: string; livePath: string[] }, o: ExampleOutcome | undefined): PastCaseOutcome {
    const base = { caseId: p.caseId, title: p.title, livePath: p.livePath };
    if (!o) return { ...base, status: 'skip', differences: ['not run'], draftPath: [] };
    if (o.status === 'skip') return { ...base, status: 'skip', differences: o.reason ? [o.reason] : [], draftPath: [] };
    if (o.status === 'pass') return { ...base, status: 'same', differences: [], draftPath: p.livePath };
    // The replay ended elsewhere: where, when the CLI said so (`state: expected a, got b`).
    const got = o.differences.map((d) => /^state: expected \S+, got (\S+)/.exec(d)?.[1]).find(Boolean);
    const status = !o.differences.length && o.reason ? 'error' : 'different';
    return { ...base, status, differences: o.differences.length ? o.differences : [o.reason ?? 'failed'], draftPath: got ? [p.livePath[0]!, got] : [] };
  }

  async function impact(draft: { project: ProjectDefs; workflow?: WorkflowDef }, structure: StructuralDiff | undefined, live: WorkflowDef | undefined): Promise<Impact | undefined> {
    const after = draft.workflow;
    if (!after || !structure) return undefined;
    const { rows } = await deps.pool.query(
      `select state, count(*)::int as n from mw.runs where workflow_id = $1 and status = 'active' group by state order by state`, [after.id]);
    const byState = Object.fromEntries(rows.map((r) => [r.state, r.n as number]));
    const total = rows.reduce((a, r) => a + (r.n as number), 0);
    const removedStatesWithCases = Object.entries(structure.states).filter(([s, c]) => c === 'removed' && byState[s])
      .map(([state]) => ({ state, cases: byState[state]! }));

    const gateway = deps.tools();
    const bound = gateway.bound();
    const draftDomain = new Map(domainTools(draft.project.entities).map((t) => [t.name, t]));
    const usedBy = toolsOf(after);
    const newTools: ImpactTool[] = structure.tools.added.map((name) => {
      const def = gateway.get(name) ?? draftDomain.get(name);
      const effect = bound[name]?.effect ?? (typeof def?.effect === 'string' ? def.effect : undefined);
      const isBound = !!bound[name] || draftDomain.has(name);
      const stepId = usedBy.get(name);
      const step = stepId ? after.steps[stepId] : undefined;
      let treatment: ImpactTool['treatment'];
      if (isBound) {
        const plugins = pluginLayers(pluginPolicies(boundPlugins(draft.project)), after, step);
        const { effective } = compilePolicy(layersFor({ ...projectPolicyLayers(draft.project, after), plugins, workflow: after, step }));
        treatment = decide(effective, { tool: name, effect: effect ?? 'irreversible', classified: !!effect, tainted: false }).verdict;
      }
      return { name, bound: isBound, ...(effect ? { effect } : {}), ...(treatment ? { treatment } : {}), ...(def?.source?.plugin ? { plugin: def.source.plugin } : {}) };
    });
    const newRequiredTools = structure.requiredTools.filter((r) => r.change === 'added').map(({ step, tool }) => ({ step, tool }));

    // Domain changes, and the other live playbooks that use what changed.
    const { project: liveProject } = await deps.project();
    const changedEntities = new Set<string>();
    for (const name of new Set([...Object.keys(liveProject.entities), ...Object.keys(draft.project.entities)])) {
      if (liveProject.entities[name]?.hash !== draft.project.entities[name]?.hash) changedEntities.add(name);
    }
    const changedRoles = new Set<string>();
    for (const id of new Set([...Object.keys(liveProject.roles), ...Object.keys(draft.project.roles)])) {
      if (JSON.stringify(liveProject.roles[id]) !== JSON.stringify(draft.project.roles[id])) changedRoles.add(id);
    }
    const otherPlaybooks: Impact['otherPlaybooks'] = [];
    for (const wf of Object.values(liveProject.workflows)) {
      if (wf.id === after.id) continue;
      const entities = [...entitiesOf(wf, liveProject.entities)].filter((e) => changedEntities.has(e));
      const roles = [...rolesOf(wf)].filter((r) => changedRoles.has(r));
      const uses = [...entities, ...roles.map((r) => `role ${r}`)];
      if (uses.length) otherPlaybooks.push({ id: wf.id, uses, entities, roles });
    }

    const summary = [...describeStructuralDiff(structure)];
    if (total) {
      const where = Object.entries(byState).map(([s, n]) => `${n} in ${s}`).join(', ');
      summary.push(`${plural(total, 'case')} still running (${where}) ${total === 1 ? 'keeps the version it' : 'keep the versions they'} started on.`);
    }
    for (const r of removedStatesWithCases) summary.push(`${plural(r.cases, 'case')} in \`${r.state}\`, which this change removes, will finish on the old version.`);
    for (const t of newTools) {
      summary.push(t.bound
        ? `New tool \`${t.name}\` (${t.effect ?? 'unclassified'})${t.treatment && t.treatment !== 'allow' ? `: ${t.treatment === 'approve' ? 'needs approval' : t.treatment === 'deny' ? 'denied by policy' : 'runs with a preview'}` : ''}.`
        : `New tool \`${t.name}\` is not bound in the domain.`);
    }
    for (const o of otherPlaybooks) summary.push(`\`${o.id}\` also uses ${o.uses.join(', ')}.`);
    return {
      workflowId: after.id, ...(live ? { liveVersion: live.version } : {}), newVersion: after.version,
      openCases: { total, byState }, removedStatesWithCases, newTools, newRequiredTools, caseFields: structure.caseFields,
      otherPlaybooks, summary,
    };
  }

  /** Until the run waits in a conversation step; its step run id. */
  async function waitingConversation(runId: string, timeoutMs = 30_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { rows } = await deps.pool.query(
        `select id from mw.step_runs where run_id = $1 and status = 'waiting' and performer = 'agent' order by started_at desc, id desc limit 1`, [runId]);
      if (rows[0]) return rows[0].id;
      const run = await deps.getRun(runId);
      if (run && run.status !== 'active') throw new Error(`the change run ${runId} ended (${run.status} in ${run.state}) before its conversation step opened`);
      if (Date.now() > deadline) throw new Error(`the change run ${runId} did not reach its conversation step in ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  const authoring: Authoring = {
    projectDir: root,

    async vocabulary(): Promise<Vocabulary> {
      const { project } = await deps.project();
      const gateway = deps.tools();
      const tools = Object.entries(gateway.bound()).filter(([name]) => name !== PUBLISH_DRAFT_TOOL).map(([name, b]) => {
        const def = gateway.get(name);
        return {
          name, ...(def?.description ? { description: def.description } : {}), ...(b.effect ? { effect: b.effect } : {}),
          ...(def?.source?.plugin ? { plugin: def.source.plugin } : {}), ...(def?.inputSchema ? { inputSchema: def.inputSchema } : {}),
        };
      }).sort((a, b) => a.name.localeCompare(b.name));
      const modelRoles = new Set(project.domainPolicy?.modelRoles ?? []);
      for (const wf of Object.values(project.workflows)) for (const s of Object.values(wf.steps)) if (s.model) modelRoles.add(s.model);
      const drafts = (await listDrafts(root)).filter((d) => d.kind === 'create' && d.status === 'open' && !project.workflows[d.workflowId]);
      return {
        tools,
        entities: Object.values(project.entities).map((e) => ({
          name: e.entity, fields: Object.entries(e.fields).map(([name, f]) => ({ name, type: f.typeSource })), ...(e.lifecycle ? { lifecycle: e.lifecycle } : {}),
        })),
        roles: Object.values(project.roles).map((r) => ({ id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) })),
        modelRoles: [...modelRoles].sort(),
        valueTypes: [...SCALAR_TYPES, ...VALUE_FORMS, ...Object.keys(project.entities)],
        playbooks: [
          ...Object.values(project.workflows).map((w) => ({ id: w.id, title: w.title ?? w.id, version: w.version, live: true })),
          ...drafts.map((d) => ({ id: d.workflowId, title: d.title, live: false })),
        ],
      };
    },

    async listDrafts(filter = {}) {
      return (await listDrafts(root)).filter((d) => (!filter.workflowId || d.workflowId === filter.workflowId) && (!filter.status || d.status === filter.status));
    },

    async getDraft(draftId) {
      const d = await readDraft(root, draftId);
      if (!d) return undefined;
      return { ...d, contentHash: await draftContentHash(root, draftId) };
    },

    async createDraft(input, by) {
      const meta = await createDraft(root, { workflowId: input.workflowId, title: input.title, kind: input.kind, createdBy: byLabel(by), ...(input.runId ? { runId: input.runId } : {}) });
      await deps.changes?.onDraftCreated(meta, by);
      emit(meta.id);
      return meta;
    },

    async read({ draftId, workflowId, path }) {
      // The id becomes a folder path: a chat must not list folders outside the project with it.
      if (workflowId !== undefined && !WORKFLOW_ID_PATTERN.test(workflowId)) throw new Error(`\`${workflowId}\` is not a playbook id`);
      let base = root;
      let folder = workflowId ? (await livePlaybookFolder(root, workflowId)) ?? `workflows/${workflowId}` : undefined;
      if (draftId) {
        const { meta } = await requireDraft(draftId);
        base = draftDir(root, draftId);
        folder = draftPlaybookFolder(meta);
      }
      if (path === undefined) {
        // A named domain's playbook: its folder, and its domain's rules and record types beside it.
        const named = folder ? domainOfFolder(folder) : undefined;
        const files = [
          ...(named
            ? [
              ...(existsSync(join(base, 'domains', named, 'policy.yaml')) ? [`domains/${named}/policy.yaml`] : []),
              ...(await listFiles(join(base, 'domains', named, 'entities'))).map((f) => `domains/${named}/entities/${f}`),
            ]
            : (await listFiles(join(base, 'domain'))).map((f) => `domain/${f}`)),
          ...(folder
            ? (await listFiles(join(base, folder))).map((f) => `${folder}/${f}`)
            : (await listFiles(join(base, 'workflows'))).map((f) => `workflows/${f}`)),
        ];
        return { files };
      }
      if (!readablePath(path)) throw new Error(`\`${path}\` is not a file of the project: use a path under domain/ or workflows/`);
      const file = join(base, path);
      return { path, content: existsSync(file) ? await readFile(file, 'utf8') : null };
    },

    async write(input, by) {
      const edit = await writeDraftFiles(root, input.draftId, input.files, {
        by: byLabel(by), via: input.via, summary: input.summary, ...(input.chatId ? { chatId: input.chatId } : {}),
      });
      emit(input.draftId);
      return { edit, diagnostics: await quickCheck(input.draftId) };
    },

    async keepEdit(draftId, editId) {
      try {
        await setDraftEditStatus(root, draftId, editId, 'kept');
        emit(draftId);
        return { applied: true };
      } catch (e) {
        return { applied: false, message: e instanceof Error ? e.message : String(e) };
      }
    },

    async discardEdit(draftId, editId) {
      const r = await discardDraftEdit(root, draftId, editId);
      if (r.applied) emit(draftId);
      return { applied: r.applied, ...(r.message ? { message: r.message } : {}), ...(r.conflicts ? { conflicts: r.conflicts } : {}) };
    },

    async discardDraft(draftId) {
      const { meta } = await requireDraft(draftId);
      if (meta.status !== 'open') throw new Error(`draft ${draftId} is ${meta.status}`);
      await updateDraftMeta(root, draftId, { status: 'discarded' });
      emit(draftId);
    },

    diff: (draftId) => diffDraft(root, draftId),
    quickCheck,

    async check(draftId, opts = {}) {
      const draft = await loadDraft(root, draftId);
      const { meta } = draft;
      const hash = await draftContentHash(root, draftId);
      const diagnostics = await quickCheck(draftId);
      const errors = errorCount(diagnostics);
      const live = meta.kind === 'change' ? await liveWorkflow(meta.workflowId) : undefined;
      const diff = await diffDraft(root, draftId).catch(() => undefined);

      let examples: ExampleOutcome[] = [];
      let pastCases: PastCaseOutcome[] = [];
      if (!errors && draft.workflow) {
        const past = await pastCaseExamples(live, opts.pastCases ?? PAST_CASES);
        const outcomes = await deps.testRunner({
          projectDir: draftDir(root, draftId), workflowId: meta.workflowId,
          ...(past.length ? { extraExamples: past.map((p) => p.example) } : {}),
        });
        const pastNames = new Set(past.map((p) => p.example.name));
        examples = outcomes.filter((o) => !pastNames.has(o.name));
        pastCases = past.map((p) => pastOutcome(p, outcomes.find((o) => o.name === p.example.name)));
      }
      const failing = examples.filter((e) => e.status === 'fail').length;
      const passed = errors === 0 && failing === 0 && !!draft.workflow;
      const warnings = diagnostics.length - errors;
      const parts = [
        errors ? `${plural(errors, 'error')} to fix` : 'checks pass',
        ...(warnings ? [plural(warnings, 'warning')] : []),
        errors ? 'example cases not run' : `${examples.filter((e) => e.status === 'pass').length} of ${plural(examples.length, 'example case')} pass`,
        ...(pastCases.length ? [`${pastCases.filter((p) => p.status === 'same').length} of ${plural(pastCases.length, 'past case')} go the same way`] : []),
      ];
      if (!draft.workflow) parts.unshift(`the playbook ${meta.workflowId} does not load`);
      const report: DraftReport = {
        draftId, workflowId: meta.workflowId, hash, at: new Date().toISOString(), diagnostics, errors, warnings, examples, pastCases,
        ...(await impact(draft, diff?.structure, live).then((i) => (i ? { impact: i } : {}))),
        outcome: passed ? 'passed' : 'failed',
        summary: `${parts.join('; ')}.`.replace(/^./, (c) => c.toUpperCase()),
      };
      await writeDraftReport(root, draftId, report);
      emit(draftId);
      return report;
    },

    async publish(draftId, opts) {
      const d = await readDraft(root, draftId);
      if (!d) return { status: 'failed', message: `there is no draft ${draftId}` };
      if (d.meta.status === 'published') {
        // Publishing again (a retried publish step) finds the version it made.
        const { rows } = await deps.pool.query(
          `select version, hash from mw.workflow_versions where workflow_id = $1 and draft_id = $2 order by published_at desc limit 1`, [d.meta.workflowId, draftId]);
        if (rows[0]) return { status: 'published', workflowId: d.meta.workflowId, version: rows[0].version, hash: rows[0].hash };
        return { status: 'failed', message: `draft ${draftId} was already published` };
      }
      if (d.meta.status !== 'open') return { status: 'failed', message: `draft ${draftId} is ${d.meta.status}` };
      const refusal = await deps.changes?.publishRefusal(draftId, opts.changeRequest);
      if (refusal) return { status: 'failed', message: refusal };
      if ((await draftContentHash(root, draftId)) !== opts.hash) return { status: 'stale', message: 'the draft changed after it was checked; check it again' };
      try {
        await applyDraft(root, draftId, { hash: opts.hash });
      } catch (e) {
        if (e instanceof DraftConflictError) return { status: 'conflict', message: e.message };
        if (e instanceof DraftStaleError) return { status: 'stale', message: e.message };
        return { status: 'failed', message: e instanceof Error ? e.message : String(e) };
      }
      const { workflow } = await loadWorkflow(join(root, draftPlaybookFolder(d.meta)), root);
      if (!workflow) return { status: 'failed', message: `the published playbook ${d.meta.workflowId} does not load` };
      // Recorded before indexing, so the index finds the hash known and doesn't record it as `files`.
      await versions.record(deps.pool, {
        workflowId: workflow.id, version: workflow.version, hash: workflow.hash, source: opts.source, draftId,
        ...(opts.by ? { publishedBy: opts.by } : {}), ...(opts.runId ? { runId: opts.runId } : {}),
      });
      await deps.index();
      emit(draftId);
      return { status: 'published', workflowId: workflow.id, version: workflow.version, hash: workflow.hash };
    },

    async startBuild(input, by) {
      if (!input.workflowId) {
        const values = { ...(input.request ? { request: input.request } : {}), ...(input.title ? { title: input.title } : {}) };
        const started = await deps.startRun({ workflowId: CREATE_PLAYBOOK, case: values, by: by.personId });
        return { ...started, stepRunId: await waitingConversation(started.runId) };
      }
      const live = await liveWorkflow(input.workflowId);
      if (!live) throw new Error(`there is no playbook ${input.workflowId} to change`);
      if (deps.changes?.regulated(input.workflowId)) throw regulatedRefusal(live.title ?? live.id);
      const runId = newRunId();
      const title = input.title ?? `Change ${live.title ?? live.id}`;
      const meta = await createDraft(root, { workflowId: input.workflowId, title, kind: 'change', createdBy: by.personId, runId });
      let started;
      try {
        started = await deps.startRun({
          workflowId: CHANGE_PLAYBOOK, runId, by: by.personId,
          case: { playbook: input.workflowId, title, draft: meta.id, ...(input.request ? { request: input.request } : {}) },
        });
      } catch (e) {
        // No change run: don't leave an open draft behind that points at one.
        await updateDraftMeta(root, meta.id, { status: 'discarded' }).catch(() => undefined);
        throw e;
      }
      emit(meta.id);
      return { ...started, stepRunId: await waitingConversation(started.runId) };
    },

    async submitDraft(draftId, by) {
      const { meta, edits } = await requireDraft(draftId);
      if (meta.status !== 'open') throw new Error(`draft ${draftId} is ${meta.status}`);
      if (meta.kind === 'change' && deps.changes?.regulated(meta.workflowId)) throw regulatedRefusal(meta.workflowId);
      const diff = await diffDraft(root, draftId).catch(() => undefined);
      const said = edits.filter((e) => e.status !== 'discarded').map((e) => e.summary).filter(Boolean);
      // The reviewer reads this on the review card: steps by their titles, no ids.
      const named = diff?.structure
        ? namesInWords((await loadDraft(root, draftId).catch(() => undefined))?.workflow, meta.kind === 'change' ? await liveWorkflow(meta.workflowId) : undefined)
        : undefined;
      const summary = (diff?.structure ? describeStructuralDiff(diff.structure, named ? { name: named } : {}) : said).join(' ') || meta.title;
      const runId = newRunId();
      await updateDraftMeta(root, draftId, { runId });
      const started = await deps.startRun({
        workflowId: CHANGE_PLAYBOOK, runId, startAt: 'check', by: by.personId,
        case: { playbook: meta.workflowId, title: meta.title, draft: draftId, summary },
      });
      emit(draftId);
      return started;
    },

    async exampleFromCase(input, by) {
      // An example replays the whole case (its values, tool results and model turns) into a file
      // anyone building playbooks can read: only someone who may see every field of it may save it.
      const { rows: runRows } = await deps.pool.query(
        `select r.workflow_id, c.values from mw.runs r join mw.cases c on c.id = r.case_id where r.case_id = $1 order by r.created_at limit 1`, [input.caseId]);
      const caseWorkflow = runRows[0] ? await liveWorkflow(runRows[0].workflow_id as string) : undefined;
      const fields = caseWorkflow?.caseType.fields ?? {};
      const hidden = Object.keys((runRows[0]?.values ?? {}) as Record<string, unknown>).filter((k) => !maySee(by, fields[k]));
      if (hidden.length) throw new Error(`This case has fields you can't see (${hidden.join(', ')}), so only someone who can see them can save it as an example`);
      const example = await deps.caseToExample(input.caseId, { ...(input.name ? { name: input.name } : {}), ...(input.correction ? { correction: input.correction } : {}) });
      const workflowId = runRows[0]?.workflow_id as string;
      let draftId = input.draftId;
      if (draftId) {
        const { meta } = await requireDraft(draftId);
        if (meta.workflowId !== workflowId) throw new Error(`draft ${draftId} changes ${meta.workflowId}, but case ${input.caseId} is a ${workflowId} case`);
      } else {
        // Named after the example (the name the person gave, or a short one), not the raw case id: the title is shown in the app.
        const meta = await createDraft(root, { workflowId, title: `Example case “${example.name}”`, kind: 'change', createdBy: byLabel(by) });
        draftId = meta.id;
      }
      // The file is named for the example, as a slug unique in the folder; the name as typed stays inside it.
      const { meta: target } = await requireDraft(draftId);
      const examplesDir = join(draftDir(root, draftId), draftPlaybookFolder(target), 'examples');
      const base = exampleFileSlug(example.name) || exampleFileSlug(exampleNameFor(input.caseId));
      let file = base;
      for (let n = 2; existsSync(join(examplesDir, `${file}.yaml`)) || existsSync(join(examplesDir, `${file}.yml`)); n++) file = `${base}-${n}`;
      const path = `${draftPlaybookFolder(target)}/examples/${file}.yaml`;
      const { file: _file, ...doc } = example;
      await writeDraftFiles(root, draftId, [{ path, content: exampleToYaml(doc) }], {
        by: byLabel(by), via: 'editor', summary: input.correction ? `Example case ${example.name} from a correction` : `Example case ${example.name} from a past case`,
      });
      emit(draftId);
      return { draftId, path, example: { ...example, file: path } };
    },
  };
  return authoring;
}
