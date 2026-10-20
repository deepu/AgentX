import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { formats, jsonSchemas, splitFrontMatter } from '../src/index.ts';
import { SAMPLE } from './fixture.ts';

describe('JSON Schemas', () => {
  test('one per file format, draft 2020-12, with titles', () => {
    expect(Object.keys(jsonSchemas).sort()).toEqual(['binding', 'case', 'domain', 'entity', 'example', 'page', 'plugin', 'policy', 'roles', 'step', 'view', 'workflow', 'workspace']);
    for (const schema of Object.values(jsonSchemas)) {
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(schema.type).toBe('object');
      expect(typeof schema.title).toBe('string');
    }
    expect([...(jsonSchemas.workflow.required as string[])].sort()).toEqual(['start', 'steps', 'version', 'workflow']);
    expect(jsonSchemas.step.additionalProperties).toBe(false);
  });

  test('the files in schemas/ are up to date (run `bun run schemas`)', () => {
    for (const [name, schema] of Object.entries(jsonSchemas)) {
      const file = readFileSync(join(import.meta.dir, '..', 'schemas', `${name}.schema.json`), 'utf8');
      expect(JSON.parse(file)).toEqual(JSON.parse(JSON.stringify(schema)));
    }
  });

  test('every sample file matches its format', () => {
    const wf = join(SAMPLE, 'workflows/client-intake');
    const yamlFile = (p: string) => parse(readFileSync(p, 'utf8'));
    const cases: [keyof typeof formats, unknown][] = [
      ['workflow', yamlFile(join(wf, 'workflow.yaml'))],
      ['case', yamlFile(join(wf, 'case.yaml'))],
      ['policy', yamlFile(join(wf, 'policy.yaml'))],
      ['policy', yamlFile(join(SAMPLE, 'domain/policy.yaml'))],
      ['entity', yamlFile(join(SAMPLE, 'domain/entities/customer.yaml'))],
      ['roles', yamlFile(join(SAMPLE, 'domain/roles.yaml'))],
      ['example', yamlFile(join(wf, 'examples/pan-mismatch.yaml'))],
      ...['check', 'fill', 'onboard', 'verify'].map((s): [keyof typeof formats, unknown] =>
        ['step', parse(splitFrontMatter(readFileSync(join(wf, `steps/${s}.md`), 'utf8'))!.yaml)]),
    ];
    for (const [format, data] of cases) expect(formats[format].safeParse(data).error).toBeUndefined();
  });
});
