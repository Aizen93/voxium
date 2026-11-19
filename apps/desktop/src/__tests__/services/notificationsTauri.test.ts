import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Desktop notifications in the Tauri app, three tiers: the shell's own
// command (a WinRT toast with the sender's avatar, Windows), the notification
// plugin (text only), the Web Notification API. The build is read once, when
// the module loads (`__TAURI_INTERNALS__`), so every test loads it afresh.

const tauri = {
  invoke: vi.fn(),
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
  /** Each Tauri module, every time it is loaded. */
  loads: [] as string[],
  /** Loads of the notification plugin still to fail (a chunk that does not arrive). */
  pluginLoadFailures: 0,
};

/** Mock the Tauri modules anew (after a module reset), recording each load. */
function mockTauriModules() {
  vi.doMock('@tauri-apps/api/core', () => {
    tauri.loads.push('core');
    return { invoke: tauri.invoke };
  });
  vi.doMock('@tauri-apps/plugin-notification', () => {
    tauri.loads.push('plugin');
    if (tauri.pluginLoadFailures > 0) {
      tauri.pluginLoadFailures -= 1;
      throw new Error('chunk did not load');
    }
    return {
      isPermissionGranted: tauri.isPermissionGranted,
      requestPermission: tauri.requestPermission,
      sendNotification: tauri.sendNotification,
    };
  });
}

type TauriWindow = { __TAURI_INTERNALS__?: unknown };
const API = 'https://chat.example.org/api/v1';
const REFUSED = "The API base is not an origin this app's content security policy allows";

let warn: ReturnType<typeof vi.spyOn>;

async function load() {
  vi.resetModules();
  mockTauriModules();
  vi.stubEnv('VITE_API_URL', API);
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
  return import('../../services/notifications');
}

beforeEach(() => {
  vi.clearAllMocks();
  tauri.loads.length = 0;
  tauri.pluginLoadFailures = 0;
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

describe('notifications in the Tauri app — permission, the plugin and the Web fallback', () => {
  /** A stand-in for the Web Notification API, every notification shown. */
  function stubWebNotifications(permission: NotificationPermission) {
    const shown: Array<{ title: string; options?: NotificationOptions }> = [];
    class FakeNotification {
      static permission = permission;
      static requestPermission = vi.fn(async () => permission);
      constructor(title: string, options?: NotificationOptions) {
        shown.push({ title, options });
      }
    }
    vi.stubGlobal('Notification', FakeNotification);
    return { shown, requestPermission: FakeNotification.requestPermission };
  }

  it('loads nothing until it is used, then each module once', async () => {
    const { initNotifications, notify } = await load();
    expect(tauri.loads).toEqual([]);

    await initNotifications();
    tauri.invoke.mockRejectedValue('Avatar notifications not implemented on this platform');
    await notify('A', '1');
    await notify('A', '2');

    expect(tauri.loads.sort()).toEqual(['core', 'plugin']);
    expect(tauri.sendNotification).toHaveBeenCalledTimes(2);
  });

  it('asks the plugin for permission when it is not granted yet', async () => {
    tauri.isPermissionGranted.mockResolvedValue(false);
    tauri.requestPermission.mockResolvedValue('granted');
    const { initNotifications, notify } = await load();

    await initNotifications();
    tauri.invoke.mockRejectedValue('Avatar notifications not implemented on this platform');
    await notify('A', 'hi');

    expect(tauri.requestPermission).toHaveBeenCalledTimes(1);
    expect(tauri.sendNotification).toHaveBeenCalledWith({ title: 'A', body: 'hi' });
  });

  it('without the plugin permission, falls to the Web Notification API', async () => {
    tauri.isPermissionGranted.mockResolvedValue(false);
    tauri.requestPermission.mockResolvedValue('denied');
    const web = stubWebNotifications('granted');
    const { initNotifications, notify } = await load();

    await initNotifications();
    tauri.invoke.mockRejectedValue('Avatar notifications not implemented on this platform');
    await notify('A', 'hi');

    expect(tauri.sendNotification).not.toHaveBeenCalled();
    expect(web.shown).toEqual([{ title: 'A', options: { body: 'hi', silent: true } }]);
  });

  it('a plugin that fails to load falls to the Web API, is logged, and is loaded again next time', async () => {
    tauri.pluginLoadFailures = 1;
    const web = stubWebNotifications('default');
    const { initNotifications, notify } = await load();

    await initNotifications();
    // the permission step fell through to the Web API's
    expect(web.requestPermission).toHaveBeenCalledTimes(1);
    // (the test runner words the failed load its own way)
    expect(warn).toHaveBeenCalledWith('[Notifications] Notification permission (plugin) failed, falling back:', expect.any(String));

    await initNotifications();
    tauri.invoke.mockRejectedValue('Avatar notifications not implemented on this platform');
    await notify('A', 'hi');
    expect(tauri.loads.filter((m) => m === 'plugin')).toHaveLength(2);
    expect(tauri.sendNotification).toHaveBeenCalledWith({ title: 'A', body: 'hi' });
  });

  it('a plugin that throws falls to the Web API, and is logged', async () => {
    const web = stubWebNotifications('granted');
    const { initNotifications, notify } = await load();
    await initNotifications();
    tauri.invoke.mockRejectedValue('Avatar notifications not implemented on this platform');
    tauri.sendNotification.mockImplementation(() => {
      throw new Error('plugin gone');
    });

    await notify('A', 'hi');

    expect(web.shown).toEqual([{ title: 'A', options: { body: 'hi', silent: true } }]);
    expect(warn).toHaveBeenCalledWith('[Notifications] Notification plugin failed, falling back:', 'plugin gone');
  });
});
