import { describe, expect, test } from 'bun:test';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import {
  assembleContext, findInResults, finishToolParameters, parseVerdict, structuralChecks, verifierRequest, type Evidence,
} from '../src/index.ts';
import { FakeTools, example, intakeTools, stepInput } from './helpers.ts';

const clean = example('clean-application');
const tools = new FakeTools(intakeTools(clean));

describe('assembleContext', () => {
  test('is deterministic, ordered, and records what was pushed', () => {
    const input = stepInput('ctx', clean);
    const a = assembleContext(input, { tools });
    const b = assembleContext(structuredClone(input), { tools });
    expect(a).toEqual(b);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    // Recall tools are not bound here, so they are left out; step.finish always comes last.
    expect(a.tools.map((t) => t.tool)).toEqual(['email.send', 'gst.validate_gstin', 'intake.extract_fields', 'step.finish']);
    expect(Object.keys(a.pushed)).toEqual(['client_name', 'client_email', 'pan', 'gstin', 'annual_turnover', 'documents']);
    expect(a.modelRole).toBe('checker');
    expect(a.systemPrompt).toContain('This step is guided');
    expect(a.systemPrompt).toContain('- pan (input): "AAACA1234A"');
    expect(a.systemPrompt).toContain('You must call these successfully before you finish: gst.validate_gstin.');
    expect(a.systemPrompt).toContain('1. every flag names the document it came from');
    expect(a.systemPrompt).toContain('Compare what the client typed');
  });

  test('strictness, prior attempts and instructions change the prompt and the hash', () => {
    const base = assembleContext(stepInput('ctx', clean), { tools });
    const strictInput = stepInput('ctx', clean, (s) => ({ ...s, strictness: 'strict' }));
    strictInput.priorAttempts = [{ attempt: 1, outcome: 'needs_person', reason: 'the checkpoint failed' }];
    const strict = assembleContext(strictInput, { tools });
    expect(strict.systemPrompt).toContain('This step is strict: do exactly what the instructions say');
    expect(strict.systemPrompt).toContain('- Attempt 1 ended with needs_person: the checkpoint failed');
    expect(strict.hash).not.toBe(base.hash);
  });

  test('step.finish parameters come from the writes and outcomes', () => {
    const input = stepInput('ctx', clean);
    const params = finishToolParameters(input.step, input.recordTypes) as any;
    expect(params.properties.outcome.enum).toEqual(['checked', 'needs_info', 'failed']);
    expect(Object.keys(params.properties.writes.properties)).toEqual(['flags', 'gstin_ok', 'legal_name']);
    expect(params.properties.writes.properties.gstin_ok.description).toBe('Boolean; must equal `valid` of a result of gst.validate_gstin');
    expect(params.properties.writes.properties.flags.type).toBe('array');
    expect(params.required).toEqual(['outcome', 'writes', 'rationale']);
  });
});

describe('checkpoint', () => {
  const evidence: Evidence[] = [
    { tool: 'gst.validate_gstin', callId: 'c1', args: {}, result: { valid: false, legal_name: 'Old Name' } },
    { tool: 'gst.validate_gstin', callId: 'c2', args: {}, result: '{"valid": true, "legal_name": "Acme", "address": {"city": "Pune"}}' },
    { tool: 'intake.extract_fields', callId: 'c3', args: {}, result: { fields: [{ name: 'pan', value: 'AAACA1234A' }] } },
  ];

  test('findInResults: any depth, inside JSON text, at a field path, latest call first', () => {
    expect(findInResults(evidence, 'gst.validate_gstin', 'Pune')?.callId).toBe('c2');
    expect(findInResults(evidence, 'gst.validate_gstin', { city: 'Pune' })?.callId).toBe('c2');
    expect(findInResults(evidence, 'gst.validate_gstin', 'Old Name')?.callId).toBe('c1');
    expect(findInResults(evidence, 'gst.validate_gstin', true, 'valid')?.callId).toBe('c2');
    expect(findInResults(evidence, 'gst.validate_gstin', 'Pune', 'legal_name')).toBeUndefined();
    expect(findInResults(evidence, 'intake.extract_fields', 'AAACA1234A', 'fields.0.value')?.callId).toBe('c3');
    expect(findInResults(evidence, 'intake.extract_fields', 'Acme')).toBeUndefined();
  });

  test('findInResults: a boolean or number without a field matches only the whole result or the key named like the write', () => {
    // Any nested `true` would do otherwise: `valid` is not `gstin_ok`.
    expect(findInResults(evidence, 'gst.validate_gstin', true)).toBeUndefined();
    expect(findInResults(evidence, 'gst.validate_gstin', true, undefined, 'gstin_ok')).toBeUndefined();
    expect(findInResults(evidence, 'gst.validate_gstin', true, undefined, 'valid')?.callId).toBe('c2');
    expect(findInResults(evidence, 'gst.validate_gstin', false, undefined, 'valid')?.callId).toBe('c1');
    const scalar: Evidence[] = [{ tool: 'risk.score', callId: 's1', args: {}, result: 7 }, { tool: 'risk.score', callId: 's2', args: {}, result: { nested: { score: 9 } } }];
    expect(findInResults(scalar, 'risk.score', 7)?.callId).toBe('s1');
    expect(findInResults(scalar, 'risk.score', 9, undefined, 'score')).toBeUndefined();
    expect(findInResults(scalar, 'risk.score', 9, 'nested.score')?.callId).toBe('s2');
  });

  test('structural checks: undeclared and person writes, types, required, provenance', () => {
    const input = stepInput('chk', clean, (s) => ({
      ...s,
      writes: { ...s.writes, flags: { ...s.writes.flags!, required: true }, status: { field: 'status', type: { kind: 'scalar', name: 'Text' }, typeSource: 'Text', from: { kind: 'person' } } },
    }));
    const res = structuralChecks(input, { outcome: 'done', writes: { gstin_ok: 'yes', legal_name: 'Acme', extra: 1, status: 'x' } }, evidence, ['gst.validate_gstin'], 'T');
    const failed = Object.fromEntries(res.checks.filter((c) => !c.passed).map((c) => [c.rule, c.reason]));
    expect(res.passed).toBe(false);
    expect(Object.keys(failed).sort()).toEqual([
      'outcome is declared', 'writes.extra: declared', 'writes.flags: required', 'writes.gstin_ok: Boolean',
      'writes.gstin_ok: from tool gst.validate_gstin (valid)', 'writes.status: declared',
    ]);
    expect(failed['writes.status: declared']).toContain('entered by a person');
    // Without `field`, a boolean must sit at the key named like the write: `valid` is not `gstin_ok`.
    const anywhere = stepInput('chk-any', clean, (s) => ({ ...s, writes: { ...s.writes, gstin_ok: { ...s.writes.gstin_ok!, from: { kind: 'tool', tool: 'gst.validate_gstin' } } } }));
    const scalar = structuralChecks(anywhere, { outcome: 'checked', writes: { gstin_ok: true, legal_name: 'Acme' } }, evidence, [], 'T');
    expect(scalar.checks.find((c) => c.rule === 'writes.gstin_ok: from tool gst.validate_gstin')).toMatchObject({
      passed: false, reason: expect.stringContaining('as its whole result or its `gstin_ok` field'),
    });
    expect(res.writes.legal_name).toEqual({ value: 'Acme', provenance: { kind: 'tool', at: 'T', stepRunId: input.stepRunId, tool: 'gst.validate_gstin', callId: 'c2' } });
  });

  test('the verifier gets numbered rules and evidence; its verdict maps back to the rules', () => {
    const rules = ['every flag names a document', 'the legal name is not empty'];
    const req = verifierRequest(rules, { outcome: 'checked', writes: { flags: [] }, rationale: 'ok' }, evidence, 5);
    const text = req.messages[0]!.content as string;
    expect(text).toContain('1. every flag names a document\n2. the legal name is not empty');
    expect(text).toContain('gst.validate_gstin {} returned');
    expect(req.tools.map((t) => t.name)).toEqual(['checkpoint__verdict']);

    const reply = (content: AssistantMessage['content']) => ({ role: 'assistant', content } as AssistantMessage);
    const verdict = parseVerdict(reply([{ type: 'toolCall', id: 'v', name: 'checkpoint__verdict', arguments: { results: [{ rule: 2, passed: false, reason: 'empty' }, { rule: 1, passed: true }] } }]), rules);
    expect(verdict).toEqual([
      { rule: rules[0]!, kind: 'verifier', passed: true },
      { rule: rules[1]!, kind: 'verifier', passed: false, reason: 'empty' },
    ]);
    const partial = parseVerdict(reply([{ type: 'toolCall', id: 'v', name: 'checkpoint.verdict', arguments: { results: [{ rule: 1, passed: true }] } }]), rules);
    expect(partial[1]).toMatchObject({ passed: false, reason: 'the verifier gave no verdict for this rule' });
  });
});
