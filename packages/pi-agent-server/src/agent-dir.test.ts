import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMemWiseAgentDir } from './agent-dir.ts';

describe('resolveMemWiseAgentDir', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('uses an empty folder under the session path', () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'memwise-pi-session-'));
    dirs.push(sessionPath);
    const agentDir = resolveMemWiseAgentDir({ sessionPath });
    expect(agentDir).toBe(join(sessionPath, '.pi-agent'));
    expect(existsSync(agentDir)).toBe(true);
    expect(readdirSync(agentDir)).toEqual([]);
  });

  it('prefers an agentDir sent by the host', () => {
    const root = mkdtempSync(join(tmpdir(), 'memwise-pi-host-'));
    dirs.push(root);
    const agentDir = resolveMemWiseAgentDir({ agentDir: join(root, 'host-agent'), sessionPath: join(root, 'session') });
    expect(agentDir).toBe(join(root, 'host-agent'));
    expect(existsSync(agentDir)).toBe(true);
  });

  it('gives sessionless agents one per-process temp folder, never the global ~/.pi/agent', () => {
    const first = resolveMemWiseAgentDir({ sessionPath: '' });
    const second = resolveMemWiseAgentDir({});
    expect(second).toBe(first);
    expect(realpathSync(first).startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(existsSync(first)).toBe(true);
  });
});
