/**
 * The MemWise plugin skill tier (docs/memwise/25-literature-poc.md §7): skills of the plugins
 * installed in the MemWise project, the newest version of each, named `<plugin>:<skill>`, offered
 * after the global, workspace and project tiers; mentions resolve them; reading one comes with
 * the MemWise note.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  comparePluginVersions,
  findPluginSkill,
  loadAllSkills,
  loadPluginSkills,
  loadSkillBySlug,
  setPluginSkillsRootProvider,
} from '../storage.ts';
import { MEMWISE_PLUGIN_SKILL_NOTE } from '../types.ts';
import { parseMentions, resolveSkillMentions } from '../../mentions/index.ts';
import { formatSkillReadDirective } from '../../agent/base-agent.ts';

const dirs: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

afterEach(() => {
  setPluginSkillsRootProvider(null);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function skill(dir: string, name: string, description: string, body = 'Body') {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
}

/** A project with the imported data plugin (two versions) and a native MemWise plugin. */
function project(): string {
  const root = temp('mw-plugins-');
  const data = join(root, 'plugins', 'claude__data');
  mkdirSync(join(data, '1.0.0'), { recursive: true });
  writeFileSync(join(data, '1.0.0', 'memwise-plugin.yaml'), 'id: claude/data\nversion: 1.0.0\ntitle: data\nimportedFrom: { kind: claude-plugin, name: data }\n');
  skill(join(data, '1.0.0', 'skills', 'old-skill'), 'old-skill', 'Only in the old version');
  mkdirSync(join(data, '1.10.0'), { recursive: true });
  writeFileSync(join(data, '1.10.0', 'memwise-plugin.yaml'), 'id: claude/data\nversion: 1.10.0\ntitle: Data\nimportedFrom: { kind: claude-plugin, name: data }\n');
  skill(join(data, '1.10.0', 'skills', 'create-viz'), 'create-viz', 'Create publication-quality visualizations with Python', 'Use matplotlib.');
  skill(join(data, '1.10.0', 'skills', 'validate-data'), 'validate-data', 'QA an analysis before sharing');
  mkdirSync(join(data, '1.9.2', 'skills'), { recursive: true });
  const connectors = join(root, 'plugins', 'memwise__connectors', '1.0.0');
  mkdirSync(connectors, { recursive: true });
  writeFileSync(join(connectors, 'memwise-plugin.yaml'), 'id: memwise/connectors\nversion: 1.0.0\ntitle: Connectors\n');
  skill(join(connectors, 'skills', 'connector-setup'), 'connector-setup', 'Set up connectors');
  // Not a skill: no front matter
  mkdirSync(join(connectors, 'skills', 'broken'), { recursive: true });
  writeFileSync(join(connectors, 'skills', 'broken', 'SKILL.md'), 'no front matter');
  return root;
}

describe('plugin skills', () => {
  it('orders versions by number, not by text', () => {
    expect(['1.0.0', '1.10.0', '1.9.2', '1.10.0-rc.1'].sort((a, b) => comparePluginVersions(b, a))).toEqual(['1.10.0', '1.10.0-rc.1', '1.9.2', '1.0.0']);
  });

  it('reads the newest version of each plugin, named <plugin>:<skill>', () => {
    const root = project();
    const skills = loadPluginSkills(root);
    expect(skills.map((s) => s.slug)).toEqual(['connectors:connector-setup', 'data:create-viz', 'data:validate-data']);
    const viz = skills.find((s) => s.slug === 'data:create-viz')!;
    expect(viz).toMatchObject({
      source: 'plugin',
      metadata: { name: 'create-viz', description: 'Create publication-quality visualizations with Python' },
      plugin: { name: 'data', id: 'claude/data', title: 'Data', version: '1.10.0' },
      path: join(root, 'plugins', 'claude__data', '1.10.0', 'skills', 'create-viz'),
    });
    expect(viz.content).toContain('Use matplotlib.');
  });

  it('come after the global, workspace and project tiers once the MemWise project is registered', () => {
    const root = project();
    const ws = temp('mw-ws-');
    skill(join(ws, 'skills', 'create-viz'), 'create-viz', 'The workspace one');
    const before = loadAllSkills(ws).map((s) => s.slug);
    expect(before).toContain('create-viz');
    expect(before.some((s) => s.includes(':'))).toBe(false);

    setPluginSkillsRootProvider(() => root);
    const all = loadAllSkills(ws);
    expect(all.find((s) => s.slug === 'create-viz')!.source).toBe('workspace');
    expect(all.find((s) => s.slug === 'data:create-viz')!.source).toBe('plugin');
    expect(all.findIndex((s) => s.slug === 'data:create-viz')).toBeGreaterThan(all.findIndex((s) => s.slug === 'create-viz'));
    expect(loadSkillBySlug(ws, 'data:create-viz')!.plugin!.version).toBe('1.10.0');
    expect(findPluginSkill('data:old-skill')).toBeNull();

    setPluginSkillsRootProvider(() => undefined);
    expect(loadAllSkills(ws).some((s) => s.source === 'plugin')).toBe(false);
  });

  it('mentions resolve a plugin skill by its full name, and other skills as before', () => {
    const available = ['commit', 'create-viz', 'data:create-viz'];
    expect(parseMentions('[skill:data:create-viz] chart it', available, []).skills).toEqual(['data:create-viz']);
    expect(parseMentions('[skill:My Workspace:create-viz]', available, []).skills).toEqual(['create-viz']);
    expect(parseMentions('[skill:commit] and [skill:ws:commit]', available, []).skills).toEqual(['commit']);
    expect(parseMentions('[skill:data:missing]', available, []).invalidSkills).toEqual(['missing']);
    expect(resolveSkillMentions('use [skill:data:create-viz]', new Map([['data:create-viz', 'create-viz']])))
      .toBe('use [Mentioned skill: create-viz (slug: data:create-viz)]');
  });

  it('reading a plugin skill comes with the MemWise note; other skills without it', () => {
    const withPlugin = formatSkillReadDirective(new Map([['data:create-viz', '/p/plugins/claude__data/1.10.0/skills/create-viz/SKILL.md']]));
    expect(withPlugin).toContain('(skill: data:create-viz)');
    expect(withPlugin).toContain(MEMWISE_PLUGIN_SKILL_NOTE);
    expect(MEMWISE_PLUGIN_SKILL_NOTE).toContain('```chart');
    const plain = formatSkillReadDirective(new Map([['commit', '/ws/skills/commit/SKILL.md']]));
    expect(plain).not.toContain(MEMWISE_PLUGIN_SKILL_NOTE);
    expect(formatSkillReadDirective(new Map())).toBe('');
  });
});
