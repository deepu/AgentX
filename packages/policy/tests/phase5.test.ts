/** Phase 5 (23 §5): a form's extraction tool must be a `read` tool its step's policy allows. */
import { expect, test } from 'bun:test';
import type { StepDef } from '@memwise/defs';
import { compilePolicy, extractDiagnostics, extractToolRefusal, layersFor } from '../src/index.ts';
import { intakeDomainPolicy, intakeWorkflow, makeStep } from './fixtures.ts';

const fill: StepDef = makeStep({
  id: 'fill',
  title: 'Client fills in the intake form',
  performer: 'external',
  extract: { tool: 'intake.extract_fields', documents: 'documents', fields: { pan: 'pan' }, minConfidence: 0.8 },
});
const effectiveFor = (step: StepDef, domainPolicy = intakeDomainPolicy) =>
  compilePolicy(layersFor({ domainPolicy, workflow: intakeWorkflow, step })).effective;

test('the extract tool is in the step\'s allowed tools, so a form step with no tools may still run it', () => {
  const effective = effectiveFor(fill);
  expect(effective.tools.allowed?.value).toContain('intake.extract_fields');
  expect(extractToolRefusal(effective, 'intake.extract_fields', { effect: 'read' })).toBeUndefined();
});

test('refused when the tool is not bound, not read, or denied above the step', () => {
  const effective = effectiveFor(fill);
  expect(extractToolRefusal(effective, 'intake.extract_fields', undefined)).toContain('is not bound');
  expect(extractToolRefusal(effective, 'intake.extract_fields', { effect: 'outbound' })).toContain('is outbound; a form may only run a read tool');
  expect(extractToolRefusal(effective, 'intake.extract_fields', {})).toContain('unclassified');
  const denied = effectiveFor(fill, { ...intakeDomainPolicy, tools: { deny: ['intake.extract_fields'] } });
  expect(extractToolRefusal(denied, 'intake.extract_fields', { effect: 'read' })).toContain('may not run from a form');
  expect(extractDiagnostics(fill, denied, { 'intake.extract_fields': { effect: 'read' } }))
    .toEqual([expect.objectContaining({ severity: 'error', code: 'extract-tool-not-read', path: 'extract.tool' })]);
  // The class itself is the definitions check's (extract-tool-not-read there); a step without extract has nothing to say.
  expect(extractDiagnostics(fill, denied, { 'intake.extract_fields': { effect: 'outbound' } })).toEqual([]);
  expect(extractDiagnostics(undefined, denied, {})).toEqual([]);
});
