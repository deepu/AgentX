import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The key-derivation salts are key material, not branding. A rename that
// touches them makes every existing credentials.enc undecryptable, and the
// backend then deletes the file as corrupted. The strings are assembled from
// parts so a search-and-replace over the codebase can't rewrite this test too.
describe('secure storage key salts', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'backends', 'secure-storage.ts'), 'utf-8');

  it('keeps the v2 and v1 salts from before the rename', () => {
    expect(source).toContain(`'${['craft', 'agent', 'v2'].join('-')}'`);
    expect(source).toContain(`'${['craft', 'agent', 'v1'].join('-')}'`);
  });
});
