// @vitest-environment node
// A source scan, like appSessionRestoreWiring.test.ts: the handler assigns
// window.location.href, which jsdom cannot observe.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The two session-ending page reloads (a refused renewal in session.ts, a
 * `force:logout` from the server in socket.ts) must wait for the persisted
 * clear of the tokens. In the desktop app the tokens live in the OS
 * credential store, written over IPC after the synchronous `clearTokens()`
 * returns: a reload that outran the write would load the just-refused tokens
 * again at the next launch and be refused again, a reload loop.
 */

const SOCKET = fileURLToPath(new URL('../../services/socket.ts', import.meta.url));
const source = readFileSync(SOCKET, 'utf8');

describe('socket force:logout reloads only after the stored session is cleared', () => {
  it('awaits flushTokenStorage() between logout() and the navigation', () => {
    const start = source.indexOf("s.on('force:logout'");
    expect(start).toBeGreaterThan(-1);
    const handler = source.slice(start, source.indexOf("s.on('disconnect'", start));
    expect(handler).toMatch(/const toLogin = \(\) => \{\s*window\.location\.href = /);
    expect(handler).toMatch(/useAuthStore\.getState\(\)\.logout\(\);[\s\S]*await flushTokenStorage\(\);[\s\S]*toLogin\(\);/);
  });

  it('still reaches the login page when the local clean-up fails (and logs it)', () => {
    const start = source.indexOf("s.on('force:logout'");
    const handler = source.slice(start, source.indexOf("s.on('disconnect'", start));
    expect(handler).toMatch(/\.catch\(\(err: unknown\) => \{[\s\S]*console\.error\([\s\S]*toLogin\(\);/);
  });
});
