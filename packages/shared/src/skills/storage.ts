/**
 * Skills Storage
 *
 * CRUD operations for workspace skills.
 * Skills are stored in {workspace}/skills/{slug}/ directories.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import matter from 'gray-matter';
import { parse as parseYaml } from 'yaml';
import type { LoadedSkill, SkillMetadata, SkillSource } from './types.ts';
import { getWorkspaceSkillsPath } from '../workspaces/storage.ts';
import {
  validateIconValue,
  findIconFile,
  downloadIcon,
  needsIconDownload,
  isIconUrl,
} from '../utils/icon.ts';

// ============================================================
// Agent Skills Paths (Issue #171)
// ============================================================

/** Global agent skills directory: ~/.agents/skills/ */
export const GLOBAL_AGENT_SKILLS_DIR = join(homedir(), '.agents', 'skills');

/** Project-level agent skills relative directory name */
export const PROJECT_AGENT_SKILLS_DIR = '.agents/skills';

/**
 * Normalize requiredSources frontmatter to a clean string array.
 * Accepts a single string or array of strings, trims whitespace, and deduplicates.
 */
function normalizeRequiredSources(value: unknown): string[] | undefined {
  const asArray = typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value
      : undefined;

  if (!asArray) return undefined;

  const normalized = Array.from(new Set(
    asArray
      .filter((entry): entry is string => typeof entry === 'string')
      .map(entry => entry.trim())
      .filter(Boolean)
  ));

  return normalized.length > 0 ? normalized : undefined;
}

// ============================================================
// Parsing
// ============================================================

/**
 * Parse SKILL.md content and extract frontmatter + body
 */
function parseSkillFile(content: string): { metadata: SkillMetadata; body: string } | null {
  try {
    const parsed = matter(content);

    // Validate required fields
    if (!parsed.data.name || !parsed.data.description) {
      return null;
    }

    // Validate and extract optional icon field
    // Only accepts emoji or URL - rejects inline SVG and relative paths
    const icon = validateIconValue(parsed.data.icon, 'Skills');

    return {
      metadata: {
        name: parsed.data.name as string,
        description: parsed.data.description as string,
        globs: parsed.data.globs as string[] | undefined,
        alwaysAllow: parsed.data.alwaysAllow as string[] | undefined,
        icon,
        requiredSources: normalizeRequiredSources(parsed.data.requiredSources),
      },
      body: parsed.content,
    };
  } catch {
    return null;
  }
}

// ============================================================
// Load Operations
// ============================================================

/**
 * Load a single skill from a directory
 * @param skillsDir - Absolute path to skills directory
 * @param slug - Skill directory name
 * @param source - Where this skill is loaded from
 */
function loadSkillFromDir(skillsDir: string, slug: string, source: SkillSource): LoadedSkill | null {
  const skillDir = join(skillsDir, slug);
  const skillFile = join(skillDir, 'SKILL.md');

  // Check directory exists
  if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) {
    return null;
  }

  // Check SKILL.md exists
  if (!existsSync(skillFile)) {
    return null;
  }

  // Read and parse SKILL.md
  let content: string;
  try {
    content = readFileSync(skillFile, 'utf-8');
  } catch {
    return null;
  }

  const parsed = parseSkillFile(content);
  if (!parsed) {
    return null;
  }

  return {
    slug,
    metadata: parsed.metadata,
    content: parsed.body,
    iconPath: findIconFile(skillDir),
    path: skillDir,
    source,
  };
}

/**
 * Load all skills from a directory
 * @param skillsDir - Absolute path to skills directory
 * @param source - Where these skills are loaded from
 */
function loadSkillsFromDir(skillsDir: string, source: SkillSource): LoadedSkill[] {
  if (!existsSync(skillsDir)) {
    return [];
  }

  const skills: LoadedSkill[] = [];

  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skill = loadSkillFromDir(skillsDir, entry.name, source);
      if (skill) {
        skills.push(skill);
      }
    }
  } catch {
    // Ignore errors reading skills directory
  }

  return skills;
}

/**
 * Load a single skill from a workspace
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill directory name
 */
export function loadSkill(workspaceRoot: string, slug: string): LoadedSkill | null {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  return loadSkillFromDir(skillsDir, slug, 'workspace');
}

/**
 * Load all skills from a workspace
 * @param workspaceRoot - Absolute path to workspace root
 */
export function loadWorkspaceSkills(workspaceRoot: string): LoadedSkill[] {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  return loadSkillsFromDir(skillsDir, 'workspace');
}

// ── Skills cache ────────────────────────────────────────────────────────
// loadAllSkills reads from up to 3 directories on every call (~100ms).
// The result rarely changes during a session, so we cache it per
// (workspaceRoot, projectRoot) pair with a 5-minute safety TTL.

const skillsCache = new Map<string, { skills: LoadedSkill[]; ts: number }>();
const pluginSkillsCache = new Map<string, { skills: LoadedSkill[]; ts: number }>();
const SKILLS_CACHE_TTL = 5 * 60_000; // 5 minutes

/** Invalidate the skills cache (call on working dir change or skill file events). */
export function invalidateSkillsCache(): void {
  skillsCache.clear();
  pluginSkillsCache.clear();
}

// ── Plugin skills (docs/memwise/25-literature-poc.md §7) ───────────────
// Skills of the plugins installed in the MemWise project are a fourth tier, after global,
// workspace and project, named `<plugin>:<skill>` (`data:create-viz`). The project folder is
// known to the MemWise host (server-core), which registers it here when it starts.

/** The MemWise plugin manifest file of an installed plugin version. */
const PLUGIN_MANIFEST_FILE = 'memwise-plugin.yaml';
/** Installed plugins: `<project>/plugins/<slug>/<version>/`. */
const PLUGINS_DIR = 'plugins';

let pluginSkillsRootProvider: (() => string | undefined) | null = null;

/**
 * Register where plugin skills come from: a function answering the MemWise project folder (or
 * undefined while none is running). `null` turns the tier off. Clears the skills cache.
 */
export function setPluginSkillsRootProvider(provider: (() => string | undefined) | null): void {
  pluginSkillsRootProvider = provider;
  invalidateSkillsCache();
}

/** The MemWise project folder whose installed plugins' skills are offered, if any. */
export function getPluginSkillsRoot(): string | undefined {
  try {
    return pluginSkillsRootProvider?.() || undefined;
  } catch {
    return undefined;
  }
}

/** `1.10.0` > `1.9.2`; a pre-release sorts below its release; non-versions last. */
export function comparePluginVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v);
    return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] } : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : a < b ? -1 : a > b ? 1 : 0;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i]! - pb.nums[i]!;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** A name usable in a skill mention: lower case, letters, digits, `-` and `_`. */
function pluginSkillName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'plugin';
}

/** The plugin's name for its skills: the Claude plugin's name, else the id's last part, else the folder. */
function readPluginInfo(versionDir: string, slug: string, version: string): NonNullable<LoadedSkill['plugin']> {
  let manifest: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(readFileSync(join(versionDir, PLUGIN_MANIFEST_FILE), 'utf-8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) manifest = parsed as Record<string, unknown>;
  } catch {
    // No readable manifest: named after the folder.
  }
  const id = typeof manifest.id === 'string' ? manifest.id : undefined;
  const imported = manifest.importedFrom as { name?: unknown } | undefined;
  const importedName = imported && typeof imported.name === 'string' ? imported.name : undefined;
  const raw = importedName ?? id?.split('/').pop() ?? slug.split('__').pop() ?? slug;
  return {
    name: pluginSkillName(raw),
    ...(id ? { id } : {}),
    ...(typeof manifest.title === 'string' ? { title: manifest.title } : {}),
    version: typeof manifest.version === 'string' ? manifest.version : version,
  };
}

/**
 * The skills of the plugins installed in a MemWise project: for each `plugins/<slug>/`, the
 * newest version's `skills/<skill>/SKILL.md`, named `<plugin>:<skill>`. A second plugin with
 * the same name is left out (the first by folder name wins).
 */
export function loadPluginSkills(projectRoot: string): LoadedSkill[] {
  const now = Date.now();
  const cached = pluginSkillsCache.get(projectRoot);
  if (cached && now - cached.ts < SKILLS_CACHE_TTL) return cached.skills;

  const skills: LoadedSkill[] = [];
  const pluginsDir = join(projectRoot, PLUGINS_DIR);
  const seenNames = new Set<string>();
  try {
    if (existsSync(pluginsDir)) {
      const slugs = readdirSync(pluginsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();
      for (const slug of slugs) {
        let versions: string[];
        try {
          versions = readdirSync(join(pluginsDir, slug), { withFileTypes: true })
            .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
            .map((e) => e.name)
            .sort((a, b) => comparePluginVersions(b, a));
        } catch {
          continue;
        }
        const newest = versions[0];
        if (!newest) continue;
        const versionDir = join(pluginsDir, slug, newest);
        const plugin = readPluginInfo(versionDir, slug, newest);
        if (seenNames.has(plugin.name)) continue;
        seenNames.add(plugin.name);
        for (const skill of loadSkillsFromDir(join(versionDir, 'skills'), 'plugin')) {
          skills.push({ ...skill, slug: `${plugin.name}:${skill.slug}`, plugin });
        }
      }
    }
  } catch {
    // An unreadable plugins folder offers no plugin skills.
  }
  skills.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  pluginSkillsCache.set(projectRoot, { skills, ts: now });
  return skills;
}

/** The plugin skill of this `<plugin>:<skill>` name, from the registered MemWise project. */
export function findPluginSkill(name: string): LoadedSkill | null {
  if (!name.includes(':')) return null;
  const root = getPluginSkillsRoot();
  if (!root) return null;
  return loadPluginSkills(root).find((s) => s.slug === name) ?? null;
}

/**
 * Load all skills from all sources (global, workspace, project, then MemWise plugins)
 * Skills with the same slug are overridden by higher-priority sources.
 * Priority: global (lowest) < workspace < project (highest). Plugin skills come last, named
 * `<plugin>:<skill>` (see setPluginSkillsRootProvider).
 *
 * Results are cached per (workspaceRoot, projectRoot) pair. Call
 * invalidateSkillsCache() on working directory changes or skill file events.
 *
 * @param workspaceRoot - Absolute path to workspace root
 * @param projectRoot - Optional project root (working directory) for project-level skills
 */
export function loadAllSkills(workspaceRoot: string, projectRoot?: string): LoadedSkill[] {
  const pluginRoot = getPluginSkillsRoot();
  const cacheKey = `${workspaceRoot}::${projectRoot ?? ''}::${pluginRoot ?? ''}`;
  const now = Date.now();
  const cached = skillsCache.get(cacheKey);
  if (cached && now - cached.ts < SKILLS_CACHE_TTL) {
    return cached.skills;
  }

  const skillsBySlug = new Map<string, LoadedSkill>();

  // 1. Global skills (lowest priority): ~/.agents/skills/
  for (const skill of loadSkillsFromDir(GLOBAL_AGENT_SKILLS_DIR, 'global')) {
    skillsBySlug.set(skill.slug, skill);
  }

  // 2. Workspace skills (medium priority)
  for (const skill of loadWorkspaceSkills(workspaceRoot)) {
    skillsBySlug.set(skill.slug, skill);
  }

  // 3. Project skills (highest priority): {projectRoot}/.agents/skills/
  if (projectRoot) {
    const projectSkillsDir = join(projectRoot, PROJECT_AGENT_SKILLS_DIR);
    for (const skill of loadSkillsFromDir(projectSkillsDir, 'project')) {
      skillsBySlug.set(skill.slug, skill);
    }
  }

  // 4. Plugin skills (doc 25 §7): named `<plugin>:<skill>`, so they never shadow the tiers above.
  if (pluginRoot) {
    for (const skill of loadPluginSkills(pluginRoot)) {
      if (!skillsBySlug.has(skill.slug)) skillsBySlug.set(skill.slug, skill);
    }
  }

  const result = Array.from(skillsBySlug.values());
  skillsCache.set(cacheKey, { skills: result, ts: now });
  return result;
}

/**
 * Load a single skill by slug from all sources (project > workspace > global).
 * Unlike loadAllSkills(), this only reads the specific slug directory — O(1) not O(N).
 *
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill slug to load
 * @param projectRoot - Optional project root for project-level skills
 */
export function loadSkillBySlug(workspaceRoot: string, slug: string, projectRoot?: string): LoadedSkill | null {
  // A plugin skill (`data:create-viz`): only the plugin tier names skills with a colon.
  if (slug.includes(':')) return findPluginSkill(slug);

  // Highest priority: project-level
  if (projectRoot) {
    const projectSkillsDir = join(projectRoot, PROJECT_AGENT_SKILLS_DIR);
    const skill = loadSkillFromDir(projectSkillsDir, slug, 'project');
    if (skill) return skill;
  }

  // Medium priority: workspace
  const workspaceSkill = loadSkillFromDir(getWorkspaceSkillsPath(workspaceRoot), slug, 'workspace');
  if (workspaceSkill) return workspaceSkill;

  // Lowest priority: global
  return loadSkillFromDir(GLOBAL_AGENT_SKILLS_DIR, slug, 'global');
}

/**
 * Get icon path for a skill
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill directory name
 */
export function getSkillIconPath(workspaceRoot: string, slug: string): string | null {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  const skillDir = join(skillsDir, slug);

  if (!existsSync(skillDir)) {
    return null;
  }

  return findIconFile(skillDir) || null;
}

// ============================================================
// Delete Operations
// ============================================================

/**
 * Delete a skill from a workspace
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill directory name
 */
export function deleteSkill(workspaceRoot: string, slug: string): boolean {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  const skillDir = join(skillsDir, slug);

  if (!existsSync(skillDir)) {
    return false;
  }

  try {
    rmSync(skillDir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// Utility Functions
// ============================================================

/**
 * Check if a skill exists in a workspace
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill directory name
 */
export function skillExists(workspaceRoot: string, slug: string): boolean {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  const skillDir = join(skillsDir, slug);
  const skillFile = join(skillDir, 'SKILL.md');

  return existsSync(skillDir) && existsSync(skillFile);
}

/**
 * List skill slugs in a workspace
 * @param workspaceRoot - Absolute path to workspace root
 */
export function listSkillSlugs(workspaceRoot: string): string[] {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);

  if (!existsSync(skillsDir)) {
    return [];
  }

  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => {
        if (!entry.isDirectory()) return false;
        const skillFile = join(skillsDir, entry.name, 'SKILL.md');
        return existsSync(skillFile);
      })
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// ============================================================
// Icon Download (uses shared utilities)
// ============================================================

/**
 * Download an icon from a URL and save it to the skill directory.
 * Returns the path to the downloaded icon, or null on failure.
 */
export async function downloadSkillIcon(
  skillDir: string,
  iconUrl: string
): Promise<string | null> {
  return downloadIcon(skillDir, iconUrl, 'Skills');
}

/**
 * Check if a skill needs its icon downloaded.
 * Returns true if metadata has a URL icon and no local icon file exists.
 */
export function skillNeedsIconDownload(skill: LoadedSkill): boolean {
  return needsIconDownload(skill.metadata.icon, skill.iconPath);
}

// Re-export icon utilities for convenience
export { isIconUrl } from '../utils/icon.ts';
