/** Writing an example case back as the YAML `parseExampleFile` reads (corrections and past cases, 05 §12). */
import { stringify } from 'yaml';
import type { ExampleCase } from './types.ts';

/** The example case as `examples/<name>.yaml` text, keys in the order people write them. `file` is not written. */
export function exampleToYaml(example: Omit<ExampleCase, 'file'> & { file?: string }): string {
  const expect = Object.fromEntries(
    (['outcome', 'state', 'writes', 'effects', 'entities'] as const)
      .filter((k) => example.expect[k] !== undefined)
      .map((k) => [k, example.expect[k]]),
  );
  const doc: Record<string, unknown> = { name: example.name };
  if (example.description !== undefined) doc.description = example.description;
  if (example.startAt !== undefined) doc.startAt = example.startAt;
  doc.case = example.case ?? {};
  if (example.tools !== undefined) doc.tools = example.tools;
  if (example.model !== undefined) doc.model = example.model;
  if (example.approvals !== undefined) doc.approvals = example.approvals;
  if (example.submit !== undefined) doc.submit = example.submit;
  doc.expect = expect;
  // No folding: long strings stay on one line, so diffs of example files stay readable.
  return stringify(doc, { lineWidth: 0, aliasDuplicateObjects: false });
}
