/**
 * Line diffs of files and structural diffs of playbooks (Phase 3): what a draft changes, for the
 * review screen, the map's "proposed change" mode and `memwise diff`.
 */
import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Change, DiffHunk, DiffLine, StepPart, StructuralDiff } from './draft-types.ts';
import type { PolicyDoc, StepDef, WorkflowDef } from './types.ts';

/** Lines of a text; a final newline doesn't make an empty last line. */
export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Past this many cells the LCS table is too big; the files are shown as replaced whole. */
const MAX_CELLS = 16_000_000;

/** The edit script from `a` to `b` (LCS over lines, after trimming the common head and tail). */
function editScript(a: string[], b: string[]): DiffLine[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const out: DiffLine[] = a.slice(0, head).map((text) => ({ kind: 'same', text }));
  const n = x.length;
  const m = y.length;
  if (n * m > MAX_CELLS) {
    out.push(...x.map((text): DiffLine => ({ kind: 'removed', text })), ...y.map((text): DiffLine => ({ kind: 'added', text })));
  } else {
    // lcs[i][j] = length of the LCS of x[i..] and y[j..]
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && x[i] === y[j]) { out.push({ kind: 'same', text: x[i]! }); i++; j++; }
      // Removals before additions, so a changed line reads "- old / + new".
      else if (j >= m || (i < n && lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) { out.push({ kind: 'removed', text: x[i]! }); i++; }
      else { out.push({ kind: 'added', text: y[j]! }); j++; }
    }
  }
  out.push(...a.slice(a.length - tail).map((text): DiffLine => ({ kind: 'same', text })));
  return out;
}

/**
 * A line diff of two texts as unified-diff hunks with `context` unchanged lines around each
 * change; changes closer than twice the context share a hunk. Starts are 1-based (for an empty
 * side, the line before, as in `diff -u`).
 */
export function lineDiff(a: string, b: string, context = 3): DiffHunk[] {
  const script = editScript(splitLines(a), splitLines(b));
  const changed = script.map((l, i) => (l.kind === 'same' ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return [];

  // Group change indexes into ranges of the script, each padded by the context.
  const ranges: [number, number][] = [];
  for (const i of changed) {
    const from = Math.max(0, i - context);
    const to = Math.min(script.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }

  // Old and new line numbers before each script index.
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let o = 0;
  let nw = 0;
  for (const l of script) {
    oldBefore.push(o);
    newBefore.push(nw);
    if (l.kind !== 'added') o++;
    if (l.kind !== 'removed') nw++;
  }
  return ranges.map(([from, to]) => {
    const lines = script.slice(from, to + 1);
    const oldLines = lines.filter((l) => l.kind !== 'added').length;
    const newLines = lines.filter((l) => l.kind !== 'removed').length;
    return {
      oldStart: oldBefore[from]! + (oldLines ? 1 : 0),
      oldLines,
      newStart: newBefore[from]! + (newLines ? 1 : 0),
      newLines,
      lines,
    };
  });
}

// ---------------------------------------------------------------- structural diff

const withoutFile = (policy: PolicyDoc | undefined) => {
  if (!policy) return undefined;
  const { file: _file, ...rest } = policy;
  return rest;
};

/** The parts of a step that differ between two versions of it. */
export function stepParts(a: StepDef, b: StepDef): StepPart[] {
  const parts: StepPart[] = [];
  const differ = (x: unknown, y: unknown) => !isDeepStrictEqual(x ?? null, y ?? null);
  if (a.title !== b.title) parts.push('title');
  if (a.performer !== b.performer) parts.push('performer');
  if ((a.engine ?? 'step') !== (b.engine ?? 'step')) parts.push('engine');
  if (a.strictness !== b.strictness) parts.push('strictness');
  if (a.assignee !== b.assignee) parts.push('assignee');
  if (a.instructions !== b.instructions) parts.push('instructions');
  if (differ(a.reads, b.reads)) parts.push('reads');
  if (differ(a.writes, b.writes)) parts.push('writes');
  if (differ(a.tools, b.tools)) parts.push('tools');
  if (a.model !== b.model) parts.push('model');
  if (differ(a.budget, b.budget)) parts.push('budget');
  if (differ(a.checkpoint, b.checkpoint)) parts.push('checkpoint');
  if (differ(a.outcomes, b.outcomes)) parts.push('outcomes');
  if (differ(a.map, b.map)) parts.push('map');
  if (differ(a.outcomeFrom, b.outcomeFrom)) parts.push('outcomeFrom');
  if (differ(withoutFile(a.policy), withoutFile(b.policy))) parts.push('policy');
  return parts;
}

/** Every tool a playbook uses: allowed, required, written from, mapped or taken an outcome from. */
function toolsUsed(w: WorkflowDef | undefined): Set<string> {
  const out = new Set<string>();
  for (const step of Object.values(w?.steps ?? {})) {
    for (const t of [...step.tools.allowed, ...step.tools.required, ...Object.keys(step.map ?? {})]) out.add(t);
    for (const write of Object.values(step.writes)) if (write.from.kind === 'tool') out.add(write.from.tool);
    if (step.outcomeFrom) out.add(step.outcomeFrom.tool);
  }
  return out;
}

const transitionsOf = (w: WorkflowDef | undefined) => {
  const out = new Map<string, { from: string; event: string; to: string }>();
  for (const [name, state] of Object.entries(w?.states ?? {})) {
    for (const [event, to] of Object.entries(state.on)) out.set(`${name}\0${event}\0${to}`, { from: name, event, to });
    const t = state.wait?.timeout;
    if (t) out.set(`${name}\0timeout\0${t.target}`, { from: name, event: 'timeout', to: t.target });
  }
  return out;
};

const added = <T>(a: Iterable<T>, b: Iterable<T>) => { const s = new Set(a); return [...b].filter((x) => !s.has(x)); };
const sorted = (xs: string[]) => [...xs].sort();

/**
 * What changes from `before` (the live playbook, absent for a new one) to `after` (the draft's):
 * states, transitions, steps and their parts, case fields, tools, required tools, roles (when
 * given, as role ids before and after), example cases, version and the playbook's own fields.
 */
export function structuralDiff(before: WorkflowDef | undefined, after: WorkflowDef, roles?: { before?: string[]; after?: string[] }): StructuralDiff {
  const beforeStates = before?.states ?? {};
  const stepOf = (w: WorkflowDef | undefined, state: string) => {
    const s = w?.states[state];
    return s?.step ? w!.steps[s.step] : undefined;
  };

  const steps: StructuralDiff['steps'] = {};
  for (const name of new Set([...Object.keys(beforeStates), ...Object.keys(after.states)])) {
    const a = stepOf(before, name);
    const b = stepOf(after, name);
    if (a && b) {
      const parts = stepParts(a, b);
      if (parts.length) steps[name] = { change: 'changed', parts };
    } else if (a || b) steps[name] = { change: a ? 'removed' : 'added', parts: [] };
  }

  const states: Record<string, Change> = {};
  for (const name of new Set([...Object.keys(beforeStates), ...Object.keys(after.states)])) {
    const a = beforeStates[name];
    const b = after.states[name];
    if (!a) states[name] = 'added';
    else if (!b) states[name] = 'removed';
    else if (!isDeepStrictEqual(a.on, b.on) || !isDeepStrictEqual(a.wait ?? null, b.wait ?? null) || a.assignee !== b.assignee || steps[name]) states[name] = 'changed';
  }

  const tBefore = transitionsOf(before);
  const tAfter = transitionsOf(after);
  const transitions: StructuralDiff['transitions'] = [
    ...added(tAfter.keys(), tBefore.keys()).map((k) => ({ ...tBefore.get(k)!, change: 'removed' as const })),
    ...added(tBefore.keys(), tAfter.keys()).map((k) => ({ ...tAfter.get(k)!, change: 'added' as const })),
  ];

  const fieldsBefore = before?.caseType.fields ?? {};
  const fieldsAfter = after.caseType.fields;
  const fieldKey = (f: { typeSource: string; required?: boolean; access?: string[] }) => ({ t: f.typeSource, r: !!f.required, a: f.access ?? null });
  const caseFields = {
    added: sorted(added(Object.keys(fieldsBefore), Object.keys(fieldsAfter))),
    removed: sorted(added(Object.keys(fieldsAfter), Object.keys(fieldsBefore))),
    changed: sorted(Object.keys(fieldsAfter).filter((k) => fieldsBefore[k] && !isDeepStrictEqual(fieldKey(fieldsBefore[k]!), fieldKey(fieldsAfter[k]!)))),
  };

  const usedBefore = toolsUsed(before);
  const usedAfter = toolsUsed(after);
  const tools = { added: sorted(added(usedBefore, usedAfter)), removed: sorted(added(usedAfter, usedBefore)) };

  const requiredTools: StructuralDiff['requiredTools'] = [];
  for (const name of new Set([...Object.keys(beforeStates), ...Object.keys(after.states)])) {
    const a = stepOf(before, name)?.tools.required ?? [];
    const b = stepOf(after, name)?.tools.required ?? [];
    for (const tool of added(a, b)) requiredTools.push({ step: name, tool, change: 'added' });
    for (const tool of added(b, a)) requiredTools.push({ step: name, tool, change: 'removed' });
  }

  // By the example's name (what people see), falling back to its file name.
  const examplesOf = (w: WorkflowDef | undefined) => new Map((w?.examples ?? []).map(({ file, ...rest }) => [rest.name || basename(file), rest] as const));
  const exBefore = examplesOf(before);
  const exAfter = examplesOf(after);
  const examples = {
    added: sorted(added(exBefore.keys(), exAfter.keys())),
    removed: sorted(added(exAfter.keys(), exBefore.keys())),
    changed: sorted([...exAfter.keys()].filter((k) => exBefore.has(k) && !isDeepStrictEqual(exBefore.get(k), exAfter.get(k)))),
  };

  const playbook: StructuralDiff['playbook'] = [];
  if (before) {
    if (before.title !== after.title) playbook.push('title');
    if (before.owner !== after.owner) playbook.push('owner');
    if (!isDeepStrictEqual(withoutFile(before.policy) ?? null, withoutFile(after.policy) ?? null)) playbook.push('policy');
    if (before.start !== after.start) playbook.push('start');
  }

  const rb = roles?.before ?? [];
  const ra = roles?.after ?? [];
  return {
    workflowId: after.id,
    states,
    transitions,
    steps,
    caseFields,
    tools,
    requiredTools,
    roles: { added: sorted(added(rb, ra)), removed: sorted(added(ra, rb)) },
    examples,
    version: { ...(before ? { from: before.version } : {}), to: after.version },
    playbook,
  };
}

/** The structural diff in plain sentences, for `memwise diff` and review cards. */
export function describeStructuralDiff(s: StructuralDiff): string[] {
  const out: string[] = [];
  const list = (xs: string[]) => xs.map((x) => `\`${x}\``).join(', ');
  if (s.version.from !== undefined && s.version.from !== s.version.to) out.push(`Version ${s.version.from} → ${s.version.to}.`);
  else if (s.version.from === undefined) out.push(`New playbook \`${s.workflowId}\`, version ${s.version.to ?? 1}.`);
  if (s.playbook.length) out.push(`Playbook ${s.playbook.join(', ')} changed.`);
  for (const change of ['added', 'removed'] as const) {
    const names = Object.entries(s.states).filter(([, c]) => c === change).map(([n]) => n);
    if (names.length) out.push(`${change === 'added' ? 'Added' : 'Removed'} state${names.length > 1 ? 's' : ''} ${list(names)}.`);
  }
  for (const [name, step] of Object.entries(s.steps)) {
    if (step.change === 'changed') out.push(`Step \`${name}\`: ${step.parts.join(', ')} changed.`);
  }
  for (const t of s.transitions) out.push(`${t.change === 'added' ? 'New' : 'Removed'} transition: \`${t.from}\` on ${t.event} → \`${t.to}\`.`);
  if (s.caseFields.added.length) out.push(`New case fields ${list(s.caseFields.added)}.`);
  if (s.caseFields.removed.length) out.push(`Removed case fields ${list(s.caseFields.removed)}.`);
  if (s.caseFields.changed.length) out.push(`Changed case fields ${list(s.caseFields.changed)}.`);
  if (s.tools.added.length) out.push(`Uses new tools ${list(s.tools.added)}.`);
  if (s.tools.removed.length) out.push(`No longer uses ${list(s.tools.removed)}.`);
  for (const r of s.requiredTools) out.push(`Step \`${r.step}\` ${r.change === 'added' ? 'must now call' : 'no longer must call'} \`${r.tool}\`.`);
  if (s.roles.added.length) out.push(`New roles ${list(s.roles.added)}.`);
  if (s.roles.removed.length) out.push(`Removed roles ${list(s.roles.removed)}.`);
  if (s.examples.added.length) out.push(`New example cases ${list(s.examples.added)}.`);
  if (s.examples.removed.length) out.push(`Removed example cases ${list(s.examples.removed)}.`);
  if (s.examples.changed.length) out.push(`Changed example cases ${list(s.examples.changed)}.`);
  return out;
}
