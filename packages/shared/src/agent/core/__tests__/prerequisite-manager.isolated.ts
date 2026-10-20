/**
 * Tests for PrerequisiteManager
 *
 * Tests the prerequisite reading system that blocks tool calls
 * until required files (like guide.md) have been read.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { PrerequisiteManager } from '../prerequisite-manager.ts';

// Mock existsSync to control guide.md existence
const originalExistsSync = existsSync;
let mockExistsPaths: Set<string> = new Set();

mock.module('node:fs', () => ({
  existsSync: (path: string) => mockExistsPaths.has(path),
  // Re-export anything else the module needs
  readFileSync: originalExistsSync,
}));

// The browser toggle would otherwise come from the user's config (and throw under the fs mock)
let mockBrowserToolEnabled = true;

mock.module('../../../config/storage.ts', () => ({
  getBrowserToolEnabled: () => mockBrowserToolEnabled,
}));

const WORKSPACE_ROOT = '/test/workspace';

function guidePath(slug: string): string {
  return resolve(WORKSPACE_ROOT, 'sources', slug, 'guide.md');
}

function browserDocPath(): string {
  return resolve(join(process.env.MEMWISE_CONFIG_DIR || join(homedir(), '.memwise'), 'docs', 'browser-tools.md'));
}

/** `path` with the home directory spelled `prefix` (`~`, `$HOME`, `${HOME}`), as an agent would type it. */
function homeSpelled(path: string, prefix: string): string {
  return path.startsWith(`${homedir()}/`) ? prefix + path.slice(homedir().length) : path;
}

describe('PrerequisiteManager', () => {
  let manager: PrerequisiteManager;
  let debugMessages: string[];

  beforeEach(() => {
    debugMessages = [];
    mockExistsPaths = new Set();
    mockBrowserToolEnabled = true;
    manager = new PrerequisiteManager({
      workspaceRootPath: WORKSPACE_ROOT,
      onDebug: (msg) => debugMessages.push(msg),
    });
  });

  // ============================================================
  // Rule Matching
  // ============================================================

  describe('rule matching', () => {
    it('matches MCP source tools (mcp__{slug}__{tool})', () => {
      mockExistsPaths.add(guidePath('linear'));
      const result = manager.checkPrerequisites('mcp__linear__createIssue');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain('guide.md');
    });

    it('matches API source tools (api_{slug})', () => {
      mockExistsPaths.add(guidePath('github'));
      const result = manager.checkPrerequisites('api_github');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain('guide.md');
    });

    it('does not match built-in tools', () => {
      const result = manager.checkPrerequisites('Read');
      expect(result.allowed).toBe(true);
    });

    it('does not match Bash tool', () => {
      const result = manager.checkPrerequisites('Bash');
      expect(result.allowed).toBe(true);
    });

    it('does not match Write tool', () => {
      const result = manager.checkPrerequisites('Write');
      expect(result.allowed).toBe(true);
    });

    it('exempts session MCP tools', () => {
      mockExistsPaths.add(guidePath('session'));
      const result = manager.checkPrerequisites('mcp__session__SubmitPlan');
      expect(result.allowed).toBe(true);
    });

    it('handles malformed MCP tool names (fewer than 3 parts)', () => {
      const result = manager.checkPrerequisites('mcp__linear');
      expect(result.allowed).toBe(true);
    });

    it('matches the built-in browser tool and blocks until browser docs are read', () => {
      const docsPath = browserDocPath();
      mockExistsPaths.add(docsPath);

      const result = manager.checkPrerequisites('browser_tool');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain(docsPath);
    });

    it('matches session browser tools and blocks until browser docs are read', () => {
      const docsPath = browserDocPath();
      mockExistsPaths.add(docsPath);

      const result = manager.checkPrerequisites('mcp__session__browser_tool');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain(docsPath);
    });

    it('skips the browser rule when the built-in browser tool is disabled', () => {
      mockExistsPaths.add(browserDocPath());
      mockBrowserToolEnabled = false;

      expect(manager.checkPrerequisites('browser_tool').allowed).toBe(true);
    });

    it('says in the block message that a shell read counts too', () => {
      mockExistsPaths.add(guidePath('linear'));
      mockExistsPaths.add(browserDocPath());

      for (const toolName of ['mcp__linear__createIssue', 'browser_tool']) {
        expect(manager.checkPrerequisites(toolName).blockReason).toContain('(Read tool or `cat` in Bash)');
      }
    });
  });

  // ============================================================
  // Path Resolution
  // ============================================================

  describe('path resolution', () => {
    it('resolves guide.md path from MCP tool name', () => {
      const expected = guidePath('linear');
      mockExistsPaths.add(expected);
      const result = manager.checkPrerequisites('mcp__linear__createIssue');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain(expected);
    });

    it('resolves guide.md path from API tool name', () => {
      const expected = guidePath('slack');
      mockExistsPaths.add(expected);
      const result = manager.checkPrerequisites('api_slack');
      expect(result.allowed).toBe(false);
      expect(result.blockReason).toContain(expected);
    });
  });

  // ============================================================
  // Read Tracking
  // ============================================================

  describe('read tracking', () => {
    it('allows tool after guide.md has been read', () => {
      const guideFile = guidePath('linear');
      mockExistsPaths.add(guideFile);

      // Before reading - blocked
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(false);

      // Track the read
      manager.trackReadTool({ file_path: guideFile });

      // After reading - allowed
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(true);
    });

    it('tracks reads using path parameter', () => {
      const guideFile = guidePath('github');
      mockExistsPaths.add(guideFile);

      manager.trackReadTool({ path: guideFile });
      expect(manager.checkPrerequisites('api_github').allowed).toBe(true);
    });

    it('ignores trackReadTool with no path', () => {
      manager.trackReadTool({});
      expect(manager.hasRead('/any/path')).toBe(false);
    });

    it('tracks multiple reads independently', () => {
      const linearGuide = guidePath('linear');
      const slackGuide = guidePath('slack');
      mockExistsPaths.add(linearGuide);
      mockExistsPaths.add(slackGuide);

      manager.trackReadTool({ file_path: linearGuide });

      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(true);
      expect(manager.checkPrerequisites('mcp__slack__sendMessage').allowed).toBe(false);
    });
  });

  // ============================================================
  // Reset
  // ============================================================

  describe('reset', () => {
    it('clears all read state', () => {
      const guideFile = guidePath('linear');
      mockExistsPaths.add(guideFile);

      manager.trackReadTool({ file_path: guideFile });
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(true);

      manager.resetReadState();
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(false);
    });

    it('logs debug message on reset', () => {
      manager.trackReadTool({ file_path: '/some/file' });
      manager.resetReadState();
      expect(debugMessages.some((m) => m.includes('reset read state'))).toBe(true);
    });
  });

  // ============================================================
  // Guide Nonexistence
  // ============================================================

  describe('guide nonexistence', () => {
    it('allows tool when guide.md does not exist', () => {
      // Don't add to mockExistsPaths — guide.md doesn't exist
      const result = manager.checkPrerequisites('mcp__linear__createIssue');
      expect(result.allowed).toBe(true);
    });

    it('allows API tool when guide.md does not exist', () => {
      const result = manager.checkPrerequisites('api_github');
      expect(result.allowed).toBe(true);
    });
  });

  // ============================================================
  // Path Normalization
  // ============================================================

  describe('path normalization', () => {
    it('normalizes tilde paths in trackReadTool', () => {
      const guideFile = guidePath('linear');
      mockExistsPaths.add(guideFile);

      // Track with tilde path that expands to the same absolute path
      const homeDir = process.env.HOME || process.env.USERPROFILE || '/home/user';
      const tildeRelative = `~/some-file.md`;
      manager.trackReadTool({ file_path: tildeRelative });

      // The expanded path should be tracked
      expect(manager.hasRead(tildeRelative)).toBe(true);
    });
  });

  // ============================================================
  // Max Rejection (graceful fallback)
  // ============================================================

  describe('max rejection', () => {
    it('blocks on first attempt, allows on second for same path', () => {
      mockExistsPaths.add(guidePath('linear'));

      // First attempt — blocked
      const first = manager.checkPrerequisites('mcp__linear__createIssue');
      expect(first.allowed).toBe(false);

      // Second attempt (same source, guide still not read) — allowed through
      const second = manager.checkPrerequisites('mcp__linear__createIssue');
      expect(second.allowed).toBe(true);
    });

    it('tracks rejection counts per source independently', () => {
      mockExistsPaths.add(guidePath('linear'));
      mockExistsPaths.add(guidePath('slack'));

      // Block linear once
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(false);

      // Slack should still block on first attempt
      expect(manager.checkPrerequisites('mcp__slack__sendMessage').allowed).toBe(false);

      // Linear second attempt — allowed
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(true);
    });

    it('resets rejection counts on resetReadState', () => {
      mockExistsPaths.add(guidePath('linear'));

      // Exhaust rejections
      manager.checkPrerequisites('mcp__linear__createIssue'); // blocked
      manager.checkPrerequisites('mcp__linear__createIssue'); // allowed (max reached)

      // Reset
      manager.resetReadState();

      // Should block again (rejection count reset)
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(false);
    });

    it('allows different tools from same source after one rejection', () => {
      mockExistsPaths.add(guidePath('linear'));

      // First tool blocked
      expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(false);

      // Different tool from same source — same guide path, already rejected once
      expect(manager.checkPrerequisites('mcp__linear__listIssues').allowed).toBe(true);
    });

    it('does not bypass strict browser prerequisite after repeated rejections', () => {
      const docsPath = browserDocPath();
      mockExistsPaths.add(docsPath);

      expect(manager.checkPrerequisites('browser_tool').allowed).toBe(false);
      expect(manager.checkPrerequisites('browser_tool').allowed).toBe(false);

      manager.trackReadTool({ file_path: docsPath });
      expect(manager.checkPrerequisites('browser_tool').allowed).toBe(true);
    });
  });

  // ============================================================
  // Bash Reads
  // ============================================================

  describe('checkBashPrerequisites', () => {
    describe('guide reads', () => {
      it('counts cat of the browser guide via ~ for the strict browser rule', () => {
        const docsPath = browserDocPath();
        mockExistsPaths.add(docsPath);
        expect(manager.checkPrerequisites('browser_tool').allowed).toBe(false);

        expect(manager.checkBashPrerequisites(`cat ${homeSpelled(docsPath, '~')}`).allowed).toBe(true);
        expect(manager.checkPrerequisites('browser_tool').allowed).toBe(true);
      });

      it('counts a quoted $HOME path piped into head', () => {
        const docsPath = browserDocPath();
        mockExistsPaths.add(docsPath);

        manager.checkBashPrerequisites(`cat "${homeSpelled(docsPath, '$HOME')}" | head -50`);
        expect(manager.checkPrerequisites('browser_tool').allowed).toBe(true);
      });

      it('counts a ${HOME} path', () => {
        manager.checkBashPrerequisites(`cat "${homeSpelled(browserDocPath(), '${HOME}')}"`);
        expect(manager.hasRead(browserDocPath())).toBe(true);
      });

      it('counts sed -n with a line range', () => {
        const docsPath = browserDocPath();
        mockExistsPaths.add(docsPath);

        manager.checkBashPrerequisites(`sed -n '1,200p' ${docsPath}`);
        expect(manager.checkPrerequisites('browser_tool').allowed).toBe(true);
      });

      it('counts head -n of a source guide for its MCP and API tools', () => {
        mockExistsPaths.add(guidePath('linear'));

        manager.checkBashPrerequisites(`head -n 300 ${guidePath('linear')}`);
        // Allowed on the first call, before any block could let it through gracefully
        expect(manager.checkPrerequisites('mcp__linear__createIssue').allowed).toBe(true);
        expect(manager.checkPrerequisites('api_linear').allowed).toBe(true);
      });
    });

    describe('what counts', () => {
      const file = '/test/docs/guide.md';

      it.each([
        [`cat ${file}`],
        [`/bin/cat ${file}`],
        [`command cat ${file}`],
        [`cat -n -- ${file}`],
        [`cat < ${file}`],
        [`/usr/bin/sed -n 1,50p ${file}`],
        [`sed '1,200p' ${file}`],
        [`sed -n -e '1,20p' ${file}`],
        [`bat --paging=never ${file}`],
        [`less ${file}`],
        [`more ${file}`],
        [`nl -ba ${file}`],
        [`tail -n +1 ${file}`],
        [`cat ${file} | head -50 | tail -10`],
        [`cat ${file} 2>/dev/null || echo missing`],
        [`ls /test/docs && cat ${file}`],
        [`echo start; cat ${file}`],
        [`pwd\ncat ${file}`],
        [`(cat ${file})`],
      ])('%s', (command) => {
        expect(manager.checkBashPrerequisites(command).allowed).toBe(true);
        expect(manager.hasRead(file)).toBe(true);
      });

      it('reads a quoted path with spaces', () => {
        manager.checkBashPrerequisites(`cat "/test/my docs/guide.md"`);
        expect(manager.hasRead('/test/my docs/guide.md')).toBe(true);
      });
    });

    describe('what does not count', () => {
      const file = '/test/docs/guide.md';

      it.each([
        [`echo ${file}`],
        [`grep foo ${file}`],
        [`rg foo ${file}`],
        [`rm ${file}`],
        [`wc -l ${file}`],
        [`cat ${file} | grep foo`],
        [`cat ${file} | wc -l`],
        [`cat ${file} > /tmp/copy.md`],
        [`cat ${file} | head -5 >> /tmp/copy.md`],
        [`sed -i '' 's/a/b/' ${file}`],
        [`sed -i.bak 's/a/b/' ${file}`],
        [`cat ${file} &`],
        [`command -v cat ${file}`],
        [`cat > /tmp/notes.md <<'EOF'\ncat ${file}\nEOF`],
        [`cat "unterminated ${file}`],
        ['cat $GUIDE_DIR/guide.md'],
      ])('%s', (command) => {
        expect(manager.checkBashPrerequisites(command).allowed).toBe(true);
        expect(manager.hasRead(file)).toBe(false);
        expect(debugMessages.some((m) => m.includes('tracked read'))).toBe(false);
      });

      it('skips relative paths: the shell cwd is not known', () => {
        manager.checkBashPrerequisites('cat sources/linear/guide.md');
        expect(debugMessages.some((m) => m.includes('tracked read'))).toBe(false);
      });
    });

    describe('skill prerequisites', () => {
      const skillPath = '/test/workspace/skills/my-skill/SKILL.md';

      it('clears a skill read with cat, so other tools run again', () => {
        manager.registerSkillPrerequisites([skillPath]);

        expect(manager.checkBashPrerequisites(`cat ${skillPath}`).allowed).toBe(true);
        expect(manager.hasRead(skillPath)).toBe(true);
        expect(manager.checkPrerequisites('WebSearch').allowed).toBe(true);
      });

      it('clears a skill read through a ~ path', () => {
        const homeSkill = join(homedir(), '.agents', 'skills', 'my-skill', 'SKILL.md');
        manager.registerSkillPrerequisites([homeSkill]);

        manager.checkBashPrerequisites(`cat ${homeSpelled(homeSkill, '~')}`);
        expect(manager.checkPrerequisites('WebSearch').allowed).toBe(true);
      });

      it('clears every skill a command reads', () => {
        const alpha = '/test/workspace/skills/alpha/SKILL.md';
        const beta = '/test/workspace/skills/beta/SKILL.md';
        manager.registerSkillPrerequisites([alpha, beta]);

        manager.checkBashPrerequisites(`cat ${alpha} && cat ${beta}`);
        expect(manager.checkPrerequisites('WebSearch').allowed).toBe(true);
      });

      it('lets a read of one pending skill through while another is still pending', () => {
        const alpha = '/test/workspace/skills/alpha/SKILL.md';
        const beta = '/test/workspace/skills/beta/SKILL.md';
        manager.registerSkillPrerequisites([alpha, beta]);

        expect(manager.checkBashPrerequisites(`cat ${alpha}`).allowed).toBe(true);
        expect(manager.checkPrerequisites('WebSearch').allowed).toBe(false);
      });

      it('holds other Bash calls at the skill gate, and their reads do not count', () => {
        const docsPath = browserDocPath();
        manager.registerSkillPrerequisites([skillPath]);

        const held = manager.checkBashPrerequisites(`cat ${docsPath}`);
        expect(held.allowed).toBe(false);
        expect(held.blockReason).toContain(skillPath);
        expect(manager.hasRead(docsPath)).toBe(false);

        // The gate gives way on the next call, which runs and counts
        expect(manager.checkBashPrerequisites(`cat ${docsPath}`).allowed).toBe(true);
        expect(manager.hasRead(docsPath)).toBe(true);
      });

      it('applies the skill gate to a Bash call without a command', () => {
        manager.registerSkillPrerequisites([skillPath]);
        expect(manager.checkBashPrerequisites('').allowed).toBe(false);
      });

      it('logs when a Bash read clears a skill prerequisite', () => {
        manager.registerSkillPrerequisites([skillPath]);

        manager.checkBashPrerequisites(`cat ${skillPath}`);
        expect(debugMessages.some((m) => m.includes('cleared skill prerequisite via Bash'))).toBe(true);
      });
    });
  });

  // ============================================================
  // Debug Logging
  // ============================================================

  describe('debug logging', () => {
    it('logs when a tool is blocked', () => {
      mockExistsPaths.add(guidePath('linear'));
      manager.checkPrerequisites('mcp__linear__createIssue');
      expect(debugMessages.some((m) => m.includes('Prerequisite blocked'))).toBe(true);
    });

    it('logs when a read is tracked', () => {
      manager.trackReadTool({ file_path: '/some/file.md' });
      expect(debugMessages.some((m) => m.includes('tracked read'))).toBe(true);
    });
  });
});
