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
  const state = () => ({ activeServerId: null, members: [], setNickname: vi.fn() });
  const useServerStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) =>
    sel ? sel(state()) : state();
  useServerStore.getState = state;
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

import { UserCard } from '../../components/layout/UserCard';

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
