import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Desktop notifications in a browser session: the Web Notification API only,
// and no Tauri module is ever loaded (the same bundle runs in the Tauri app,
// where services/notifications.ts loads them with import()). Each test loads
// the module afresh with a mock of each Tauri module that records being
// loaded: none may be.

const loaded: string[] = [];

/** Mock the Tauri modules anew (after a module reset) so a load in THIS test is recorded. */
function probeTauriModules() {
  vi.doMock('@tauri-apps/api/core', () => {
    loaded.push('@tauri-apps/api/core');
    return { invoke: vi.fn() };
  });
  vi.doMock('@tauri-apps/plugin-notification', () => {
    loaded.push('@tauri-apps/plugin-notification');
    return { isPermissionGranted: vi.fn(), requestPermission: vi.fn(), sendNotification: vi.fn() };
  });
}

const API = 'https://chat.example.org/api/v1';

/** A stand-in for the Web Notification API, its permission and every notification shown. */
function stubWebNotifications(permission: NotificationPermission) {
  const shown: Array<{ title: string; options?: NotificationOptions }> = [];
  const requestPermission = vi.fn(async () => permission);
  class FakeNotification {
    static permission = permission;
    static requestPermission = requestPermission;
    constructor(title: string, options?: NotificationOptions) {
      shown.push({ title, options });
    }
  }
  vi.stubGlobal('Notification', FakeNotification);
  return { shown, requestPermission };
}

async function load() {
  vi.resetModules();
  probeTauriModules();
  vi.stubEnv('VITE_API_URL', API);
  return import('../../services/notifications');
}

let warn: ReturnType<typeof vi.spyOn>;
const createObjectURL = URL.createObjectURL;
const revokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  loaded.length = 0;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect('__TAURI_INTERNALS__' in window).toBe(false);
});

afterEach(() => {
  warn.mockRestore();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
});

describe('notifications in a browser session', () => {
  it('asks for permission once it is undecided, and loads no Tauri module', async () => {
    const web = stubWebNotifications('default');
    const { initNotifications, notify } = await load();

    await initNotifications();
    await notify('Alice', 'hi', 'avatars/u-1.webp');

    expect(web.requestPermission).toHaveBeenCalledTimes(1);
    expect(loaded).toEqual([]);
  });

  it('shows a Web notification with the proxied avatar as its icon, and loads no Tauri module', async () => {
    const web = stubWebNotifications('granted');
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => ({ size: 4 }) }));
    vi.stubGlobal('fetch', fetchMock);
    URL.createObjectURL = vi.fn(() => 'blob:avatar-1');
    URL.revokeObjectURL = vi.fn();
    const { initNotifications, notify } = await load();

    await initNotifications();
    await notify('Alice', 'hi', 'avatars/u-1.webp');
    await notify('Alice', 'again', 'avatars/u-1.webp');

    expect(web.requestPermission).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${API}/uploads/avatars/u-1.webp?inline`);
    expect(web.shown).toEqual([
      { title: 'Alice', options: { body: 'hi', silent: true, icon: 'blob:avatar-1' } },
      { title: 'Alice', options: { body: 'again', silent: true, icon: 'blob:avatar-1' } },
    ]);
    expect(loaded).toEqual([]);
  });

  it('shows no icon for an invalid key and fetches nothing for it', async () => {
    const web = stubWebNotifications('granted');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { notify } = await load();

    await notify('Alice', 'hi', '../avatars/u-1.webp');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(web.shown).toEqual([{ title: 'Alice', options: { body: 'hi', silent: true } }]);
  });

  it('a failed avatar fetch still shows the notification, and is logged once', async () => {
    const web = stubWebNotifications('granted');
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    const { notify } = await load();

    await notify('Alice', 'one', 'avatars/u-1.webp');
    await notify('Alice', 'two', 'avatars/u-2.webp');

    expect(web.shown.map((n) => n.options?.body)).toEqual(['one', 'two']);
    expect(web.shown.every((n) => n.options?.icon === undefined)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[Notifications] Notification avatar failed, falling back:', 'Failed to fetch');
    expect(loaded).toEqual([]);
  });

  it('shows nothing without permission', async () => {
    const web = stubWebNotifications('denied');
    const { initNotifications, notify } = await load();

    await initNotifications();
    await notify('Alice', 'hi');

    expect(web.requestPermission).not.toHaveBeenCalled();
    expect(web.shown).toEqual([]);
    expect(loaded).toEqual([]);
  });

  it('the probe the tests above rely on does record a load', async () => {
    await load();
    await import('@tauri-apps/plugin-notification');
    expect(loaded).toEqual(['@tauri-apps/plugin-notification']);
  });
});
