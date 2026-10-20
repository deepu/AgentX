import { describe, expect, it } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import {
  CONFIG_DIR,
  DEFAULT_CONFIG_DIR_NAME,
  LEGACY_CONFIG_DIR_NAME,
  migrateLegacyConfigDir,
  resolveConfigDir,
} from '../paths.ts';

// OSS #1062: MEMWISE_CONFIG_DIR must be the single switch for where the app keeps
// its state; every module joins onto CONFIG_DIR instead of homedir().
describe('resolveConfigDir', () => {
  it('defaults to ~/.memwise', () => {
    expect(resolveConfigDir({}, '/Users/me')).toBe(join('/Users/me', DEFAULT_CONFIG_DIR_NAME));
    expect(resolveConfigDir({ MEMWISE_CONFIG_DIR: '' }, '/Users/me')).toBe(join('/Users/me', DEFAULT_CONFIG_DIR_NAME));
    expect(resolveConfigDir({ MEMWISE_CONFIG_DIR: '   ' }, '/Users/me')).toBe(join('/Users/me', DEFAULT_CONFIG_DIR_NAME));
  });

  it('honors MEMWISE_CONFIG_DIR', () => {
    expect(resolveConfigDir({ MEMWISE_CONFIG_DIR: '/tmp/memwise-dev' }, '/Users/me')).toBe('/tmp/memwise-dev');
    expect(resolveConfigDir({ MEMWISE_CONFIG_DIR: ' /tmp/memwise-dev ' }, '/Users/me')).toBe('/tmp/memwise-dev');
  });

  it('CONFIG_DIR is the resolver evaluated against the real environment', () => {
    expect(CONFIG_DIR).toBe(resolveConfigDir(process.env, homedir()));
  });
});

describe('migrateLegacyConfigDir', () => {
  function makeHome(): string {
    return mkdtempSync(join(tmpdir(), 'memwise-paths-test-'));
  }

  it('moves ~/.craft-agent to ~/.memwise, links the old path and rewrites config.json', () => {
    const home = makeHome();
    const legacy = join(home, LEGACY_CONFIG_DIR_NAME);
    mkdirSync(join(legacy, 'workspaces', 'ws'), { recursive: true });
    writeFileSync(join(legacy, 'config.json'), JSON.stringify({
      workspaces: [
        { rootPath: `~/${LEGACY_CONFIG_DIR_NAME}/workspaces/ws` },
        { rootPath: join(legacy, 'workspaces', 'ws') },
      ],
    }));

    expect(migrateLegacyConfigDir({}, home)).toBe('moved');

    const target = join(home, DEFAULT_CONFIG_DIR_NAME);
    expect(existsSync(join(target, 'workspaces', 'ws'))).toBe(true);
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
    const config = JSON.parse(readFileSync(join(target, 'config.json'), 'utf-8'));
    expect(config.workspaces[0].rootPath).toBe(`~/${DEFAULT_CONFIG_DIR_NAME}/workspaces/ws`);
    expect(config.workspaces[1].rootPath).toBe(join(target, 'workspaces', 'ws'));

    // Second run is a no-op: the new folder exists and the old path is a link.
    expect(migrateLegacyConfigDir({}, home)).toBe('skipped');
  });

  it('leaves an existing ~/.memwise alone', () => {
    const home = makeHome();
    mkdirSync(join(home, LEGACY_CONFIG_DIR_NAME));
    mkdirSync(join(home, DEFAULT_CONFIG_DIR_NAME));
    expect(migrateLegacyConfigDir({}, home)).toBe('skipped');
    expect(lstatSync(join(home, LEGACY_CONFIG_DIR_NAME)).isDirectory()).toBe(true);
  });

  it('does nothing when MEMWISE_CONFIG_DIR is set', () => {
    const home = makeHome();
    mkdirSync(join(home, LEGACY_CONFIG_DIR_NAME));
    expect(migrateLegacyConfigDir({ MEMWISE_CONFIG_DIR: '/tmp/elsewhere' }, home)).toBe('skipped');
    expect(existsSync(join(home, DEFAULT_CONFIG_DIR_NAME))).toBe(false);
  });
});
