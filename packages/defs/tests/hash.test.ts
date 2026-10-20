import { describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProject } from '../src/index.ts';
import { SAMPLE } from './fixture.ts';

async function hashes(root: string) {
  const { project } = await loadProject(root);
  const wf = project.workflows['client-intake']!;
  return { workflow: wf.hash, check: wf.steps.check!.hash, verify: wf.steps.verify!.hash, caseType: wf.caseType.hash, customer: project.entities.Customer!.hash };
}

describe('hashes', () => {
  test('are stable across loads and copies of the folder', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'memwise-hash-'));
    try {
      cpSync(SAMPLE, copy, { recursive: true });
      expect(await hashes(copy)).toEqual(await hashes(SAMPLE));
      expect(await hashes(SAMPLE)).toEqual(await hashes(SAMPLE));
    } finally { rmSync(copy, { recursive: true, force: true }); }
  });

  test.each([
    ['steps/check.md', ['workflow', 'check']],
    ['case.yaml', ['workflow', 'caseType']],
    ['examples/clean-application.yaml', ['workflow']],
    ['policy.yaml', ['workflow']],
    ['workflow.yaml', ['workflow']],
  ])('changing %s changes exactly the hashes that cover it', async (file, changed) => {
    const copy = mkdtempSync(join(tmpdir(), 'memwise-hash-'));
    try {
      cpSync(SAMPLE, copy, { recursive: true });
      const before = await hashes(copy);
      appendFileSync(join(copy, 'workflows/client-intake', file), '\n# edited\n');
      const after = await hashes(copy);
      for (const key of Object.keys(before) as (keyof typeof before)[]) {
        if (changed.includes(key)) expect(after[key]).not.toBe(before[key]);
        else expect(after[key]).toBe(before[key]);
      }
    } finally { rmSync(copy, { recursive: true, force: true }); }
  });

  test('a new file anywhere in the folder changes the workflow hash; dotfiles do not', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'memwise-hash-'));
    try {
      cpSync(SAMPLE, copy, { recursive: true });
      const before = await hashes(copy);
      writeFileSync(join(copy, 'workflows/client-intake/.DS_Store'), 'junk');
      expect((await hashes(copy)).workflow).toBe(before.workflow);
      writeFileSync(join(copy, 'workflows/client-intake/components-note.txt'), 'a form');
      expect((await hashes(copy)).workflow).not.toBe(before.workflow);
    } finally { rmSync(copy, { recursive: true, force: true }); }
  });
});
