import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The status dot on your own card is CONNECTION-driven, not DB-driven.
 *
 * The regression this pins: authStore's `user.status` is the DB snapshot from
 * the login fetch, taken before the socket connected and never updated after —
 * rendering it showed the signed-in user as permanently offline in the very
 * card that proves the app is live. Your own presence has exactly one honest
 * source: the socket. Connected means online.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

const { listeners, statusRef } = vi.hoisted(() => ({
  listeners: new Set<(s: string) => void>(),
  statusRef: { current: 'disconnected' },
}));

vi.mock('../../services/socket', () => ({
  getConnectionStatus: () => statusRef.current,
  onConnectionStatusChange: (fn: (s: string) => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
}));

vi.mock('../../stores/authStore', () => {
  // status: 'offline' on purpose — the stale DB snapshot that caused the bug.
  const state = () => ({
    user: { id: 'me', displayName: 'Me', avatarUrl: null, status: 'offline' },
    logout: vi.fn(),
  });
  const useAuthStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) =>
    sel ? sel(state()) : state();
  useAuthStore.getState = state;
  return { useAuthStore };
});

vi.mock('../../stores/serverStore', () => {
  // Shared mutable state so tests can flip activeServerId / swap setNickname
  // per case. state() returns the SAME object each call (not a fresh one) so a
  // test's setNickname mock is observable after the component reads it.
  const serverState = {
    activeServerId: null,
    members: [] as Array<{ userId: string; nickname: string | null }>,
    setNickname: vi.fn(),
  };
  const state = () => serverState;
  const useServerStore = <T,>(sel?: (s: typeof serverState) => T) =>
    sel ? sel(state()) : state();
  useServerStore.getState = state;
  (useServerStore as unknown as { __state: typeof serverState }).__state = serverState;
  return { useServerStore };
});

vi.mock('../../stores/voiceStore', () => {
  const state = () => ({
    selfMute: false,
    selfDeaf: false,
    toggleMute: vi.fn(),
    toggleDeaf: vi.fn(),
  });
  const useVoiceStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) =>
    sel ? sel(state()) : state();
  useVoiceStore.getState = state;
  return { useVoiceStore };
});

vi.mock('../../stores/settingsStore', () => {
  const state = () => ({ openSettings: vi.fn() });
  const useSettingsStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) =>
    sel ? sel(state()) : state();
  useSettingsStore.getState = state;
  return { useSettingsStore };
});

vi.mock('../../stores/toastStore', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../../utils/serverErrors', () => ({
  getTranslatedError: (err: unknown, _t: (k: string) => string, fallbackKey: string) => {
    const msg = err instanceof Error ? err.message : (err as { message?: string })?.message;
    return msg && msg !== 'generic' ? msg : fallbackKey;
  },
}));

import { UserCard } from '../../components/layout/UserCard';
import { useServerStore } from '../../stores/serverStore';
import { toast } from '../../stores/toastStore';

const serverStore = useServerStore as unknown as {
  getState: () => {
    activeServerId: string | null;
    members: Array<{ userId: string; nickname: string | null }>;
    setNickname: ReturnType<typeof vi.fn>;
  };
};

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(<UserCard />);
  });
}

function emitStatus(s: string) {
  statusRef.current = s;
  act(() => {
    listeners.forEach((fn) => fn(s));
  });
}

// The Avatar dot carries exactly one of these per status.
const onlineDot = () => document.body.querySelector('.bg-green-500');
const offlineDot = () => document.body.querySelector('.bg-gray-500');

beforeEach(() => {
  statusRef.current = 'connected';
  listeners.clear();
  // Reset the shared server store to a fresh, inactive state per test.
  const s = serverStore.getState();
  s.activeServerId = null;
  s.members = [];
  s.setNickname = vi.fn();
  (toast.success as unknown as ReturnType<typeof vi.fn>).mockClear?.();
  (toast.error as unknown as ReturnType<typeof vi.fn>).mockClear?.();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('UserCard own-status dot', () => {
  it('shows online while the socket is connected, whatever the DB snapshot said', () => {
    render();
    expect(onlineDot()).toBeTruthy();
    expect(offlineDot()).toBeNull();
    expect(document.body.textContent).toContain('channel.online');
  });

  it('shows offline only when the connection is actually down', () => {
    statusRef.current = 'disconnected';
    render();
    expect(offlineDot()).toBeTruthy();
    expect(onlineDot()).toBeNull();
    expect(document.body.textContent).toContain('userProfile.status.offline');
  });

  it('follows the connection live — drop and recover', () => {
    render();
    expect(onlineDot()).toBeTruthy();

    emitStatus('disconnected');
    expect(offlineDot()).toBeTruthy();
    expect(onlineDot()).toBeNull();

    emitStatus('connected');
    expect(onlineDot()).toBeTruthy();
    expect(offlineDot()).toBeNull();
  });
});

/**
 * Space-nickname saving must be honest on BOTH input paths and single-flight.
 *
 * The regression (#200): leaving the field (onBlur) saved inside an empty
 * `catch { /* ignore on blur *\/ }`, so a refused change vanished with no toast
 * and the user believed the nickname changed. Enter and blur each fired their
 * own request with no in-flight guard, so Enter-then-blur could double-send.
 * The fix routes both paths through one saveNickname(): it skips unchanged
 * values and saves already in flight, toasts the translated server error on
 * failure (same as Enter), and Escape cancels without saving.
 */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setServerActive(nickname: string | null) {
  const s = serverStore.getState();
  s.activeServerId = 'srv';
  s.members = [{ userId: 'me', nickname }];
}

function openEditor() {
  const btn = Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent === 'OldNick' || b.textContent === 'channel.setNickname',
  ) as HTMLButtonElement;
  act(() => {
    btn.click();
  });
  return container.querySelector('input[type="text"]') as HTMLInputElement;
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function press(input: HTMLInputElement, key: string) {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

async function blur(input: HTMLInputElement) {
  act(() => {
    input.focus();
  });
  await act(async () => {
    input.blur();
  });
}

async function flush() {
  await act(async () => {});
}

describe('UserCard space-nickname save', () => {
  it('shows the same error toast on blur as on Enter (not silent)', async () => {
    setServerActive('OldNick');
    render();
    const input = openEditor();
    await type(input, 'NewNick');
    serverStore.getState().setNickname.mockRejectedValue(new Error('Too long'));

    await blur(input);
    await flush();

    expect(serverStore.getState().setNickname).toHaveBeenCalledTimes(1);
    expect(serverStore.getState().setNickname).toHaveBeenCalledWith('srv', 'NewNick');
    expect(toast.error).toHaveBeenCalledWith('Too long');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('shows the error toast on Enter too (regression: both paths honest)', async () => {
    setServerActive('OldNick');
    render();
    const input = openEditor();
    await type(input, 'NewNick');
    serverStore.getState().setNickname.mockRejectedValue(new Error('Too long'));

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await flush();

    expect(serverStore.getState().setNickname).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith('Too long');
  });

  it('Enter then blur sends exactly one request (in-flight guard)', async () => {
    setServerActive('OldNick');
    render();
    const input = openEditor();
    await type(input, 'NewNick');
    const d = deferred<void>();
    serverStore.getState().setNickname.mockReturnValue(d.promise);

    press(input, 'Enter'); // starts save #1, awaits
    expect(serverStore.getState().setNickname).toHaveBeenCalledTimes(1);

    await blur(input); // blur while save #1 is in flight -> no save #2
    expect(serverStore.getState().setNickname).toHaveBeenCalledTimes(1);

    d.resolve();
    await flush();
    expect(toast.success).toHaveBeenCalledWith('channel.nicknameSet');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('Escape cancels without saving (even if a blur follows)', async () => {
    setServerActive('OldNick');
    render();
    const input = openEditor();
    await type(input, 'NewNick');
    serverStore.getState().setNickname.mockResolvedValue(undefined);

    press(input, 'Escape'); // sets the cancel flag, closes editor
    await blur(input); // the blur that follows must not save

    expect(serverStore.getState().setNickname).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('a value that did not change sends nothing on blur', async () => {
    setServerActive('OldNick');
    render();
    const input = openEditor(); // input pre-filled with 'OldNick'
    serverStore.getState().setNickname.mockResolvedValue(undefined);

    await blur(input); // still 'OldNick' == original
    await flush();

    expect(serverStore.getState().setNickname).not.toHaveBeenCalled();
  });

  it('a changed value saved on blur sends one request and succeeds', async () => {
    setServerActive('OldNick');
    render();
    const input = openEditor();
    await type(input, 'NewNick');
    serverStore.getState().setNickname.mockResolvedValue(undefined);

    await blur(input);
    await flush();

    expect(serverStore.getState().setNickname).toHaveBeenCalledTimes(1);
    expect(serverStore.getState().setNickname).toHaveBeenCalledWith('srv', 'NewNick');
    expect(toast.success).toHaveBeenCalledWith('channel.nicknameSet');
    expect(toast.error).not.toHaveBeenCalled();
  });
});
