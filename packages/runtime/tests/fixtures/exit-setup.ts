// Kernel options for the Phase 1 exit test: examples/intake with the pan-mismatch example's
// model script, stubbed read tools, and the REAL sandbox email.send.
import { loadProject, type ExampleCase } from '@memwise/defs';
import { scriptedProvider, stubTools } from '@memwise/gateway';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sampleTools } from '../../src/sample-tools.ts';
import type { KernelOptions } from '../../src/types.ts';

export const INTAKE_DIR = fileURLToPath(new URL('../../../../examples/intake', import.meta.url));
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
