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
 * again at the next launch and be refused again, a reload loop. Both go
 * through ONE trip to the sign-in page per page load (session.ts
 * goToLoginPage), so a late refusal never replaces the force:logout's
 * navigation and its reason.
 */

const SOCKET = fileURLToPath(new URL('../../services/socket.ts', import.meta.url));
const SESSION = fileURLToPath(new URL('../../services/session.ts', import.meta.url));
const source = readFileSync(SOCKET, 'utf8');
const session = readFileSync(SESSION, 'utf8');
const storage = readFileSync(fileURLToPath(new URL('../../services/tokenStorage.ts', import.meta.url)), 'utf8');
const latch = readFileSync(fileURLToPath(new URL('../../services/pageNavigation.ts', import.meta.url)), 'utf8');

function forceLogoutHandler(): string {
  const start = source.indexOf("s.on('force:logout'");
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("s.on('disconnect'", start));
}

describe('socket force:logout reloads only after the stored session is cleared', () => {
  it('signs out locally first, then asks for the one trip to the sign-in page with the reason', () => {
    expect(forceLogoutHandler()).toMatch(/useAuthStore\.getState\(\)\.logout\(\{[^}]*\}\);[\s\S]*goToLoginPage\(reason\);/);
  });

  it('that trip waits for the persisted clear, then for an account deletion in flight, and happens once per page load', () => {
    const start = session.indexOf('export function goToLoginPage(');
    expect(start).toBeGreaterThan(-1);
    const fn = session.slice(start, session.indexOf('\n}\n', start));
    expect(fn).toMatch(/if \(loginNavigation\) \{[\s\S]*return;\s*\}/);
    expect(fn).toMatch(/flushTokenStorage\(\)\s*\.then\(\(\) => accountDeletionSettled\(\)\)\s*\.then\(\(\) => navigateToLogin\(/);
  });

  it('the trip and the reload onto another session claim ONE latch, the first navigation of the page load winning', () => {
    const start = session.indexOf('export function goToLoginPage(');
    const fn = session.slice(start, session.indexOf('\n}\n', start));
    // a pending trip still takes a reason before the latch is asked
    expect(fn).toMatch(/if \(loginNavigation\) \{[\s\S]*?return;\s*\}\s*if \(!claimPageNavigation\('login'\)\) return;/);
    const reloadStart = storage.indexOf('export function reloadAfterSessionChange(');
    expect(reloadStart).toBeGreaterThan(-1);
    const reload = storage.slice(reloadStart, storage.indexOf('\n}\n', reloadStart));
    expect(reload).toMatch(/^export function reloadAfterSessionChange\(\): void \{\s*if \(!claimPageNavigation\('reload'\)\) return;/);
    expect(latch).not.toMatch(/^import /m);
  });

  it('still reaches the login page when the local clean-up fails (and logs it)', () => {
    expect(forceLogoutHandler()).toMatch(/\.catch\(\(err: unknown\) => \{[\s\S]*console\.error\([\s\S]*goToLoginPage\(reason\);/);
  });

  it('signs out only the session the socket was admitted with: another session stored meanwhile is reloaded onto, never navigated away from', () => {
    const handler = forceLogoutHandler();
    expect(handler).toMatch(/const endedSession = handshakeToken\(s\);/);
    expect(handler).toMatch(/logout\(\{[^}]*endingSession: endedSession[^}]*\}\);\s*[\s\S]*?if \(outcome === 'replaced'\) return;[\s\S]*goToLoginPage\(reason\);/);
  });
});
