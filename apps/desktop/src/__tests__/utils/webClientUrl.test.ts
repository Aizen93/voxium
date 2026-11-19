import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  clientUrlOrigin,
  currentWebClientBase,
  inviteLink,
  resetWebClientBaseForTests,
  webClientBase,
} from '../../utils/webClientUrl';

// Invite links are opened by someone else, in a browser, on the web client's
// /invite/:code page. The API server serves no such route, so the link must
// start with the web client's origin: the page's own in a browser, the one
// the build was told (VITE_CLIENT_URL) in the desktop app, and the base it
// had before (VITE_WS_URL) when a desktop build was told nothing.

const WEB = 'https://chat.example.com';
const API_WS = 'https://api.example.com';
const TAURI_PAGE = 'https://tauri.localhost';

describe('webClientBase', () => {
  it('in a browser: the page\'s own origin, whatever the build was given', () => {
    for (const ctx of [
      { clientUrl: undefined, wsUrl: undefined },
      { clientUrl: 'https://elsewhere.example.com', wsUrl: API_WS },
      { clientUrl: undefined, wsUrl: API_WS },
    ]) {
      expect(webClientBase({ isTauri: false, isDev: false, pageOrigin: WEB, ...ctx })).toBe(WEB);
    }
    // the dev server (pnpm dev:desktop): its own origin, not the API's port
    expect(webClientBase({ isTauri: false, isDev: true, pageOrigin: 'http://localhost:8080', wsUrl: 'http://localhost:3001' })).toBe('http://localhost:8080');
  });

  it('in the desktop app: the origin VITE_CLIENT_URL names', () => {
    expect(webClientBase({ isTauri: true, isDev: false, pageOrigin: TAURI_PAGE, clientUrl: WEB, wsUrl: API_WS })).toBe(WEB);
    expect(webClientBase({ isTauri: true, isDev: false, pageOrigin: TAURI_PAGE, clientUrl: `${WEB}/`, wsUrl: API_WS })).toBe(WEB);
    expect(webClientBase({ isTauri: true, isDev: false, pageOrigin: TAURI_PAGE, clientUrl: ' https://chat.example.com:8443 ' })).toBe('https://chat.example.com:8443');
    // also under `tauri dev`, when it is set
    expect(webClientBase({ isTauri: true, isDev: true, pageOrigin: 'http://localhost:8080', clientUrl: WEB })).toBe(WEB);
  });

  it('a desktop build told nothing keeps the old base: VITE_WS_URL exactly as written', () => {
    expect(webClientBase({ isTauri: true, isDev: false, pageOrigin: TAURI_PAGE, wsUrl: API_WS })).toBe(API_WS);
    expect(webClientBase({ isTauri: true, isDev: false, pageOrigin: TAURI_PAGE, clientUrl: '', wsUrl: 'https://voxium.example.org' })).toBe('https://voxium.example.org');
    // and the page's origin when there is not even that, as before
    expect(webClientBase({ isTauri: true, isDev: false, pageOrigin: TAURI_PAGE })).toBe(TAURI_PAGE);
  });

  it('`tauri dev` without VITE_CLIENT_URL: the dev server it loads, which serves the web client', () => {
    expect(webClientBase({ isTauri: true, isDev: true, pageOrigin: 'http://localhost:8080', wsUrl: 'http://localhost:3001' })).toBe('http://localhost:8080');
  });

  it('a malformed VITE_CLIENT_URL falls back to the old base, with a warning that does not quote it', () => {
    for (const bad of ['not a url', 'ftp://files.example.com', 'https://user:pw@chat.example.com', 'https://chat.example.com/?x=1', 'https://chat.example.com/#a', 'https://chat.example.com?']) {
      const warn = vi.fn();
      expect(webClientBase({ isTauri: true, isDev: false, pageOrigin: TAURI_PAGE, clientUrl: bad, wsUrl: API_WS }, warn), bad).toBe(API_WS);
      expect(warn, bad).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).not.toContain(bad);
    }
  });
});

describe('clientUrlOrigin', () => {
  it('is null when unset or blank, the origin otherwise (a path is dropped: the routes live at the root)', () => {
    expect(clientUrlOrigin(undefined)).toBeNull();
    expect(clientUrlOrigin('  ')).toBeNull();
    expect(clientUrlOrigin('http://192.0.2.10:8080')).toBe('http://192.0.2.10:8080');
    expect(clientUrlOrigin('https://chat.example.com/app')).toBe('https://chat.example.com');
    expect(clientUrlOrigin('HTTPS://Chat.Example.com:443/')).toBe('https://chat.example.com');
  });
});

describe('inviteLink', () => {
  afterEach(() => {
    resetWebClientBaseForTests();
    vi.unstubAllEnvs();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('is the base and /invite/<code>', () => {
    expect(inviteLink('UsLnacI8', WEB)).toBe('https://chat.example.com/invite/UsLnacI8');
  });

  it('this page (a browser under the test runner): its own origin, not VITE_WS_URL', () => {
    vi.stubEnv('VITE_WS_URL', API_WS);
    resetWebClientBaseForTests();
    expect(inviteLink('abc')).toBe(`${window.location.origin}/invite/abc`);
  });

  it('this page as the desktop app: VITE_CLIENT_URL, else VITE_WS_URL', () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_WS_URL', API_WS);
    vi.stubEnv('VITE_CLIENT_URL', WEB);
    resetWebClientBaseForTests();
    expect(inviteLink('abc')).toBe('https://chat.example.com/invite/abc');

    vi.stubEnv('VITE_CLIENT_URL', '');
    resetWebClientBaseForTests();
    expect(inviteLink('abc')).toBe('https://api.example.com/invite/abc');
  });

  it('computes the base once per page', () => {
    vi.stubEnv('VITE_WS_URL', API_WS);
    resetWebClientBaseForTests();
    const first = currentWebClientBase();
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    expect(currentWebClientBase()).toBe(first);
  });
});
