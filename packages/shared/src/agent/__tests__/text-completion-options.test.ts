import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getTextCompletionOptions } from '../options.ts';

// getDefaultOptions repairs ~/.claude.json on first use; point HOME at a scratch
// directory so the test never touches the developer's real Claude config.
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let scratchHome: string;

beforeAll(() => {
  scratchHome = mkdtempSync(join(tmpdir(), 'memwise-text-completion-'));
  process.env.HOME = scratchHome;
  process.env.USERPROFILE = scratchHome;
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  rmSync(scratchHome, { recursive: true, force: true });
});

describe('getTextCompletionOptions', () => {
  it('disables every built-in tool', () => {
    expect(getTextCompletionOptions().tools).toEqual([]);
  });

  it("pins the permission mode (SDK >=0.3.286 no longer forces 'default' when omitted)", () => {
    expect(getTextCompletionOptions().permissionMode).toBe('default');
  });

  it('keeps the subprocess env built from the overrides', () => {
    const options = getTextCompletionOptions({ ANTHROPIC_API_KEY: 'test-key' });
    expect(options.env?.ANTHROPIC_API_KEY).toBe('test-key');
  });
});
