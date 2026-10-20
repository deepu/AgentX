/**
 * Context assembly (07 §3): what the agent is given, built once per step run and recorded.
 * Pure, and stable in its ordering, so the prompt prefix caches and a replay can be compared.
 */
import { createHash } from 'node:crypto';
import { valueTypeToJsonSchema, type AssembledContext, type CaseValue, type Provenance, type RecordTypeDef, type StepDef, type WriteDef } from '@memwise/defs';
import { modelToolName } from '@memwise/gateway';
import { FINISH_TOOL, type StepEngineDeps, type StepRunInput } from './types.ts';

const PREAMBLE = [
  'You are carrying out one step of a business workflow. A workflow engine runs you; no person reads this conversation while you work.',
  'Act only through the tools listed. Every tool call is checked against policy and recorded.',
  `When the step is done, call ${FINISH_TOOL} once with an outcome, the values to write to the case, and a short rationale.`,
].join('\n');

const STRICTNESS: Record<StepDef['strictness'], string> = {
  strict: 'This step is strict: do exactly what the instructions say, with only the listed tools, in the way they say. Do not improvise or add work.',
  guided: 'This step is guided: use your judgement to carry out the instructions, within the listed tools.',
  open: 'This step is open: investigate as needed within the listed tools.',
};

/** `case.pan` -> `pan`. */
export const caseField = (read: string) => (read.startsWith('case.') ? read.slice(5) : read);

/** Writes the agent makes; `from: person` writes are entered by a person, never by the agent. */
export const agentWrites = (step: StepDef): [string, WriteDef][] =>
  Object.entries(step.writes).filter(([, w]) => w.from.kind !== 'person').sort(([a], [b]) => a.localeCompare(b));

/** Every tool a step may call, in a fixed order: allowed plus required. */
export const stepTools = (step: StepDef): string[] => [...new Set([...step.tools.allowed, ...step.tools.required])].sort();

function provenanceLabel(p: Provenance): string {
  switch (p.kind) {
    case 'input': return 'input';
    case 'tool': return `tool ${p.tool}`;
    case 'judgement': return `judgement in ${p.stepRunId}`;
    case 'person': return `entered by ${p.by}`;
    case 'system': return 'system';
    case 'external': return `entered by ${p.by} through a link (untrusted)`;
  }
}

function writeSource(w: WriteDef): string {
  if (w.from.kind !== 'tool') return 'your judgement';
  return w.from.field ? `must equal \`${w.from.field}\` of a result of ${w.from.tool}` : `must equal a value returned by ${w.from.tool}`;
}

/** JSON Schema of `step.finish`, generated from the step's writes and outcomes. */
export function finishToolParameters(step: StepDef, recordTypes: Record<string, RecordTypeDef>): Record<string, unknown> {
  const writes = agentWrites(step);
  const properties: Record<string, unknown> = {};
  for (const [field, w] of writes) {
    properties[field] = { ...valueTypeToJsonSchema(w.type, recordTypes), description: `${w.typeSource}; ${writeSource(w)}` };
  }
  return {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: [...step.outcomes], description: 'How the step ended.' },
      writes: {
        type: 'object',
        properties,
        required: writes.filter(([, w]) => w.required).map(([f]) => f),
        additionalProperties: false,
        description: 'Values to write to the case.',
      },
      rationale: { type: 'string', description: 'One or two sentences on why, citing what you saw.' },
    },
    required: ['outcome', 'writes', 'rationale'],
    additionalProperties: false,
  };
}

export function requiredTools(input: StepRunInput): string[] {
  return [...new Set([...input.step.tools.required, ...input.policy.tools.required.map((r) => r.value)])].sort();
}

function systemPrompt(input: StepRunInput, pushed: Record<string, CaseValue>, offered: string[]): string {
  const { step } = input;
  const out: string[] = [PREAMBLE, '', `# Step: ${step.title}`, `Workflow ${input.workflow.id} v${input.workflow.version}, state ${step.id}.`, '', STRICTNESS[step.strictness]];
  out.push('', '## Instructions', '', step.instructions.trim());

  out.push('', '## The case', '');
  for (const read of step.reads) {
    const field = caseField(read);
    const v = pushed[field];
    out.push(v ? `- ${field} (${provenanceLabel(v.provenance)}): ${JSON.stringify(v.value)}` : `- ${field}: not set`);
  }

  if (input.priorAttempts.length) {
    out.push('', '## Earlier attempts at this step', '');
    for (const a of input.priorAttempts) out.push(`- Attempt ${a.attempt}${a.outcome ? ` ended with ${a.outcome}` : ' stopped'}: ${a.reason}`);
  }

  out.push('', '## Tools', '', offered.length ? `You may call: ${offered.join(', ')}.` : 'This step has no tools besides step.finish.');
  const required = requiredTools(input);
  if (required.length) out.push(`You must call these successfully before you finish: ${required.join(', ')}.`);

  out.push('', '## How to finish', '', `Call ${FINISH_TOOL} with:`, `- outcome: one of ${step.outcomes.join(', ')}`);
  const writes = agentWrites(step);
  if (writes.length) {
    out.push('- writes:');
    for (const [field, w] of writes) out.push(`  - ${field} (${w.typeSource}${w.required ? ', required' : ''}): ${writeSource(w)}`);
  } else {
    out.push('- writes: {} (this step writes nothing)');
  }
  out.push('- rationale: one or two sentences on why.');
  if (step.checkpoint.length) {
    out.push('', 'Before the outcome counts, your result is checked against these rules:');
    step.checkpoint.forEach((rule, i) => out.push(`${i + 1}. ${rule}`));
  }
  out.push('If a check fails you get the reasons back and can correct your result.');
  return out.join('\n');
}

export function assembleContext(input: StepRunInput, deps: Pick<StepEngineDeps, 'tools'>): AssembledContext {
  const { step } = input;
  const pushed: Record<string, CaseValue> = {};
  for (const read of step.reads) {
    const v = input.case.values[caseField(read)];
    if (v !== undefined) pushed[caseField(read)] = v;
  }

  const tools: AssembledContext['tools'] = [];
  for (const name of stepTools(step)) {
    const def = deps.tools.get(name);
    if (def) tools.push({ name: modelToolName(name), tool: name, description: def.description, parameters: def.inputSchema });
  }
  const offered = tools.map((t) => t.tool);
  tools.push({
    name: modelToolName(FINISH_TOOL),
    tool: FINISH_TOOL,
    description: 'Finish the step with an outcome, the values to write to the case, and a short rationale. The result is checked before it counts.',
    parameters: finishToolParameters(step, input.recordTypes),
  });

  const prompt = systemPrompt(input, pushed, offered);
  const hash = createHash('sha256').update(prompt).update(JSON.stringify(tools)).digest('hex');
  return { systemPrompt: prompt, tools, pushed, priorAttempts: input.priorAttempts, modelRole: step.model ?? 'default', hash };
}
