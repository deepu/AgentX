import { describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindingPath, bindingToYaml, compareSemver, importClaudePlugin, installPlugin, loadInstalledPlugins, loadPlugin, loadProject,
  parseBindingFile, parsePluginManifest, pluginManifestToYaml, pluginSlug, withDiscoveredTools,
} from '../src/index.ts';
import { makeProject } from './fixture.ts';
import { CRM, EMAIL, INTAKE, INTAKE_BINDING } from './plugin-fixture.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'memwise-plugins-'));
const codes = (ds: { code: string }[]) => ds.map((d) => d.code);

describe('plugin manifests', () => {
  test('the fixture parses clean, with defaults and derived capabilities', () => {
    const r = parsePluginManifest(readFileSync(join(INTAKE, 'memwise-plugin.yaml'), 'utf8'), 'memwise-plugin.yaml');
    expect(r.diagnostics).toEqual([]);
    const m = r.value!;
    expect(m).toMatchObject({ id: 'test/client-intake', version: '1.0.0', trust: 'first-party', workflows: ['client-intake'], skills: ['intake-guide'] });
    expect(m.tools['intake.extract_fields']).toMatchObject({ effect: 'read', quarantine: true, capability: 'document_extraction', run: { command: ['node', 'extract.mjs'], timeoutMs: 30_000 } });
    expect(m.tools['gst.validate_gstin']!.inputSchema.required).toEqual(['gstin']);
    expect(m.tools['gst.validate_gstin']!.outputSchema).toBeDefined();
    expect(m.requires.entities.Client!.fields).toEqual({
      name: { typeSource: 'PersonName', required: true }, email: { typeSource: 'Email' }, tax_id: { typeSource: 'Identifier(GSTIN)' }, pan: { typeSource: 'Identifier(PAN)' },
    });
    expect(m.requires.roles.approver).toEqual({ id: 'approver', title: 'Approver', description: 'Approves onboarding' });
    expect(m.requires.capabilities).toEqual({ email_send: { as: 'email.send' } });
    expect(m.policy?.tools?.rules?.['intake.extract_fields']?.rateLimit).toEqual({ count: 30, perMs: 60_000 });
    expect(parsePluginManifest('id: a/b\nversion: 0.1.0\ntitle: B\n', 'm.yaml').value?.trust).toBe('local');
  });

  test('round-trips through pluginManifestToYaml', () => {
    for (const dir of [INTAKE, EMAIL]) {
      const m = parsePluginManifest(readFileSync(join(dir, 'memwise-plugin.yaml'), 'utf8'), 'x/memwise-plugin.yaml').value!;
      const back = parsePluginManifest(pluginManifestToYaml(m), 'x/memwise-plugin.yaml');
      expect(back.diagnostics).toEqual([]);
      expect(back.value).toEqual(m);
    }
  });

  test('reports a bad id and version, undeclared servers, missing capability and record tools, bad types', () => {
    const r = parsePluginManifest(`id: Acme
version: v1
title: Bad
provides: { capabilities: { x: { tool: nope } } }
requires: { entities: { Client: { fields: { name: Lst<Text> } } } }
tools:
  a.b: { description: A, run: { mcp: srv, tool: b } }
  c.d: { description: C, run: { shell: ls } }
records:
  contact: { list: { tool: list_contacts }, get: { tool: get_contact, arg: id }, key: id, fields: { name: Text } }
surprise: 1
`, 'm.yaml');
    expect(codes(r.diagnostics).sort()).toEqual([
      'invalid-format', 'invalid-plugin-id', 'invalid-type', 'invalid-version', 'unknown-key', 'unknown-mcp-server', 'unknown-tool', 'unknown-tool', 'unknown-tool',
    ]);
    expect(r.diagnostics.find((d) => d.code === 'unknown-mcp-server')).toMatchObject({ line: 7, path: 'tools.a.b.run.mcp' });
    expect(Object.keys(r.value!.tools)).toEqual(['a.b']);
  });

  test('semver order', () => {
    expect(['1.10.0', '1.2.0', '1.2.0-beta.2', '1.2.0-beta.10', '0.9.9'].sort(compareSemver)).toEqual(['0.9.9', '1.2.0-beta.2', '1.2.0-beta.10', '1.2.0', '1.10.0']);
  });
});

describe('Claude plugins', () => {
  test('import: id, trust, servers verbatim, skills, notes', async () => {
    const { manifest, notes } = await importClaudePlugin(CRM);
    expect(manifest).toMatchObject({
      id: 'claude/sample-crm', version: '0.2.0', title: 'Sample CRM', description: 'A tiny CRM over MCP.', trust: 'community',
      tools: {}, skills: ['contacts'], importedFrom: { kind: 'claude-plugin', name: 'Sample CRM', version: '0.2.0' },
    });
    expect(manifest.mcpServers).toEqual({
      crm: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs'], env: { CRM_DATA: '${CLAUDE_PLUGIN_ROOT}/data.json' } },
      remote: { url: 'https://crm.example/mcp', headers: { Authorization: 'Bearer ${CRM_TOKEN}' } },
    });
    expect(notes.some((n) => n.startsWith('commands/'))).toBe(true);
    expect(notes.some((n) => n.startsWith('hooks/'))).toBe(false);
    await expect(importClaudePlugin(INTAKE)).rejects.toThrow(/not a Claude plugin/);
  });

  test('discovered tools come in unclassified, with annotations; list_/get_ tools make a record source', async () => {
    const { manifest } = await importClaudePlugin(CRM);
    const contact = { type: 'object', properties: { id: { type: 'string' }, company_name: { type: 'string' }, email: { type: 'string', format: 'email' }, gst_number: { type: 'string' }, employees: { type: 'integer' }, active: { type: 'boolean' } } };
    const tools = [
      { name: 'list_contacts', description: 'List contacts.', inputSchema: { type: 'object' }, outputSchema: { type: 'object', properties: { contacts: { type: 'array', items: contact } } }, annotations: { readOnlyHint: true, title: 'List' } },
      { name: 'get_contact', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, outputSchema: { type: 'object', properties: { contact } } },
      { name: 'create_contact', description: 'Create one.', inputSchema: { type: 'object' } },
    ];
    const m = withDiscoveredTools(manifest, 'crm', tools);
    expect(Object.keys(m.tools)).toEqual(['crm.create_contact', 'crm.get_contact', 'crm.list_contacts']);
    expect(m.tools['crm.list_contacts']).toEqual({
      name: 'crm.list_contacts', description: 'List contacts.', inputSchema: { type: 'object' }, outputSchema: tools[0]!.outputSchema,
      annotations: { readOnlyHint: true }, run: { mcp: 'crm', tool: 'list_contacts' },
    });
    expect(m.tools['crm.create_contact']!.effect).toBeUndefined();
    expect(m.records).toEqual({
      contact: {
        name: 'contact', list: { tool: 'crm.list_contacts', items: 'contacts' }, get: { tool: 'crm.get_contact', arg: 'id', item: 'contact' }, key: 'id',
        fields: { id: 'Text', company_name: 'Text', email: 'Email', gst_number: 'Text', employees: 'Number', active: 'Boolean' },
      },
    });
    // Discovering again replaces the server's tools; the YAML round-trips.
    const again = withDiscoveredTools(m, 'crm', [tools[2]!]);
    expect(Object.keys(again.tools)).toEqual(['crm.create_contact']);
    expect(again.records).toEqual({});
    const back = parsePluginManifest(pluginManifestToYaml(m), m.file);
    expect(back.diagnostics).toEqual([]);
    expect(back.value).toEqual(m);
  });
});

describe('installing', () => {
  test('copies a MemWise plugin; again is a no-op; a changed folder at the same version is refused', async () => {
    const root = makeProject();
    const src = temp();
    cpSync(INTAKE, src, { recursive: true });
    mkdirSync(join(src, 'node_modules/x'), { recursive: true });
    writeFileSync(join(src, 'node_modules/x/index.js'), '');
    mkdirSync(join(src, '.git'));
    writeFileSync(join(src, '.git/HEAD'), 'ref');
    writeFileSync(join(src, '.env'), 'SECRET=1');
    const r = await installPlugin(root, src);
    expect(r).toEqual({ id: 'test/client-intake', version: '1.0.0', dir: 'plugins/test__client-intake/1.0.0', created: true });
    const dir = join(root, r.dir);
    expect(existsSync(join(dir, 'workflows/client-intake/steps/onboard.md'))).toBe(true);
    for (const skipped of ['node_modules', '.git', '.env']) expect(existsSync(join(dir, skipped))).toBe(false);
    expect((await installPlugin(root, src)).created).toBe(false);
    writeFileSync(join(src, 'extract.mjs'), '// changed\n');
    await expect(installPlugin(root, src)).rejects.toThrow(/already holds a different copy/);
    await expect(installPlugin(root, temp())).rejects.toThrow(/not a plugin/);
    rmSync(src, { recursive: true, force: true });
  });

  test('a Claude plugin gets its manifest written into the copy, dotfiles it needs kept', async () => {
    const root = makeProject();
    const { manifest } = await importClaudePlugin(CRM);
    const withTools = withDiscoveredTools(manifest, 'crm', [{ name: 'ping', inputSchema: { type: 'object' } }]);
    const r = await installPlugin(root, CRM, { manifest: withTools });
    expect(r).toMatchObject({ id: 'claude/sample-crm', version: '0.2.0', dir: 'plugins/claude__sample-crm/0.2.0', created: true });
    const dir = join(root, r.dir);
    expect(existsSync(join(dir, '.claude-plugin/plugin.json'))).toBe(true);
    expect(existsSync(join(dir, '.mcp.json'))).toBe(true);
    const loaded = await loadPlugin(dir, root);
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.plugin!.manifest).toEqual({ ...withTools, file: 'plugins/claude__sample-crm/0.2.0/memwise-plugin.yaml' });
    expect(loaded.plugin!.skills).toEqual([{ name: 'contacts', description: 'Look people up in the CRM.', file: 'plugins/claude__sample-crm/0.2.0/skills/contacts/SKILL.md', body: 'Use list_contacts, then get_contact.' }]);
  });

  test('a Claude plugin installed while its server was down can be installed again at the same version', async () => {
    const root = makeProject();
    const { manifest } = await importClaudePlugin(CRM);
    // The first install found no tools (the server could not be reached).
    expect(await installPlugin(root, CRM, { manifest })).toMatchObject({ created: true });
    const dir = join(root, 'plugins/claude__sample-crm/0.2.0');
    expect(Object.keys((await loadPlugin(dir, root)).plugin!.manifest.tools)).toEqual([]);
    // Again with the tools found: the same source files, so the generated manifest is rewritten in place.
    const withTools = withDiscoveredTools(manifest, 'crm', [{ name: 'ping', inputSchema: { type: 'object' } }]);
    expect(await installPlugin(root, CRM, { manifest: withTools })).toMatchObject({ created: false, manifestUpdated: true });
    expect(Object.keys((await loadPlugin(dir, root)).plugin!.manifest.tools)).toEqual(['crm.ping']);
    expect(readdirSync(dir).filter((f) => f.startsWith('.memwise'))).toEqual([]);
    // The same again changes nothing; keepManifest leaves it as it is.
    expect(await installPlugin(root, CRM, { manifest: withTools })).toEqual(expect.objectContaining({ created: false }));
    expect((await installPlugin(root, CRM, { manifest, keepManifest: true })).manifestUpdated).toBeUndefined();
    expect(Object.keys((await loadPlugin(dir, root)).plugin!.manifest.tools)).toEqual(['crm.ping']);
    // A changed source file is still a different copy.
    const changed = temp();
    cpSync(CRM, changed, { recursive: true });
    writeFileSync(join(changed, 'server.mjs'), '// changed\n');
    await expect(installPlugin(root, changed, { manifest: withTools })).rejects.toThrow(/already holds a different copy/);
  });

  test('loadPlugin reports missing workflow and skill folders; hashes are stable across copies', async () => {
    const root = makeProject();
    const a = await loadPlugin(INTAKE, root);
    expect(a.diagnostics).toEqual([]);
    expect(Object.keys(a.plugin!.workflows)).toEqual(['client-intake']);
    expect(a.plugin!.skills[0]).toMatchObject({ name: 'intake-guide', description: 'How to run a client intake.' });
    const r = await installPlugin(root, INTAKE);
    expect((await loadPlugin(join(root, r.dir), root)).plugin!.hash).toBe(a.plugin!.hash);
    const broken = temp();
    cpSync(INTAKE, broken, { recursive: true });
    rmSync(join(broken, 'skills'), { recursive: true });
    rmSync(join(broken, 'workflows'), { recursive: true });
    const b = await loadPlugin(broken, broken);
    expect(b.diagnostics.map((d) => [d.code, d.line])).toEqual([['missing-skill', 36], ['missing-workflow', 35]]);
    expect((await loadPlugin(temp(), root)).diagnostics.map((d) => d.code)).toEqual(['missing-plugin-manifest']);
  });

  test('versions side by side; project.plugins is the newest; slugs and binding paths', async () => {
    const root = makeProject();
    await installPlugin(root, INTAKE);
    const v2 = temp();
    cpSync(INTAKE, v2, { recursive: true });
    writeFileSync(join(v2, 'memwise-plugin.yaml'), readFileSync(join(v2, 'memwise-plugin.yaml'), 'utf8').replace('version: 1.0.0', 'version: 1.10.0'));
    await installPlugin(root, v2);
    const all = await loadInstalledPlugins(root);
    expect(all.diagnostics).toEqual([]);
    expect(all.plugins.map((p) => p.manifest.version)).toEqual(['1.0.0', '1.10.0']);
    const { project } = await loadProject(root);
    expect(project.plugins!['test/client-intake']!.manifest.version).toBe('1.10.0');
    expect(Object.keys(project.pluginVersions!['test/client-intake']!)).toEqual(['1.0.0', '1.10.0']);
    expect(pluginSlug('memwise/client-intake')).toBe('memwise__client-intake');
    expect(bindingPath('memwise/client-intake')).toBe('domain/bindings/memwise__client-intake.yaml');
  });
});

describe('binding files', () => {
  test('parse and round-trip, every section', () => {
    const text = `${INTAKE_BINDING('abc')}records:
  contact:
    entity: Customer
    fields:
      name: { from: company_name, transform: [trim, squash] }
      email: email
      gstin: { from: gst_number, transform: [trim, upper, { default: NONE }, { map: { NONE: null } }], direction: both }
      credit_limit: { from: limit, transform: [{ money: INR }] }
      pan: { transform: [{ template: "{pan_prefix}{pan_rest}" }] }
    identity:
      keys: [gstin, email]
      fuzzy: { field: name, auto: 0.95, review: 0.75 }
      create_missing: false
policy: { effects: { outbound: approve }, tools: { rules: { mail.send_message: { rateLimit: 5/10m } } } }
dry_run: { at: "2026-10-21T02:00:00Z", hash: h1, passed: true, summary: all good }
`;
    const r = parseBindingFile(text, 'domain/bindings/test__client-intake.yaml');
    expect(r.diagnostics).toEqual([]);
    const b = r.value!;
    expect(b).toMatchObject({
      plugin: 'test/client-intake', pluginVersion: '1.0.0', pluginHash: 'abc', version: 1,
      frozen: { by: 'per_1', at: '2026-10-21T02:10:00Z', runId: 'run_1' },
      capabilities: { email_send: 'mail.send_message' },
      roles: { staff: 'staff', approver: 'manager' },
      dryRun: { at: '2026-10-21T02:00:00Z', hash: 'h1', passed: true, summary: 'all good' },
    });
    expect(b.records.contact!.fields.email).toEqual({ from: 'email' });
    expect(b.records.contact!.identity).toEqual({ keys: ['gstin', 'email'], fuzzy: { field: 'name', auto: 0.95, review: 0.75 }, createMissing: false });
    const yaml = bindingToYaml(b);
    expect(yaml.indexOf('plugin_version')).toBeLessThan(yaml.indexOf('frozen'));
    const back = parseBindingFile(yaml, b.file);
    expect(back.diagnostics).toEqual([]);
    expect({ ...back.value!, hash: b.hash }).toEqual(b);
    expect(bindingToYaml(back.value!)).toBe(yaml);
  });

  test('bad transforms and keys are reported', () => {
    const r = parseBindingFile(`plugin: a/b
plugin_version: 1.0.0
records:
  contact: { entity: Customer, fields: { name: { from: n, transform: [shout, { money: rupees }] } } }
tool: {}
`, 'b.yaml');
    expect([...new Set(codes(r.diagnostics))].sort()).toEqual(['invalid-format', 'invalid-transform', 'unknown-key']);
    expect(r.diagnostics.filter((d) => d.code === 'invalid-transform').map((d) => [d.path, d.line])).toEqual([
      ['records.contact.fields.name.transform.0', 4], ['records.contact.fields.name.transform.1', 4],
    ]);
    expect(r.value!.records.contact!.fields.name).toEqual({ from: 'n', transform: [] });
  });
});

