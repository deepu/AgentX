// Plugin layers (22 §3, D30): the workflow's own plugin and each plugin owning a tool the step
// uses, each followed by the binding's tightening; a binding that loosens its plugin is a violation.
import { describe, expect, test } from 'bun:test';
import type { StepDef, WorkflowDef } from '@memwise/defs';
import { compilePolicy, layersFor, pluginLayers, type PluginPolicy } from '../src/index.ts';

const wf = (origin?: WorkflowDef['origin']) => ({ id: 'wf', ...(origin ? { origin } : {}) }) as unknown as WorkflowDef;
const step = (allowed: string[], required: string[] = []) => ({ id: 'check', file: 'workflows/wf/steps/check.md', tools: { allowed, required } }) as unknown as StepDef;

const intake: PluginPolicy = {
  plugin: 'memwise/client-intake', tools: ['gst.validate_gstin', 'intake.extract_fields'],
  policy: { tools: { rules: { 'intake.extract_fields': { rateLimit: { count: 30, perMs: 60_000 } } } } }, source: 'plugins/memwise__client-intake/1.0.0/memwise-plugin.yaml',
  bindingPolicy: { effects: { outbound: 'approve' } }, bindingSource: 'domain/bindings/memwise__client-intake.yaml',
};
const email: PluginPolicy = { plugin: 'memwise/sample-email', tools: ['email.send'], bindingPolicy: { effects: { outbound: 'approve' } } };
const crm: PluginPolicy = { plugin: 'claude/sample-crm', tools: ['crm.list_contacts'], policy: { effects: { write: 'preview' } } };

describe('pluginLayers', () => {
  test('the origin plugin first, then plugins owning a tool the step uses, each with its binding', () => {
    const layers = pluginLayers([crm, email, intake], wf({ kind: 'plugin', plugin: 'memwise/client-intake', pluginVersion: '1.0.0' }), step(['email.send'], ['gst.validate_gstin']));
    expect(layers.map((l) => [l.kind, l.name, l.source])).toEqual([
      ['plugin', 'memwise/client-intake', 'plugins/memwise__client-intake/1.0.0/memwise-plugin.yaml'],
      ['plugin', 'memwise/client-intake binding', 'domain/bindings/memwise__client-intake.yaml'],
      ['plugin', 'memwise/sample-email binding', undefined],
    ]);
  });

  test('no plugin layers for a step that uses none of their tools; the workflow without a step gets its origin only', () => {
    expect(pluginLayers([crm, email, intake], wf(), step(['recall.step_record']))).toEqual([]);
    expect(pluginLayers({ [intake.plugin]: intake }, wf({ kind: 'plugin', plugin: intake.plugin, pluginVersion: '1.0.0' })).map((l) => l.name))
      .toEqual(['memwise/client-intake', 'memwise/client-intake binding']);
    expect(pluginLayers(undefined, wf(), step(['email.send']))).toEqual([]);
  });

  test('stacked between platform and domain; a binding that loosens its plugin is a violation', () => {
    const plugins = pluginLayers([crm], wf(), step(['crm.list_contacts']));
    const ok = compilePolicy(layersFor({ plugins, workflow: wf(), step: step(['crm.list_contacts']) }));
    expect(ok.violations).toEqual([]);
    expect(ok.effective.effects.write.value).toBe('preview');
    expect(ok.effective.effects.write.origin).toMatchObject({ layer: 'plugin', name: 'claude/sample-crm' });

    const loose = pluginLayers([{ ...crm, bindingPolicy: { effects: { write: 'allow' } }, bindingSource: 'domain/bindings/claude__sample-crm.yaml' }], wf(), step(['crm.list_contacts']));
    const bad = compilePolicy(layersFor({ plugins: loose, workflow: wf(), step: step(['crm.list_contacts']) }));
    expect(bad.violations.length).toBeGreaterThan(0);
    expect(bad.violations[0]).toMatchObject({ name: 'claude/sample-crm binding' });
  });
});
