import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import axios from 'axios';
import type { SessionSummary } from '@voxium/shared';

/**
 * "Where you're signed in": the rows, their labels (kind and system from the
 * closed lists, the sign-in day in UTC, the activity day in local time), the
 * hidden state on a server without the list, the failure line, and the two
 * password confirmations (one session, all the others).
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, o?: Record<string, unknown>) => (o ? `${k}|${JSON.stringify(o)}` : k),
      i18n: { language: 'en' },
    }),
  };
});

const listSessions = vi.hoisted(() => vi.fn());
const revokeSession = vi.hoisted(() => vi.fn());
vi.mock('../../services/sessions', () => ({ listSessions, revokeSession }));

const revokeOtherSessions = vi.hoisted(() => vi.fn());
vi.mock('../../stores/authStore', () => {
  const get = () => ({ revokeOtherSessions });
  const useAuthStore = <T,>(sel?: (s: ReturnType<typeof get>) => T) => (sel ? sel(get()) : get());
  useAuthStore.getState = get;
  return { useAuthStore };
});

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock('../../stores/toastStore', () => ({ toast: { success: toastSuccess, error: toastError } }));

import { SessionsSection } from '../../components/settings/SessionsSection';

let container: HTMLDivElement;
let root: Root;
let originalTZ: string | undefined;

beforeAll(() => {
  originalTZ = process.env.TZ;
});

function session(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    clientKind: 'desktop',
    clientOs: 'windows',
    signedInAt: '2026-11-03T00:00:00.000Z',
    lastActiveAt: new Date(2026, 10, 21, 1, 0, 0).toISOString(),
    current: false,
    ...over,
  };
}

const CURRENT = session({ id: 's-current', current: true });
const PHONE = session({ id: 's-phone', clientKind: 'android', clientOs: 'android' });
const WEB = session({ id: 's-web', clientKind: 'web', clientOs: 'linux' });

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}

async function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<SessionsSection />); });
  await flush();
}

beforeEach(() => {
  process.env.TZ = 'America/Los_Angeles';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 21, 12, 0, 0));
  listSessions.mockReset().mockResolvedValue([CURRENT, PHONE, WEB]);
  revokeSession.mockReset().mockResolvedValue({ revoked: 1 });
  revokeOtherSessions.mockReset().mockResolvedValue({ revoked: 2 });
  toastSuccess.mockReset();
  toastError.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.useRealTimers();
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

const rows = () => Array.from(container.querySelectorAll('[data-testid="session-row"]')) as HTMLElement[];
const dialog = () => document.querySelector('[data-testid="sessions-confirm-dialog"]') as HTMLElement | null;
const passwordInput = () => document.querySelector('[data-testid="sessions-confirm-password"]') as HTMLInputElement;
const submitBtn = () => document.querySelector('[data-testid="sessions-confirm-submit"]') as HTMLButtonElement;

function typePassword(value: string) {
  const el = passwordInput();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function submit() {
  await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await flush();
}
function click(el: Element | null) {
  act(() => { (el as HTMLElement).click(); });
}
function axiosError(status: number, message: string) {
  return new axios.AxiosError(message, String(status), undefined, undefined, {
    status, statusText: '', headers: {}, config: { headers: new axios.AxiosHeaders() },
    data: { success: false, error: message },
  });
}

describe('SessionsSection — rows', () => {
  it('shows one row per session with the kind and the system, the caller first, a badge and no button on it', async () => {
    listSessions.mockResolvedValue([PHONE, CURRENT, WEB]);
    await render();
    expect(container.querySelector('[data-testid="sessions-section"]')).toBeTruthy();
    expect(container.textContent).toContain('settings.security.sessions.title');
    const r = rows();
    expect(r).toHaveLength(3);
    expect(r[0].getAttribute('data-session-current')).toBe('true');
    expect(r[0].textContent).toContain('settings.security.sessions.thisDevice');
    expect(r[0].textContent).toContain('settings.security.sessions.kind.desktop');
    expect(r[0].textContent).toContain('settings.security.sessions.os.windows');
    expect(r[0].querySelector('[data-testid="session-sign-out"]')).toBeNull();
    expect(r[1].getAttribute('data-session-current')).toBe('false');
    expect(r[1].textContent).toContain('settings.security.sessions.kind.android');
    expect(r[1].textContent).not.toContain('thisDevice');
    expect(r[1].querySelector('[data-testid="session-sign-out"]')).toBeTruthy();
    expect(r[2].textContent).toContain('settings.security.sessions.os.linux');
  });

  it('falls back to the unknown app and the other system for a value it does not know', async () => {
    listSessions.mockResolvedValue([
      session({ id: 'x', clientKind: 'toaster' as never, clientOs: 'templeos' as never }),
      session({ id: 'y', clientKind: 'constructor' as never, clientOs: 'toString' as never }),
    ]);
    await render();
    for (const r of rows()) {
      expect(r.textContent).toContain('settings.security.sessions.kind.unknown');
      expect(r.textContent).toContain('settings.security.sessions.os.other');
    }
  });

  it('formats the sign-in day in UTC, whatever the local zone (midnight UTC is the day before in Los Angeles)', async () => {
    expect(new Date('2026-11-03T00:00:00.000Z').getDate()).toBe(2); // the zone really is behind UTC
    await render();
    expect(rows()[0].textContent).toContain('settings.security.sessions.signedInOn|{"date":"Nov 3, 2026"}');
  });

  it('says active today, yesterday, or on the day, by local calendar day', async () => {
    listSessions.mockResolvedValue([
      session({ id: 'a', current: true, lastActiveAt: new Date(2026, 10, 21, 0, 5).toISOString() }),
      session({ id: 'b', lastActiveAt: new Date(2026, 10, 20, 23, 30).toISOString() }),
      session({ id: 'c', lastActiveAt: new Date(2026, 10, 10, 12, 0).toISOString() }),
    ]);
    await render();
    const r = rows();
    expect(r[0].textContent).toContain('settings.security.sessions.activeToday');
    expect(r[1].textContent).toContain('settings.security.sessions.activeYesterday');
    expect(r[2].textContent).toContain('settings.security.sessions.activeOn|{"date":"Nov 10, 2026"}');
  });
});

describe('SessionsSection — states', () => {
  it('renders nothing at all when the server has no session list', async () => {
    listSessions.mockResolvedValue(null);
    await render();
    expect(container.innerHTML).toBe('');
  });

  it('shows the quiet loading line while the list is on its way', async () => {
    listSessions.mockReturnValue(new Promise(() => {}));
    await render();
    expect(container.textContent).toContain('common.loading');
    expect(rows()).toHaveLength(0);
  });

  it('shows the failure line with a retry that loads the list again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listSessions.mockRejectedValueOnce(new Error('network'));
    await render();
    expect(container.textContent).toContain('settings.security.sessions.loadFailed');
    expect(rows()).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    click(container.querySelector('[data-testid="sessions-retry"]'));
    await flush();
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('loadFailed');
    expect(rows()).toHaveLength(3);
    warn.mockRestore();
  });

  it('offers the sign-out of the others only when there is another row, else says there is none', async () => {
    await render();
    expect(container.querySelector('[data-testid="sessions-sign-out-others"]')).toBeTruthy();
    act(() => root.unmount());
    container.remove();
    listSessions.mockResolvedValue([CURRENT]);
    await render();
    expect(container.querySelector('[data-testid="sessions-sign-out-others"]')).toBeNull();
    expect(container.textContent).toContain('settings.security.sessions.noOthers');
  });
});

describe('SessionsSection — signing out one session', () => {
  it('asks for the password, names the session, says the trusted device stays trusted, then signs it out and reloads', async () => {
    await render();
    click(container.querySelectorAll('[data-testid="session-sign-out"]')[0]);
    const d = dialog()!;
    expect(d).toBeTruthy();
    expect(d.textContent).toContain('settings.security.sessions.confirmOne|{"label":"settings.security.sessions.kindAndOs|{\\"kind\\":\\"settings.security.sessions.kind.android\\"');
    expect(d.textContent).toContain('settings.security.sessions.confirmOneTrusted');
    expect(passwordInput().type).toBe('password');
    expect(passwordInput().autocomplete).toBe('current-password');
    expect(submitBtn().disabled).toBe(true);

    typePassword('hunter2');
    expect(submitBtn().disabled).toBe(false);
    await submit();

    expect(revokeSession).toHaveBeenCalledWith('s-phone', 'hunter2');
    expect(toastSuccess).toHaveBeenCalledWith('settings.security.sessions.signedOutOne');
    expect(dialog()).toBeNull();
    expect(listSessions).toHaveBeenCalledTimes(2);
  });

  it('keeps the dialog open with the mapped error on a wrong password, and never logs what was typed', async () => {
    const spies = (['log', 'warn', 'error', 'info'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    revokeSession.mockRejectedValueOnce(axiosError(400, 'Password is incorrect'));
    await render();
    click(container.querySelectorAll('[data-testid="session-sign-out"]')[0]);
    typePassword('s3cret-pass');
    await submit();
    expect(dialog()).toBeTruthy();
    expect(document.querySelector('[data-testid="sessions-confirm-error"]')!.textContent).toContain('serverErrors.passwordIncorrect');
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(submitBtn().disabled).toBe(false); // can try again
    for (const s of spies) {
      for (const call of s.mock.calls) expect(JSON.stringify(call)).not.toContain('s3cret-pass');
      s.mockRestore();
    }
  });

  it('shows the mapped sentence of a 429 inside the dialog', async () => {
    revokeSession.mockRejectedValueOnce(axiosError(429, 'Too many requests. Please try again later.'));
    await render();
    click(container.querySelectorAll('[data-testid="session-sign-out"]')[0]);
    typePassword('hunter2');
    await submit();
    expect(dialog()).toBeTruthy();
    expect(document.querySelector('[data-testid="sessions-confirm-error"]')!.textContent).toContain('serverErrors.tooManyRequests');
  });

  it('closes, toasts the mapped error and reloads the list when the session ended meanwhile (404)', async () => {
    revokeSession.mockRejectedValueOnce(axiosError(404, 'Session not found'));
    listSessions.mockResolvedValueOnce([CURRENT, PHONE, WEB]).mockResolvedValueOnce([CURRENT, WEB]);
    await render();
    click(container.querySelectorAll('[data-testid="session-sign-out"]')[0]);
    typePassword('hunter2');
    await submit();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('serverErrors.sessionNotFound'));
    expect(dialog()).toBeNull();
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(2);
  });

  it('closes on Escape and on Cancel, and the password is gone when it opens again', async () => {
    await render();
    const opener = container.querySelectorAll('[data-testid="session-sign-out"]')[0];
    click(opener);
    typePassword('hunter2');
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(dialog()).toBeNull();

    click(opener);
    expect(passwordInput().value).toBe('');
    typePassword('again');
    click(document.querySelector('[data-testid="sessions-confirm-cancel"]'));
    expect(dialog()).toBeNull();
    click(opener);
    expect(passwordInput().value).toBe('');
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it('disables the confirm button while the request runs', async () => {
    let resolve!: (v: { revoked: number }) => void;
    revokeSession.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    await render();
    click(container.querySelectorAll('[data-testid="session-sign-out"]')[0]);
    typePassword('hunter2');
    await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(submitBtn().disabled).toBe(true);
    // a second submit while busy sends nothing more
    await act(async () => { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(revokeSession).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ revoked: 1 }); });
    await flush();
    expect(dialog()).toBeNull();
  });
});

describe('SessionsSection — signing out of all the others', () => {
  it('asks for the password with the confirmation sentence, then reports the count and reloads', async () => {
    await render();
    click(container.querySelector('[data-testid="sessions-sign-out-others"]'));
    expect(dialog()!.textContent).toContain('settings.security.sessions.confirmOthers');
    expect(dialog()!.textContent).not.toContain('confirmOneTrusted');
    expect(submitBtn().disabled).toBe(true);
    typePassword('hunter2');
    listSessions.mockResolvedValueOnce([CURRENT]);
    await submit();
    expect(revokeOtherSessions).toHaveBeenCalledWith('hunter2');
    expect(toastSuccess).toHaveBeenCalledWith('settings.security.sessions.signedOutOthers|{"count":2}');
    expect(dialog()).toBeNull();
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(1);
    expect(container.querySelector('[data-testid="sessions-sign-out-others"]')).toBeNull();
  });

  it('keeps the dialog open with the mapped error on a wrong password', async () => {
    revokeOtherSessions.mockRejectedValueOnce(axiosError(400, 'Password is incorrect'));
    await render();
    click(container.querySelector('[data-testid="sessions-sign-out-others"]'));
    typePassword('nope');
    await submit();
    expect(dialog()).toBeTruthy();
    expect(document.querySelector('[data-testid="sessions-confirm-error"]')!.textContent).toContain('serverErrors.passwordIncorrect');
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it('shows the mapped sentence of a 429 inside the dialog', async () => {
    revokeOtherSessions.mockRejectedValueOnce(axiosError(429, 'Too many requests. Please try again later.'));
    await render();
    click(container.querySelector('[data-testid="sessions-sign-out-others"]'));
    typePassword('hunter2');
    await submit();
    expect(document.querySelector('[data-testid="sessions-confirm-error"]')!.textContent).toContain('serverErrors.tooManyRequests');
  });

  it('clears the password when the dialog is cancelled', async () => {
    await render();
    const opener = container.querySelector('[data-testid="sessions-sign-out-others"]');
    click(opener);
    typePassword('hunter2');
    click(document.querySelector('[data-testid="sessions-confirm-cancel"]'));
    click(opener);
    expect(passwordInput().value).toBe('');
  });
});
