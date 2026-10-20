// Kernel options for the Phase 1 exit test: the sample project with client intake version 1, the
// pan-mismatch example's model script, stubbed read tools, and the REAL sandbox email.send.
import { loadProject, type ExampleCase } from '@memwise/defs';
import { scriptedProvider, stubTools } from '@memwise/gateway';
import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleTools } from '../../src/sample-tools.ts';
import type { KernelOptions } from '../../src/types.ts';

/** The live sample project (client intake version 2 since Phase 5). */
export const SAMPLE_DIR = fileURLToPath(new URL('../../../../examples/intake', import.meta.url));

/**
 * The sample project with client intake at version 1 (frozen in the step engine's fixtures):
 * its check step emails the client itself, after an approval. The kernel tests of Phases 1-4
 * run on it, so they keep proving what they proved; version 2 has its own tests (phase5).
 */
export const INTAKE_DIR = (() => {
  const dir = join(mkdtempSync(join(tmpdir(), 'mw-intake-v1-')), 'intake');
  cpSync(SAMPLE_DIR, dir, { recursive: true });
  rmSync(join(dir, 'workflows', 'client-intake'), { recursive: true, force: true });
  cpSync(fileURLToPath(new URL('../../../step-engine/tests/fixtures/intake-v1/workflows/client-intake', import.meta.url)),
    join(dir, 'workflows', 'client-intake'), { recursive: true });
  return dir;
})();
export const EXAMPLE = 'pan-mismatch';

export async function exitKernelOptions(databaseUrl: string, counterFile: string): Promise<{ options: KernelOptions; example: ExampleCase }> {
  const { project } = await loadProject(INTAKE_DIR);
  const example = project.workflows['client-intake']!.examples.find((e) => e.name === EXAMPLE)!;
  const { 'email.send': _real, ...stubs } = example.tools ?? {};
  // One line per real model invocation, so the test can prove none was repeated across restarts.
  const provider = scriptedProvider(example.model!, { onCall: (role, turn) => appendFileSync(counterFile, `${role}:${turn}\n`) });
  return {
    example,
    options: {
      databaseUrl,
      projectDir: INTAKE_DIR,
      tools: stubTools(sampleTools({ databaseUrl }), stubs),
      modelRoles: Object.fromEntries(Object.keys(example.model!).map((role) => [role, { provider: 'scripted', model: 'scripted' }])),
      providers: [provider],
    },
  };
}
