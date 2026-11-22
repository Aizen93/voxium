import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { SESSION_ENDED_REASON, SIGNED_OUT_ELSEWHERE_REASON } from '@voxium/shared';
import { LOGIN_REASON_KEYS, loginReasonOf, loginReasonKey, loginPathFor } from '../../utils/loginReasons';

// A session ended elsewhere (signed out from another device, ended by the
// server, a ban, a deletion) used to land on the sign-in page with
// `?reason=…` in the address and nothing on screen. The page now says why,
// from a closed list: anyone can craft a link to it, so nothing of the
// address's own text is ever shown.

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => `t:${k}`, i18n: { language: 'en' } }) };
});

const login = vi.fn(async () => {});
const auth = vi.hoisted(() => ({ error: null as string | null }));
vi.mock('../../stores/authStore', () => {
  const state = () => ({
    login,
    verifyTOTP: vi.fn(),
    cancelTOTP: vi.fn(),
    totpRequired: false,
    error: auth.error,
    clearError: vi.fn(),
    isSubmitting: false,
  });
  const useAuthStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useAuthStore.getState = state;
  return { useAuthStore };
});
vi.mock('../../components/auth/AuthBackground', () => ({ AuthBackground: () => null }));
vi.mock('../../components/auth/PeekingThief', () => ({ PeekingThief: () => null }));

import { LoginPage } from '../../pages/LoginPage';

let container: HTMLDivElement;
let root: Root;

function mountAt(path: string): void {
  act(() => {
    root.render(<MemoryRouter initialEntries={[path]}><LoginPage /></MemoryRouter>);
  });
}

const reasonBanner = () => container.querySelector('[data-testid="login-reason"]');

beforeEach(() => {
  auth.error = null;
  login.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('loginReasons — a closed list between the server\'s words and the page', () => {
  it('maps the four force:logout reasons to a code, and the code to its sentence', () => {
    expect(loginReasonOf(SIGNED_OUT_ELSEWHERE_REASON)).toBe('signed-out-elsewhere');
    expect(loginReasonOf(SESSION_ENDED_REASON)).toBe('session-ended');
    expect(loginReasonOf('Your account has been banned')).toBe('banned');
    expect(loginReasonOf('Your account has been deleted')).toBe('deleted');
    expect(loginPathFor('session-ended')).toBe('/login?reason=session-ended');
    expect(loginPathFor(null)).toBe('/login');
    expect(Object.values(LOGIN_REASON_KEYS)).toEqual([
      'auth.login.reason.signedOutElsewhere',
      'auth.login.reason.sessionEnded',
      'auth.login.reason.accountBanned',
      'auth.login.reason.accountDeleted',
    ]);
  });

  it('anything else is nothing: another sentence, a prototype key, a non-string', () => {
    for (const value of ['Account banned: spam', 'toString', '__proto__', 'constructor', '', 'session-ended ', 42, null, undefined]) {
      expect(loginReasonOf(value)).toBeNull();
    }
    for (const value of ['Your session has ended', 'toString', '__proto__', 'hasOwnProperty', '', null]) {
      expect(loginReasonKey(value as string | null)).toBeNull();
    }
  });
});

describe('LoginPage — the reason a session ended', () => {
  it.each(Object.entries(LOGIN_REASON_KEYS))('?reason=%s shows its mapped sentence', (code, key) => {
    mountAt(`/login?reason=${code}`);
    expect(reasonBanner()?.textContent).toBe(`t:${key}`);
    expect(reasonBanner()?.getAttribute('role')).toBe('status');
  });

  it('a crafted value shows nothing of its own text, nor any banner', () => {
    mountAt(`/login?reason=${encodeURIComponent('Your account is locked, call +1 555 0100')}`);
    expect(reasonBanner()).toBeNull();
    expect(container.textContent).not.toContain('555');

    act(() => root.unmount());
    root = createRoot(container);
    mountAt('/login?reason=__proto__');
    expect(reasonBanner()).toBeNull();
  });

  it('no reason, no banner', () => {
    mountAt('/login');
    expect(reasonBanner()).toBeNull();
  });

  it('goes away once a sign-in is tried, and gives way to its error', () => {
    mountAt('/login?reason=signed-out-elsewhere');
    expect(reasonBanner()).not.toBeNull();

    const form = container.querySelector('form') as HTMLFormElement;
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(login).toHaveBeenCalledTimes(1);
    expect(reasonBanner()).toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    auth.error = 'Invalid credentials';
    mountAt('/login?reason=signed-out-elsewhere');
    expect(reasonBanner()).toBeNull();
  });
});
