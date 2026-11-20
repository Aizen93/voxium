// @vitest-environment node
// A source scan: jsdom does not give this module a file:// import.meta.url.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('the sign-out queue (services/sessionRevocation.ts)', () => {
  it('imports neither the session storage nor the renewal: it can store nothing and end nothing locally', () => {
    const source = readFileSync(fileURLToPath(new URL('../../services/sessionRevocation.ts', import.meta.url)), 'utf8');
    const imports = [...source.matchAll(/^import [^;]*from '([^']+)'/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['./apiBase', '@voxium/shared', 'axios']);
  });
});
