// Phase 6 (docs/memwise/24-phase-6-interfaces.md §2): the workspace layer, between plugins and
// the domain, tighten only like every other layer.
import { expect, test } from 'bun:test';
import { compilePolicy, layersFor } from '../src/index.ts';
import { layer, makeStep, makeWorkflow } from './fixtures.ts';

test('layersFor puts the workspace house rules between plugins and the domain', () => {
  const plugin = layer('plugin', 'gst', { tools: { rules: { x: { treatment: 'preview' } } } });
  const layers = layersFor({
    workspacePolicy: { effects: { irreversible: 'deny' }, file: 'workspace.yaml' },
    domainPolicy: { file: 'domains/etmf/policy.yaml', name: 'etmf' },
    plugins: [plugin], workflow: makeWorkflow(), step: makeStep(),
  });
  expect(layers.map((l) => [l.kind, l.name, l.source])).toEqual([
    ['platform', 'platform', undefined],
    ['plugin', 'gst', undefined],
    ['workspace', 'workspace', 'workspace.yaml'],
    ['domain', 'etmf', 'domains/etmf/policy.yaml'],
    ['step', 'wf/check', 'workflows/wf/steps/check.md'],
  ]);
  const { effective, violations } = compilePolicy(layers);
  expect(violations).toEqual([]);
  expect(effective.effects.irreversible).toEqual({ value: 'deny', origin: { layer: 'workspace', name: 'workspace', source: 'workspace.yaml' } });
});

test('a domain may not loosen the workspace house rules', () => {
  const { effective, violations } = compilePolicy(layersFor({
    workspacePolicy: { effects: { outbound: 'deny' }, file: 'workspace.yaml' },
    domainPolicy: { effects: { outbound: 'allow' }, file: 'domains/etmf/policy.yaml' },
    workflow: makeWorkflow(),
  }));
  expect(effective.effects.outbound.value).toBe('deny');
  expect(violations).toHaveLength(1);
  expect(violations[0]).toMatchObject({ layer: 'domain', source: 'domains/etmf/policy.yaml' });
});
