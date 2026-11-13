// @vitest-environment node
// Pure filesystem check: every workflow states the token permissions it needs
// at its top level. A workflow without a `permissions` key gets the
// repository's default token, which can be read-write for every scope.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WORKFLOWS = fileURLToPath(new URL('../../../../../.github/workflows/', import.meta.url));
const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

describe('workflow token permissions', () => {
  it('finds the workflows', () => {
    expect(files).toEqual(expect.arrayContaining(['ci.yml', 'enforce-source-branch.yml']));
  });

  it.each(files)('%s declares its permissions at the top level', (file) => {
    const yml = readFileSync(WORKFLOWS + file, 'utf8').replace(/\r\n/g, '\n');
    expect(yml).toMatch(/^permissions:/m);
  });

  it('the source-branch check asks for no scope at all', () => {
    const yml = readFileSync(WORKFLOWS + 'enforce-source-branch.yml', 'utf8').replace(/\r\n/g, '\n');
    expect(yml).toMatch(/^permissions: \{\}$/m);
  });
});
