import { describe, it, expect, vi, afterEach } from 'vitest';

// The desktop app has one webview: no other tab writes its session, so the
// session storage listens to no `storage` event there (the browser build's
// way of following the other tabs), and no `pageshow` either (the browser
// build's cue to ask its twin tabs, after the back-forward cache).

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  vi.resetModules();
});

async function listenersAtImport(): Promise<{ storage: number; pageshow: number }> {
  vi.resetModules();
  const add = vi.spyOn(window, 'addEventListener');
  await import('../../services/tokenStorage');
  const count = (type: string) => add.mock.calls.filter((call) => String(call[0]) === type).length;
  return { storage: count('storage'), pageshow: count('pageshow') };
}

describe('tokenStorage — the storage and pageshow listeners', () => {
  it('are installed in the browser build, one each', async () => {
    expect(await listenersAtImport()).toEqual({ storage: 1, pageshow: 1 });
  });

  it('are not installed in the desktop app', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(await listenersAtImport()).toEqual({ storage: 0, pageshow: 0 });
  });
});
