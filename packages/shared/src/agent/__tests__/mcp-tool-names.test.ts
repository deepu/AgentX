import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPlainMcpVerb, isReadOnlyMcpToolName, mcpToolActionName, mcpToolNameWords } from '../mcp-tool-names.ts';
import { shouldAllowToolInMode } from '../mode-manager.ts';
import { permissionsConfigCache } from '../permissions-config.ts';

/** The read verbs shipped in apps/electron/resources/permissions/default.json. */
const DEFAULT_VERBS = ['search', 'list', 'get', 'read', 'info', 'describe', 'show', 'view', 'find', 'query', 'count', 'exists', 'status', 'inspect', 'fetch'];

describe('mcp tool name parsing', () => {
  it('takes the part after mcp__<source>__', () => {
    expect(mcpToolActionName('mcp__budget__delete_all')).toBe('delete_all');
    expect(mcpToolActionName('mcp__craft-kb__get_document')).toBe('get_document');
    expect(mcpToolActionName('get_issue')).toBe('get_issue');
  });

  it('splits camelCase, snake_case and kebab-case', () => {
    expect(mcpToolNameWords('listIssues')).toEqual(['list', 'issues']);
    expect(mcpToolNameWords('notion-search')).toEqual(['notion', 'search']);
    expect(mcpToolNameWords('get_file_contents')).toEqual(['get', 'file', 'contents']);
  });

  it('treats only plain lowercase words as verbs', () => {
    expect(isPlainMcpVerb('get')).toBe(true);
    expect(isPlainMcpVerb('^mcp__github__get_.*$')).toBe(false);
    expect(isPlainMcpVerb('Get')).toBe(false);
  });
});

describe('isReadOnlyMcpToolName', () => {
  it.each([
    'mcp__github__get_issue',
    'mcp__linear__listIssues',
    'mcp__slack__slack_get_channel_history',
    'mcp__notion__notion-search',
    'mcp__fs__read_multiple_files',
    'mcp__mongo__count_documents',
    'mcp__service__status',
    'mcp__github__get_commit',
    'mcp__blog__get_post',
    'mcp__github__issue_read',
  ])('%s is read-only', (tool) => {
    expect(isReadOnlyMcpToolName(tool, DEFAULT_VERBS)).toBe(true);
  });

  it.each([
    // Substring matches that used to pass Explore mode
    'mcp__stripe__delete_account',
    'mcp__gmail__send_thread_reply',
    'mcp__sheets__update_spreadsheet',
    'mcp__budget__delete_all',
    'mcp__slack__update_status',
    'mcp__widgets__delete_widget',
    // A read verb combined with a write verb
    'mcp__tracker__get_or_create_issue',
    'mcp__editor__search_and_replace',
    'mcp__db__run_query',
    'mcp__mail__mark_as_read',
    // Noun-like read words outside the first position
    'mcp__social__post_status',
    'mcp__service__reset_status',
    'mcp__service__server_status',
    'mcp__github__create_issue',
    // A read verb that is not where the action is named
    'mcp__db__rebuild_search_index',
    'mcp__db__refresh_materialized_view',
    'mcp__x__get_and_publish',
    'mcp__x__archive_search',
    'mcp__slack__post_slack_list',
  ])('%s is not read-only', (tool) => {
    expect(isReadOnlyMcpToolName(tool, DEFAULT_VERBS)).toBe(false);
  });

  it('is never read-only without verbs', () => {
    expect(isReadOnlyMcpToolName('mcp__github__get_issue', [])).toBe(false);
  });
});

describe('Explore mode with the app default MCP patterns', () => {
  const originalConfigDir = process.env.MEMWISE_CONFIG_DIR;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.MEMWISE_CONFIG_DIR;
    else process.env.MEMWISE_CONFIG_DIR = originalConfigDir;
    permissionsConfigCache.clear();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function useDefaults(allowedMcpPatterns: string[]): { workspaceRootPath: string } {
    const configDir = mkdtempSync(join(tmpdir(), 'mcp-verbs-config-'));
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'mcp-verbs-workspace-'));
    tempDirs.push(configDir, workspaceRootPath);
    mkdirSync(join(configDir, 'permissions'), { recursive: true });
    writeFileSync(join(configDir, 'permissions', 'default.json'), JSON.stringify({
      version: '2026-09-27',
      allowedBashPatterns: [],
      allowedMcpPatterns,
      allowedApiEndpoints: [],
      allowedWritePaths: [],
    }));
    process.env.MEMWISE_CONFIG_DIR = configDir;
    permissionsConfigCache.clear();
    return { workspaceRootPath };
  }

  it('compiles plain words as verbs and keeps regexes as regexes', () => {
    const context = useDefaults(['get', 'list', '^mcp__custom__peek$']);
    const merged = permissionsConfigCache.getMergedConfig(context);
    expect(merged.readOnlyMcpVerbs).toEqual(['get', 'list']);
    expect(merged.readOnlyMcpPatterns.map(pattern => pattern.source)).toEqual(['^mcp__custom__peek$']);
  });

  it('blocks write tools whose names merely contain a read verb', () => {
    const permissionsContext = useDefaults(DEFAULT_VERBS);
    const allowed = (tool: string) => shouldAllowToolInMode(tool, {}, 'safe', { permissionsContext }).allowed;

    expect(allowed('mcp__github__get_issue')).toBe(true);
    expect(allowed('mcp__stripe__delete_account')).toBe(false);
    expect(allowed('mcp__gmail__send_thread_reply')).toBe(false);
    expect(allowed('mcp__budget__delete_all')).toBe(false);
  });

  it('still honours explicit regex patterns', () => {
    const permissionsContext = useDefaults(['^mcp__custom__peek$']);
    expect(shouldAllowToolInMode('mcp__custom__peek', {}, 'safe', { permissionsContext }).allowed).toBe(true);
  });
});
