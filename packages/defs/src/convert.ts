/**
 * An old Conductor `task.yaml` (a DAG of session nodes) as a playbook folder (Phase 3, 20 §7),
 * for `memwise convert`. Reads the task with the `yaml` package only: defs doesn't depend on
 * @memwise/shared, which owns the task schema.
 */
import { parse, stringify } from 'yaml';
import { asString, asStrings, isRecord } from './source.ts';

export interface ConvertOptions {
  /** Role for approval steps and the playbook's owner; default the first of `roles`, else `staff`. */
  roles?: string[];
  /** Model role the agent steps name; default `worker`. */
  modelRole?: string;
}

interface TaskNode { id: string; title: string; prompt: string; kind: string; deps: string[]; approval: boolean }

const field = (id: string) => id.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1');
const resultField = (node: string) => `${field(node)}_result`;

function caseType(param: Record<string, unknown>): string {
  switch (param.type) {
    case 'number': return 'Number';
    case 'boolean': return 'Boolean';
    case 'enum': {
      const values = asStrings(param.enum);
      return values.length ? `Enum[${values.join(', ')}]` : 'Text';
    }
    default: return 'Text';
  }
}

/** `${params.x}` and `${nodes.a.output[.f]}` in a prompt, in the playbook's words. */
const rewritePrompt = (prompt: string) => prompt
  .replace(/\$\{params\.([A-Za-z_]\w*)\}/g, (_m, p: string) => `\`case.${field(p)}\``)
  .replace(/\$\{nodes\.([a-z0-9-]+)\.output(?:\.[\w.]+)?\}/g, (_m, n: string) => `\`case.${resultField(n)}\``);

/** Nodes in dependency order, keeping the file's order among nodes that are free to go next. */
function topoOrder(nodes: TaskNode[]): TaskNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    for (const d of n.deps) if (!byId.has(d)) throw new Error(`node \`${n.id}\` depends on \`${d}\`, which is not a node of the task`);
  }
  const done = new Set<string>();
  const out: TaskNode[] = [];
  while (out.length < nodes.length) {
    const next = nodes.find((n) => !done.has(n.id) && n.deps.every((d) => done.has(d)));
    if (!next) throw new Error(`the nodes ${nodes.filter((n) => !done.has(n.id)).map((n) => n.id).join(', ')} depend on each other in a loop`);
    done.add(next.id);
    out.push(next);
  }
  return out;
}

const frontMatter = (data: Record<string, unknown>, body: string) => `---\n${stringify(data, { lineWidth: 0 })}---\n${body.trim()}\n`;

/** The playbook folder's files, relative to the project (`workflows/<id>/...`), and the playbook id. */
export function convertTaskYaml(text: string, opts: ConvertOptions = {}): { workflowId: string; files: Record<string, string> } {
  const raw = parse(text) as unknown;
  if (!isRecord(raw)) throw new Error('task.yaml is not a map of keys (id, title, nodes ...)');
  const workflowId = asString(raw.id);
  if (!workflowId || !/^[a-z0-9][a-z0-9-]*$/.test(workflowId)) throw new Error('task.yaml needs an `id` (a lower-case slug), which becomes the playbook id');
  const title = asString(raw.title) ?? workflowId;
  const goal = asString(raw.goal);
  const role = opts.roles?.[0] ?? 'staff';
  const model = opts.modelRole ?? 'worker';

  const nodes: TaskNode[] = (Array.isArray(raw.nodes) ? raw.nodes : []).filter(isRecord).map((n, i) => {
    const id = asString(n.id);
    if (!id) throw new Error(`node ${i + 1} has no id`);
    return {
      id,
      title: asString(n.title) ?? id,
      prompt: asString(n.prompt) ?? '',
      kind: asString(n.kind) ?? asString(n.type) ?? 'session', // `type:` is the old alias of `kind:`
      deps: asStrings(n.depends_on),
      approval: n.approval === true,
    };
  });
  if (!nodes.length) throw new Error('task.yaml has no nodes');
  if (new Set(nodes.map((n) => n.id)).size !== nodes.length) throw new Error('two nodes of the task have the same id');
  const order = topoOrder(nodes);

  // A chain converts as it is; anything else (fan-out, fan-in) runs one node after another.
  const isChain = order.every((n, i) => (i === 0 ? n.deps.length === 0 : n.deps.length === 1 && n.deps[0] === order[i - 1]!.id));
  const notes: string[] = [];

  const params = (Array.isArray(raw.params) ? raw.params : []).filter(isRecord).filter((p) => typeof p.name === 'string');
  const fields: Record<string, string> = {};
  for (const p of params) fields[field(p.name as string)] = caseType(p);
  if (!params.length) fields.notes = 'Text';
  const inputs = Object.keys(fields);

  // Each node becomes a state; an approval node, or a node with `approval: true`, adds a person step after it.
  interface State { name: string; step: string; next?: string; backTo?: string }
  const states: State[] = [];
  const dir = `workflows/${workflowId}`;
  const files: Record<string, string> = {};
  const worked = (ids: string[]) => ids.filter((d) => nodes.find((x) => x.id === d)?.kind !== 'approval').map(resultField);
  for (const n of order) {
    if (n.kind === 'approval') {
      states.push({ name: n.id, step: approvalStep(n.title, n.prompt || `Look at the work so far and approve it, or send it back.`, worked(n.deps), role), backTo: n.deps[0] });
      continue;
    }
    if (n.kind !== 'session' && n.kind !== 'orchestrator') notes.push(`node \`${n.id}\` (kind ${n.kind}) became an agent step; check its instructions`);
    fields[resultField(n.id)] = 'Text';
    const reads = [...inputs, ...worked(n.deps)].map((f) => `case.${f}`);
    files[`${dir}/steps/${n.id}.md`] = frontMatter({
      title: n.title,
      performer: 'agent',
      strictness: 'guided',
      reads,
      writes: { [resultField(n.id)]: 'Text' },
      model,
      outcomes: ['done'],
    }, `${rewritePrompt(n.prompt || n.title)}\n\nWrite what you produce to \`${resultField(n.id)}\`.`);
    states.push({ name: n.id, step: '' });
    if (n.approval) {
      const name = `${n.id}_approval`;
      states.push({ name, step: approvalStep(`Approve: ${n.title}`, `Check the result of ${n.title} and approve it, or send it back to be done again.`, [resultField(n.id)], role), backTo: n.id });
    }
  }
  for (const s of states) if (s.step) files[`${dir}/steps/${s.name}.md`] = s.step;

  const steps: Record<string, unknown> = {};
  states.forEach((s, i) => {
    const next = states[i + 1]?.name ?? 'end';
    if (s.step) {
      steps[s.name] = { on: { approved: next, ...(s.backTo ? { sent_back: s.backTo } : {}) } };
    } else steps[s.name] = { on: { done: next } };
  });
  // Steps sent back to with no earlier node have nowhere to go back to: send them to the start.
  for (const s of states) {
    const on = (steps[s.name] as { on: Record<string, string> }).on;
    if (s.step && !s.backTo) on.sent_back = states[0]!.name;
  }

  const header = [
    `# Converted from the task \`${workflowId}\`${goal ? `: ${goal.split('\n')[0]}` : ''}`,
    ...(isChain ? [] : [
      '# The task was not a simple chain, so its nodes run one after another in dependency order:',
      ...order.filter((n) => n.deps.length).map((n) => `#   ${n.id} came after ${n.deps.join(', ')}`),
    ]),
    ...notes.map((n) => `# Note: ${n}`),
  ].join('\n');
  files[`${dir}/workflow.yaml`] = `${header}\n${stringify({ workflow: workflowId, version: 1, title, owner: role, start: states[0]!.name, steps }, { lineWidth: 0 })}`;
  files[`${dir}/case.yaml`] = stringify({ case: field(workflowId), fields }, { lineWidth: 0 });
  return { workflowId, files };
}

function approvalStep(title: string, body: string, reads: string[], role: string): string {
  return frontMatter({
    title,
    performer: 'person',
    assignee: role,
    reads: reads.map((f) => `case.${f}`),
    outcomes: ['approved', 'sent_back'],
  }, body);
}
