import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Desktop notifications in the Tauri app, three tiers: the shell's own
// command (a WinRT toast with the sender's avatar, Windows), the notification
// plugin (text only), the Web Notification API. The build is read once, when
// the module loads (`__TAURI_INTERNALS__`), so every test loads it afresh.

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: tauri.isPermissionGranted,
  requestPermission: tauri.requestPermission,
  sendNotification: tauri.sendNotification,
}));

type TauriWindow = { __TAURI_INTERNALS__?: unknown };
const API = 'https://chat.example.org/api/v1';
const REFUSED = "The API base is not an origin this app's content security policy allows";

let warn: ReturnType<typeof vi.spyOn>;

async function load() {
  vi.resetModules();
  vi.stubEnv('VITE_API_URL', API);
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
  return import('../../services/notifications');
}

beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  tauri.isPermissionGranted.mockResolvedValue(true);
  tauri.invoke.mockResolvedValue(undefined);
});

afterEach(() => {
  warn.mockRestore();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete (window as TauriWindow).__TAURI_INTERNALS__;
});

describe('notifications in the Tauri app — the native tier', () => {
  it("hands the shell the build's API base with a valid avatar key, and no base without one", async () => {
    const { notify } = await load();

    await notify('Alice', 'hi', 'avatars/u-1.webp');
    expect(tauri.invoke).toHaveBeenLastCalledWith('notify_with_avatar', {
      title: 'Alice',
      body: 'hi',
      apiBase: API,
      avatarKey: 'avatars/u-1.webp',
    });

    for (const key of [null, undefined, '../etc/passwd', 'avatars/u-1.png', 'https://evil.example/a.webp']) {
      await notify('Alice', 'hi', key);
      expect(tauri.invoke).toHaveBeenLastCalledWith('notify_with_avatar', {
        title: 'Alice',
        body: 'hi',
        apiBase: null,
        avatarKey: null,
      });
    }
    expect(tauri.sendNotification).not.toHaveBeenCalled();
  });

  it('a base the shell refuses falls to the plugin, and the refusal is logged once', async () => {
    const { initNotifications, notify } = await load();
    await initNotifications();
    tauri.invoke.mockRejectedValue(REFUSED);

    await notify('Alice', 'one', 'avatars/u-1.webp');
    await notify('Alice', 'two', 'avatars/u-1.webp');

    expect(tauri.sendNotification).toHaveBeenNthCalledWith(1, { title: 'Alice', body: 'one' });
    expect(tauri.sendNotification).toHaveBeenNthCalledWith(2, { title: 'Alice', body: 'two' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[Notifications] Native notification failed, falling back:', REFUSED);
  });

  it('logs each distinct reason once', async () => {
    const { initNotifications, notify } = await load();
    await initNotifications();
    tauri.invoke.mockRejectedValueOnce('Avatar notifications not implemented on this platform');
    tauri.invoke.mockRejectedValueOnce('Avatar notifications not implemented on this platform');
    tauri.invoke.mockRejectedValueOnce(new Error(REFUSED));

    await notify('A', '1');
    await notify('A', '2');
    await notify('A', '3', 'avatars/u-1.webp');

    expect(warn.mock.calls).toEqual([
      ['[Notifications] Native notification failed, falling back:', 'Avatar notifications not implemented on this platform'],
      ['[Notifications] Native notification failed, falling back:', REFUSED],
    ]);
    expect(tauri.sendNotification).toHaveBeenCalledTimes(3);
  });
});
