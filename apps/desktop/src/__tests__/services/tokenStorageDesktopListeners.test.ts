import { describe, it, expect, vi, afterEach } from 'vitest';

// The desktop app has one webview: no other tab writes its session, so the
// session storage listens to no `storage` event there (the browser build's
// way of following the other tabs).

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  vi.resetModules();
});

async function storageListenersAtImport(): Promise<number> {
  vi.resetModules();
  const add = vi.spyOn(window, 'addEventListener');
  await import('../../services/tokenStorage');
  return add.mock.calls.filter((call) => String(call[0]) === 'storage').length;
}

describe('tokenStorage — the storage listener', () => {
  it('is installed in the browser build', async () => {
    expect(await storageListenersAtImport()).toBe(1);
  });

  it('is not installed in the desktop app', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(await storageListenersAtImport()).toBe(0);
  });
});
