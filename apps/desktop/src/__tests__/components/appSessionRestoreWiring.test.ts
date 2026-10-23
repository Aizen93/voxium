// @vitest-environment node
// A source scan, like mainLayoutResumeWiring.test.ts: App's effects are
// mounted by no component test, so the wiring is pinned on the source.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A launch that could not reach the server keeps its tokens
 * (authStore.checkAuth) and shows the login page; the network coming back
 * is when the restore is tried again (authStore.retrySessionRestore), or a
 * signed-in user stays on the login page until the next launch.
 */

const APP = fileURLToPath(new URL('../../App.tsx', import.meta.url));
const source = readFileSync(APP, 'utf8');

describe('App wires the network coming back to retrySessionRestore', () => {
  it('registers the online listener and removes it on cleanup', () => {
    expect(source).toMatch(/const retryRestore = \(\) => \{ void useAuthStore\.getState\(\)\.retrySessionRestore\(\); \};/);
    expect(source).toMatch(/window\.addEventListener\('online', retryRestore\)/);
    expect(source).toMatch(/window\.removeEventListener\('online', retryRestore\)/);
  });

  it('still runs the first restore at mount', () => {
    expect(source).toMatch(/useEffect\(\(\) => \{\s*checkAuth\(\);\s*\}, \[checkAuth\]\);/);
  });
});
