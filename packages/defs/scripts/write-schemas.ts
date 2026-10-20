/** Writes the file-format JSON Schemas to schemas/<name>.schema.json (`bun run schemas`). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jsonSchemas } from '../src/formats.ts';

const dir = join(import.meta.dir, '..', 'schemas');
mkdirSync(dir, { recursive: true });
for (const [name, schema] of Object.entries(jsonSchemas)) {
  writeFileSync(join(dir, `${name}.schema.json`), `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`wrote schemas/${name}.schema.json`);
}
