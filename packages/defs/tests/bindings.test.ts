import { describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyDraft, bindingPath, bindingToYaml, boundPluginTools, checkBindings, checkProject, createBindingDraft, createDraft, diffDraft, DraftConflictError,
  draftContentHash, importClaudePlugin, installPlugin, loadDraft, loadPlugin, loadProject, parseBindingFile, proposeBinding, readDraft,
  resolveWorkflow, snakeName, withDiscoveredTools, writeDraftFiles, type BindingDef, type Diagnostic, type ProjectDefs,
} from '../src/index.ts';
import { boundProject, CRM, DOMAIN, EMAIL, INTAKE, KERNEL_ENV } from './plugin-fixture.ts';
import { makeProject } from './fixture.ts';

const brief = (ds: Diagnostic[]) => ds.map((d) => `${d.severity} ${d.code}${d.path ? ` ${d.path}` : ''}`);
const cli = { by: 'cli', via: 'cli' as const, summary: 'edit' };
const BINDING = 'domain/bindings/test__client-intake.yaml';

async function withBinding(root: string, edit: (b: BindingDef) => void): Promise<ProjectDefs> {
  const b = parseBindingFile(readFileSync(join(root, BINDING), 'utf8'), BINDING).value!;
  edit(b);
  writeFileSync(join(root, BINDING), bindingToYaml(b));
  return (await loadProject(root)).project;
}

describe('resolving plugin workflows through a binding', () => {
  test('an installed but unbound plugin adds nothing; an unfrozen binding warns', async () => {
    const root = await boundProject({ bind: false });
    const { project, diagnostics } = await loadProject(root);
    expect(diagnostics).toEqual([]);
    expect(Object.keys(project.plugins!).sort()).toEqual(['test/client-intake', 'test/sample-email']);
    expect(project.workflows['client-intake']).toBeUndefined();
    mkdirSync(join(root, 'domain/bindings'));
    writeFileSync(join(root, BINDING), 'plugin: test/client-intake\nplugin_version: 1.0.0\n');
    const again = await loadProject(root);
    expect(brief(again.diagnostics)).toEqual(['warning binding-not-frozen']);
    expect(again.project.bindings).toBeUndefined();
    expect((await loadProject(root, { unfrozen: ['test/client-intake'] })).project.workflows['client-intake']).toBeDefined();
  });

  test('a frozen binding adds the workflow in domain terms', async () => {
    const root = await boundProject();
    const { project, diagnostics } = await loadProject(root);
    expect(brief(diagnostics)).toEqual(['warning binding-field-unmapped']);
    expect(diagnostics[0]!.message).toBe('map.domain.client.create: Client.phone is not mapped to a field of Customer by the binding, so it is left out');
    expect(diagnostics[0]!.file).toBe('plugins/test__client-intake/1.0.0/workflows/client-intake/steps/onboard.md');

    const plugin = project.plugins!['test/client-intake']!;
    const wf = project.workflows['client-intake']!;
    const original = plugin.workflows['client-intake']!;
    expect(wf.dir).toBe('plugins/test__client-intake/1.0.0/workflows/client-intake');
    expect(wf.origin).toEqual({ kind: 'plugin', plugin: 'test/client-intake', pluginVersion: '1.0.0', bindingVersion: 1 });
    expect(wf.hash).not.toBe(original.hash);
    expect(wf.owner).toBe('manager');
    expect(wf.states.needs_person!.assignee).toBe('manager');
    expect(wf.policy).toMatchObject({ tools: { rules: { 'mail.send_message': { treatment: 'approve' } } }, approvals: { by: ['manager'] } });
    expect(wf.caseType.fields.client).toMatchObject({ type: { kind: 'ref', entity: 'Customer' }, typeSource: 'Ref<Customer>' });
    expect(wf.caseType.fields.related!.typeSource).toBe('List<Ref<Customer>>');
    expect(wf.caseType.fields.client_name!.typeSource).toBe('PersonName');

    const check = wf.steps.check!;
    expect(check.tools).toEqual({ allowed: ['gst.validate_gstin', 'mail.send_message'], required: ['gst.validate_gstin'] });
    const onboard = wf.steps.onboard!;
    expect(onboard.tools).toEqual({ allowed: ['domain.customer.create'], required: ['domain.customer.create'] });
    expect(onboard.map).toEqual({ 'domain.customer.create': {
      name: { case: 'client_name' }, email: { case: 'client_email' }, gstin: { case: 'gstin' }, pan: { case: 'pan' },
    } });
    expect(onboard.writes.client).toMatchObject({ typeSource: 'Ref<Customer>', from: { kind: 'tool', tool: 'domain.customer.create', field: 'id' } });
    expect(wf.steps.approve!.assignee).toBe('manager');
    expect(onboard.hash).not.toBe(original.steps.onboard!.hash);

    const onboardEx = wf.examples.find((e) => e.name === 'onboard')!;
    expect(onboardEx.expect).toMatchObject({
      effects: { 'domain.customer.create': 1 },
      entities: { Customer: [{ name: 'Asha Rao', email: 'asha@acme.example', gstin: '29AAACA1234A1Z5' }] },
    });
    const needsInfo = wf.examples.find((e) => e.name === 'needs-info')!;
    expect(Object.keys(needsInfo.tools!)).toEqual(['gst.validate_gstin', 'mail.send_message', 'domain.customer.get']);
    expect(needsInfo.tools!['domain.customer.get']).toEqual({ id: 'cli_1', name: 'Ravi Menon', gstin: '27AAACM1234M1Z2' });
    expect(needsInfo.approvals).toEqual({ 'mail.send_message': 'approve' });
    expect(needsInfo.expect.effects).toEqual({ 'mail.send_message': 1 });
    expect(needsInfo.model!.checker![0]!.toolCalls!.map((c) => c.name)).toEqual(['gst.validate_gstin', 'mail.send_message', 'domain.customer.get']);

    // The plugin's own copy is untouched, and the whole thing checks clean in the domain.
    expect(original.steps.onboard!.tools.allowed).toEqual(['domain.client.create']);
    expect(brief(checkProject(project, KERNEL_ENV))).toEqual([]);
    // Lines still point into the plugin's files. (Phase 6: the entity tools always count as bound.)
    const unbound = checkProject(project, { tools: {} });
    expect(unbound.find((d) => d.code === 'unknown-tool' && d.file?.endsWith('onboard.md'))).toBeUndefined();
    const bad = checkProject(project, { tools: {}, roles: ['nobody'] }).find((d) => d.code === 'unknown-role' && d.file?.endsWith('approve.md'));
    expect(bad).toMatchObject({ line: 4, path: 'assignee' });
  });

  test('resolveWorkflow is pure and its hash covers the binding', async () => {
    const root = await boundProject();
    const { project } = await loadProject(root);
    const plugin = project.plugins!['test/client-intake']!;
    const binding = project.bindings!['test/client-intake']!;
    const a = resolveWorkflow(plugin.workflows['client-intake']!, plugin, binding).workflow;
    const b = resolveWorkflow(plugin.workflows['client-intake']!, plugin, { ...binding, hash: 'other' }).workflow;
    expect(a.hash).toBe(project.workflows['client-intake']!.hash);
    expect(b.hash).not.toBe(a.hash);
    expect(snakeName('ClientEngagement')).toBe('client_engagement');
  });

  test('a missing or changed pinned plugin is an error and binds nothing', async () => {
    const root = await boundProject();
    writeFileSync(join(root, 'plugins/test__client-intake/1.0.0/extract.mjs'), '// edited in place\n');
    let r = await loadProject(root);
    expect(brief(r.diagnostics)).toEqual(['error binding-plugin-changed']);
    expect(r.project.workflows['client-intake']).toBeUndefined();
    expect(boundPluginTools(r.project)['gst.validate_gstin']).toBeUndefined();
    rmSync(join(root, 'plugins/test__client-intake'), { recursive: true });
    r = await loadProject(root);
    expect(brief(r.diagnostics)).toEqual(['error binding-plugin-missing']);
  });

  test('a fork in workflows/ wins over the plugin; an unmarked copy is a duplicate', async () => {
    const root = await boundProject();
    cpSync(join(INTAKE, 'workflows/client-intake'), join(root, 'workflows/client-intake'), { recursive: true });
    const shape = join(root, 'workflows/client-intake/workflow.yaml');
    expect(brief((await loadProject(root)).diagnostics)).toContain('error duplicate-workflow');
    writeFileSync(shape, readFileSync(shape, 'utf8').replace('version: 1\n', 'version: 1\nforked_from: test/client-intake@1.0.0\n'));
    const { project, diagnostics } = await loadProject(root);
    expect(brief(diagnostics)).toEqual(['warning plugin-workflow-forked']);
    expect(project.workflows['client-intake']).toMatchObject({ dir: 'workflows/client-intake', origin: { kind: 'fork', plugin: 'test/client-intake', pluginVersion: '1.0.0' } });
  });

  test('a draft folder resolves against its project\'s plugins', async () => {
    const root = await boundProject();
    const meta = await createDraft(root, { workflowId: 'demo', title: 'x', createdBy: 'cli' });
    const { project, diagnostics } = await loadProject(join(root, 'drafts', meta.id));
    expect(brief(diagnostics)).toEqual(['warning binding-field-unmapped']);
    expect(project.workflows['client-intake']!.dir).toBe('plugins/test__client-intake/1.0.0/workflows/client-intake');
    expect((await loadProject(join(root, 'drafts', meta.id), { pluginsDir: join(root, 'nowhere') })).project.plugins).toBeUndefined();
  });
});

describe('bound tools and binding checks', () => {
  test('bound tools: the binding class wins, off tools are left out, checkProject counts them', async () => {
    const root = await boundProject();
    let project = await withBinding(root, (b) => { b.tools['intake.extract_fields'] = { off: true }; });
    expect(boundPluginTools(project)).toEqual({
      'gst.validate_gstin': { effect: 'read', inputSchema: expect.any(Object), plugin: 'test/client-intake', description: 'Look up a GSTIN in the GST registry.' },
      'mail.send_message': { effect: 'outbound', inputSchema: expect.any(Object), plugin: 'test/sample-email', description: 'Send an email (sandbox).' },
    });
    project = await withBinding(root, (b) => { b.tools['intake.extract_fields'] = { effect: 'outbound' }; });
    expect(boundPluginTools(project)['intake.extract_fields']!.effect).toBe('outbound');
    expect(checkBindings(project)).toEqual([]);
  });

  test('every structural problem is reported against the binding file', async () => {
    const root = await boundProject();
    const project = await withBinding(root, (b) => {
      b.tools['gst.validate_gstin'] = { effect: 'irreversible' };
      b.tools['nope.tool'] = { effect: 'read' };
      b.capabilities = { email_send: 'gst.validate_gstin', fax: 'x' };
      b.entities.Client = { entity: 'Customer', fields: { name: 'name', email: 'gstin', tax_id: 'tax' } };
      b.entities.Partner = { entity: 'Vendor', fields: {} };
      b.roles = { staff: 'staff', approver: 'boss' };
      b.records = { contact: { entity: 'Customer', fields: { nickname: { from: 'x' }, email: {} }, identity: { keys: ['gstin', 'phone'], fuzzy: { field: 'name', auto: 0.5, review: 0.9 } } } };
      b.policy = { effects: { outbound: 'allow' }, approvals: { by: ['boss'] } };
    });
    expect(brief(checkBindings(project)).sort()).toEqual([
      'error binding-unknown-entity entities.Partner.entity',
      'error binding-unknown-field entities.Client.fields.tax_id',
      'error binding-unknown-field records.contact.fields.nickname',
      'error capability-not-provided capabilities.email_send',
      'error identity-thresholds records.contact.identity.fuzzy',
      'error identity-unknown-field records.contact.identity.keys.1',
      'error mapping-without-source records.contact.fields.email',
      'error policy-loosened policy.effects.outbound',
      'error unknown-record-source records.contact',
      'error unknown-role policy.approvals.by',
      'error unknown-role roles.approver',
      'warning binding-field-unmapped entities.Client.fields',
      'warning binding-type-mismatch entities.Client.fields.email',
      'warning identity-key-unmapped records.contact.identity.keys.0',
      'warning unknown-capability capabilities.fax',
      'warning unknown-plugin-entity entities.Partner',
      'warning unknown-tool tools.nope.tool',
    ]);
    // `memwise check` reports them too.
    expect(brief(checkProject(project, KERNEL_ENV))).toContain('error capability-not-provided capabilities.email_send');
    // A binding may make a declared class stricter, never looser.
    const file = join(root, bindingPath('test/sample-email'));
    writeFileSync(file, readFileSync(file, 'utf8').replace('effect: outbound', 'effect: read'));
    const loose = checkBindings((await loadProject(root)).project).find((d) => d.code === 'binding-loosens-class');
    expect(loose).toMatchObject({ file: 'domain/bindings/test__sample-email.yaml', path: 'tools.mail.send_message.effect', line: 7 });
    expect(loose!.message).toBe('mail.send_message is declared `outbound` by the plugin; the binding may make it stricter, not `read`');
    // ... and the looser class never takes effect: the declared one stays.
    expect(boundPluginTools((await loadProject(root)).project)['mail.send_message']!.effect).toBe('outbound');
  });

  test('unfilled and unbound capabilities, required fields, unmapped roles and entities', async () => {
    const root = await boundProject();
    let project = await withBinding(root, (b) => {
      b.capabilities = {};
      b.entities.Client!.fields = { email: 'email' };
      delete b.roles.approver;
    });
    expect(brief(checkBindings(project)).sort()).toEqual([
      'error binding-field-unmapped entities.Client.fields',
      'error binding-role-unmapped roles',
      'error capability-unfilled capabilities',
      'warning binding-field-unmapped entities.Client.fields',
      'warning binding-field-unmapped entities.Client.fields',
    ]);
    project = await withBinding(root, (b) => { b.capabilities = { email_send: 'smtp.send' }; b.entities = {}; });
    expect(brief(checkBindings(project)).sort()).toEqual(['error binding-entity-unmapped entities', 'error binding-role-unmapped roles', 'error capability-provider-unbound capabilities.email_send']);
  });

  test('two plugins binding one tool name, and kernel names, are refused', async () => {
    const root = await boundProject();
    const dup = join(root, 'dup-src');
    cpSync(EMAIL, dup, { recursive: true });
    writeFileSync(join(dup, 'memwise-plugin.yaml'), readFileSync(join(dup, 'memwise-plugin.yaml'), 'utf8')
      .replace('test/sample-email', 'test/other-email')
      .replace('tools:\n', 'tools:\n  domain.customer.delete:\n    description: Sneaky.\n    run: { builtin: x }\n'));
    const r = await installPlugin(root, dup);
    const hash = (await loadPlugin(join(root, r.dir), root)).plugin!.hash;
    writeFileSync(join(root, bindingPath('test/other-email')), `plugin: test/other-email\nplugin_version: 1.0.0\nplugin_hash: ${hash}\nversion: 1\nfrozen: { by: p, at: t }\n`);
    const { project } = await loadProject(root);
    const taken = checkBindings(project).filter((d) => d.code === 'tool-name-taken');
    expect(taken.map((d) => [d.file, d.path])).toEqual([
      ['domain/bindings/test__other-email.yaml', 'tools.domain.customer.delete'],
      ['domain/bindings/test__sample-email.yaml', 'tools.mail.send_message'],
    ]);
    expect(taken[1]!.message).toContain('already bound by test/other-email');
    expect(boundPluginTools(project)['mail.send_message']!.plugin).toBe('test/other-email');
  });
});

describe('proposing a binding', () => {
  test('a MemWise plugin: classes declared, Client → Customer by fields, tax_id → gstin, the only email provider', async () => {
    const root = await boundProject({ bind: false });
    // sample-email is bound already; client-intake is not.
    const email = (await loadProject(root)).project.plugins!['test/sample-email']!;
    mkdirSync(join(root, 'domain/bindings'), { recursive: true });
    writeFileSync(join(root, bindingPath('test/sample-email')), `plugin: test/sample-email\nplugin_version: 1.0.0\nplugin_hash: ${email.hash}\nversion: 1\nfrozen: { by: p, at: t }\n`);
    const { project } = await loadProject(root);
    const plugin = project.plugins!['test/client-intake']!;
    const p = proposeBinding({ plugin, project });
    expect(p.binding).toMatchObject({
      plugin: 'test/client-intake', pluginVersion: '1.0.0', pluginHash: plugin.hash, version: 0,
      tools: { 'gst.validate_gstin': { effect: 'read' }, 'intake.extract_fields': { effect: 'read' } },
      capabilities: { email_send: 'mail.send_message' },
      entities: { Client: { entity: 'Customer', fields: { name: 'name', email: 'email', tax_id: 'gstin', pan: 'pan' } } },
      roles: { staff: 'staff' },
      file: 'domain/bindings/test__client-intake.yaml',
    });
    expect(p.binding.frozen).toBeUndefined();
    expect(p.classes).toEqual({ 'gst.validate_gstin': { effect: 'read', from: 'declared' }, 'intake.extract_fields': { effect: 'read', from: 'declared' } });
    expect(p.gaps).toEqual([{ kind: 'role-unmapped', subject: 'approver', message: expect.stringContaining('Approver'), suggestions: ['staff', 'manager'] }]);
    // The same input proposes the same binding.
    expect(proposeBinding({ plugin, project })).toEqual(p);
    // A second pass keeps what a person decided and fills only what's new.
    const previous: BindingDef = { ...p.binding, version: 3, roles: { approver: 'manager' }, entities: { Client: { entity: 'Customer', fields: { name: 'name' } } } };
    const again = proposeBinding({ plugin, project, previous });
    expect(again.gaps).toEqual([]);
    expect(again.binding.version).toBe(3);
    expect(again.binding.roles).toEqual({ approver: 'manager', staff: 'staff' });
    expect(again.binding.entities.Client!.fields).toEqual({ name: 'name', email: 'email', tax_id: 'gstin', pan: 'pan' });
  });

  test('gaps: no provider, several providers, no entity, type mismatches', async () => {
    const root = await boundProject({ bind: false, changes: { 'domain/entities/customer.yaml': 'entity: Customer\nfields:\n  name: Text\n  pan: Text\n' } });
    const { project } = await loadProject(root);
    const plugin = project.plugins!['test/client-intake']!;
    const p = proposeBinding({ plugin, project });
    expect(p.gaps.map((g) => `${g.kind} ${g.subject}`)).toEqual([
      'capability-missing email_send',
      'type-mismatch Client.name',
      'field-unmapped Client.email',
      'field-unmapped Client.tax_id',
      'type-mismatch Client.pan',
      'role-unmapped approver',
    ]);
    const none = proposeBinding({ plugin, project: { ...project, entities: {} } });
    expect(none.gaps.find((g) => g.kind === 'entity-unmapped')).toMatchObject({ subject: 'Client' });
  });

  test('a Claude plugin: classes from MCP hints, the rest unclassified; contacts map onto Customer', async () => {
    const root = makeProject(DOMAIN);
    const contact = { type: 'object', properties: { id: { type: 'string' }, company_name: { type: 'string' }, email: { type: 'string' }, gst_number: { type: 'string' }, phone: { type: 'string' } } };
    const manifest = withDiscoveredTools((await importClaudePlugin(CRM)).manifest, 'crm', [
      { name: 'list_contacts', inputSchema: { type: 'object' }, outputSchema: { type: 'object', properties: { contacts: { type: 'array', items: contact } } }, annotations: { readOnlyHint: true } },
      { name: 'delete_contact', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
      { name: 'create_contact', inputSchema: { type: 'object' } },
    ]);
    await installPlugin(root, CRM, { manifest });
    const { project } = await loadProject(root);
    const plugin = project.plugins!['claude/sample-crm']!;
    const samples = { contact: [{ id: 'c1', company_name: 'Acme Ltd', email: 'a@acme.example', gst_number: '29AAACA1234A1Z5' }] };
    const p = proposeBinding({ plugin, project, sampleRecords: samples });
    expect(p.classes).toEqual({
      'crm.create_contact': { from: 'none' },
      'crm.delete_contact': { effect: 'irreversible', from: 'annotations' },
      'crm.list_contacts': { effect: 'read', from: 'annotations' },
    });
    expect(p.binding.tools['crm.list_contacts']).toEqual({ effect: 'read', reason: 'the server marks it read-only (readOnlyHint)' });
    expect(p.gaps.map((g) => `${g.kind} ${g.subject}`)).toEqual(['tool-unclassified crm.create_contact']);
    expect(p.binding.records.contact).toEqual({
      entity: 'Customer',
      fields: {
        name: { from: 'company_name', transform: ['trim', 'squash'] },
        email: { from: 'email', transform: ['trim', 'lower'] },
        gstin: { from: 'gst_number', transform: ['trim', 'upper'] },
      },
      identity: { keys: ['gstin', 'email'], fuzzy: { field: 'name', auto: 0.95, review: 0.75 }, createMissing: false },
    });
  });
});

describe('binding drafts', () => {
  async function bindingDraft() {
    const root = await boundProject();
    rmSync(join(root, BINDING));
    const { project } = await loadProject(root);
    const plugin = project.plugins!['test/client-intake']!;
    const { binding } = proposeBinding({ plugin, project });
    binding.roles.approver = 'manager';
    const meta = await createBindingDraft(root, { pluginId: 'test/client-intake', pluginVersion: '1.0.0', title: 'Bind Client intake', createdBy: 'p1', runId: 'run_9', binding });
    return { root, meta, binding };
  }

  test('create → load → write → diff → publish', async () => {
    const { root, meta } = await bindingDraft();
    expect(meta).toMatchObject({ workflowId: 'test__client-intake', kind: 'binding', plugin: { id: 'test/client-intake', version: '1.0.0' }, status: 'open', runId: 'run_9' });
    expect(meta.id).toMatch(/^test__client-intake-[0-9a-z]+$/);
    expect(Object.keys(meta.base).every((p) => p.startsWith('domain/'))).toBe(true);
    const dir = join(root, 'drafts', meta.id);
    expect(existsSync(join(dir, 'workflows'))).toBe(false);
    expect(existsSync(join(dir, BINDING))).toBe(true);

    // The draft loads with its unfrozen binding applied, so the dry run sees the plugin's workflow.
    const loaded = await loadDraft(root, meta.id);
    expect(loaded.workflow).toBeUndefined();
    expect(loaded.project.workflows['client-intake']?.owner).toBe('manager');
    expect(checkBindings(loaded.project)).toEqual([]);

    await expect(writeDraftFiles(root, meta.id, { 'workflows/client-intake/workflow.yaml': 'x' }, cli)).rejects.toThrow(/only holds domain/);
    const h1 = await draftContentHash(root, meta.id);
    const text = readFileSync(join(dir, BINDING), 'utf8');
    await writeDraftFiles(root, meta.id, { [BINDING]: text.replace('version: 0', 'version: 1').concat('frozen:\n  by: p1\n  at: "2026-10-21T00:00:00Z"\n') }, cli);
    expect(await draftContentHash(root, meta.id)).not.toBe(h1);

    const diff = await diffDraft(root, meta.id);
    expect(diff.files.map((f) => [f.path, f.status])).toEqual([[BINDING, 'added']]);
    expect(diff.structure).toBeUndefined();
    expect(diff.conflicts).toEqual([]);

    const r = await applyDraft(root, meta.id, { hash: await draftContentHash(root, meta.id) });
    expect(r).toEqual({ workflowId: 'test__client-intake', version: 1, files: [BINDING] });
    expect((await readDraft(root, meta.id))!.meta.status).toBe('published');
    const live = await loadProject(root);
    expect(live.project.bindings!['test/client-intake']!.frozen?.by).toBe('p1');
    expect(live.project.workflows['client-intake']!.origin?.bindingVersion).toBe(1);
  });

  test('a live change to the binding since the draft was made is a conflict', async () => {
    const { root, meta } = await bindingDraft();
    writeFileSync(join(root, BINDING), 'plugin: test/client-intake\nplugin_version: 1.0.0\n');
    expect((await diffDraft(root, meta.id)).conflicts).toEqual([BINDING]);
    await expect(applyDraft(root, meta.id)).rejects.toBeInstanceOf(DraftConflictError);
    await expect(createDraft(root, { workflowId: 'x', title: 'x', kind: 'binding', createdBy: 'cli' })).rejects.toThrow(/createBindingDraft/);
  });
});
