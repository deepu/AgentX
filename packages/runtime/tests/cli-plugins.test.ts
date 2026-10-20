// The Phase 4 CLI, in child processes: plugin install (a MemWise plugin, and a Claude plugin whose
// MCP tools are discovered), plugin list, bind (a proposal, and a binding draft), and check and
// test counting frozen bindings' tools.
import { afterAll, describe, expect, test } from 'bun:test';
import { readDraft } from '@memwise/defs';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChild } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const FIXTURES = join(import.meta.dir, 'fixtures', 'plugins');
const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const cli = (args: string[]) => runChild(CLI, args, {}, 60_000);

describe('memwise plugin, bind', () => {
  test('install, list and bind; a frozen binding\'s tools count in checks', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'mw-cli4-')), 'proj');
    temps.push(root);
    expect((await cli(['init', root])).code).toBe(0);
    expect(existsSync(join(root, 'workflows/bind-plugin/workflow.yaml'))).toBe(true);

    const tiny = await cli(['plugin', 'install', root, join(FIXTURES, 'tiny-tools')]);
    expect(tiny.code, tiny.output).toBe(0);
    expect(tiny.output).toContain('installed test/tiny-tools 1.0.0 in plugins/test__tiny-tools/1.0.0');
    const crm = await cli(['plugin', 'install', root, join(FIXTURES, 'tiny-crm')]);
    expect(crm.code, crm.output).toBe(0);
    expect(crm.output).toContain('found 4 tool(s) on the MCP server crm');
    expect(readFileSync(join(root, 'plugins/claude__tiny-crm/1.0.0/memwise-plugin.yaml'), 'utf8')).toContain('crm.list_contacts');
    const again = await cli(['plugin', 'install', root, join(FIXTURES, 'tiny-tools')]);
    expect(again.output).toContain('already installed');

    const list = await cli(['plugin', 'list', root]);
    expect(list.code, list.output).toBe(0);
    expect(list.output).toMatch(/claude\/tiny-crm\s+1\.0\.0.*not bound/);
    expect(list.output).toContain('tiny.shout (read)');

    const proposal = await cli(['bind', root, 'claude/tiny-crm']);
    expect(proposal.code, proposal.output).toBe(0);
    expect(proposal.output).toMatch(/crm\.list_contacts\s+read\s+\(annotations\)/);
    expect(proposal.output).toMatch(/tool-unclassified\s+crm\.create_contact/);

    const draft = await cli(['bind', root, 'test/tiny-tools', '--draft']);
    expect(draft.code, draft.output).toBe(0);
    const folder = draft.output.trim().split('\n').reverse().find((l) => l.startsWith('/'))!;
    const id = folder.split('/').at(-1)!;
    expect((await readDraft(root, id))?.meta).toMatchObject({ kind: 'binding', plugin: { id: 'test/tiny-tools', version: '1.0.0' } });
    const bindingFile = join(folder, 'domain/bindings/test__tiny-tools.yaml');
    expect(existsSync(bindingFile)).toBe(true);

    // A playbook that uses tiny.shout: unknown until the binding is frozen.
    writeFileSync(join(root, 'workflows', 'bind-plugin', 'steps', 'check.md'), readFileSync(join(root, 'workflows', 'bind-plugin', 'steps', 'check.md'), 'utf8')
      .replace('allowed:  [plugins.install_check]', 'allowed:  [plugins.install_check, tiny.shout]'));
    const before = await cli(['check', root]);
    expect(before.code).toBe(1);
    expect(before.output).toContain('tiny.shout');
    // Frozen (as the freeze step would), the binding's tools count.
    writeFileSync(join(root, 'domain/bindings/test__tiny-tools.yaml'),
      readFileSync(bindingFile, 'utf8').replace(/^version: 0$/m, 'version: 1\nfrozen: { by: cli, at: "2026-10-20T00:00:00Z" }'));
    const after = await cli(['check', root]);
    expect(after.code, after.output).toBe(0);
    const policy = await cli(['policy', root, 'bind-plugin', 'check']);
    expect(policy.output).toContain('test/tiny-tools');
  }, 120_000);
});
