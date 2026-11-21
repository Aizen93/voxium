// @vitest-environment node
// A source scan: jsdom does not give this module a file:// import.meta.url.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const importsOf = (source: string) => [...source.matchAll(/^(?:import|export) [^;]*from '([^']+)'/gm)].map((m) => m[1]);

describe('the sign-out queue (services/sessionRevocation.ts)', () => {
  it('imports neither the session storage nor the renewal: it can store nothing and end nothing locally', () => {
    const imports = importsOf(read('../../services/sessionRevocation.ts'));
    expect([...new Set(imports)].sort()).toEqual(['./apiBase', './sessionRevocationLimits', '@voxium/shared', 'axios']);
  });

  it('takes the bounds the Cookie Policy quotes from a module that imports nothing', () => {
    expect(importsOf(read('../../services/sessionRevocationLimits.ts'))).toEqual([]);
    expect(read('../../services/sessionRevocationLimits.ts')).toMatch(/^export const SIGN_OUT_RETRY_MAX_AGE_MINUTES = \d+;$/m);
  });

  it('the legal pages read those bounds without pulling the request code in', () => {
    for (const page of ['CookiePolicyContent.en.tsx', 'CookiePolicyContent.fr.tsx']) {
      const imports = importsOf(read(`../../components/legal/${page}`));
      expect(imports).toContain('../../services/sessionRevocationLimits');
      expect(imports).not.toContain('../../services/sessionRevocation');
    }
  });
});

describe('the bounds of a credential change (services/credentialChangeLimits.ts)', () => {
  it('are defined in a module that imports nothing, and only re-exported by the renewal', () => {
    expect(importsOf(read('../../services/credentialChangeLimits.ts'))).toEqual([]);
    expect(read('../../services/session.ts')).not.toMatch(/^export const CREDENTIAL_CHANGE_/m);
  });

  it('the legal pages read them without pulling the renewal in', () => {
    for (const page of ['CookiePolicyContent.en.tsx', 'CookiePolicyContent.fr.tsx']) {
      const imports = importsOf(read(`../../components/legal/${page}`));
      expect(imports).toContain('../../services/credentialChangeLimits');
      expect(imports).not.toContain('../../services/session');
    }
  });
});
