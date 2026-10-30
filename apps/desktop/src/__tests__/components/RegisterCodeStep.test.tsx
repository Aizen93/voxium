import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AxiosError } from 'axios';
import {
  SIGNUP, USERNAME_TAKEN_MESSAGE, SIGNUP_CODE_INVALID_MESSAGE, SIGNUP_EMAIL_REGISTERED_MESSAGE,
} from '@voxium/shared';

/**
 * The code step of the verify-first registration, rendered inside the real
 * RegisterPage over the real store (only the network, the socket and the
 * token store are mocked), in English: the e2e suite locates these exact
 * names, so the test reads them as a user does.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../services/api', () => ({ api }));
vi.mock('../../services/powSolver', () => ({ solveRegistrationPowOffThread: vi.fn() }));
const socket = vi.hoisted(() => ({ connectSocket: vi.fn(), disconnectSocket: vi.fn() }));
vi.mock('../../services/socket', () => ({
  connectSocket: socket.connectSocket,
  disconnectSocket: socket.disconnectSocket,
  getSocket: vi.fn(() => null),
  getSocketGeneration: vi.fn(() => 0),
  onSocketReady: vi.fn(() => () => {}),
  onSocketReconnect: vi.fn(() => () => {}),
  onConnectionStatusChange: vi.fn(() => () => {}),
  getConnectionStatus: vi.fn(() => 'connected'),
}));
const storage = vi.hoisted(() => ({ setTokens: vi.fn(), clearTokens: vi.fn() }));
vi.mock('../../services/tokenStorage', () => ({
  getAccessToken: vi.fn(() => null),
  setTokens: storage.setTokens,
  clearTokens: storage.clearTokens,
  isRemembered: vi.fn(() => true),
  hydrateTokens: vi.fn(async () => true),
  getTrustedDeviceToken: vi.fn(() => null),
  setTrustedDeviceToken: vi.fn(),
  clearTrustedDeviceToken: vi.fn(),
}));
vi.mock('../../components/auth/AuthBackground', () => ({ AuthBackground: () => null }));
vi.mock('../../components/auth/PeekingThief', () => ({ PeekingThief: () => null }));

import i18n from '../../i18n';
import { useAuthStore, type PendingRegistration } from '../../stores/authStore';
import { RegisterPage } from '../../pages/RegisterPage';

let container: HTMLDivElement;
let root: Root;

const user = { id: 'u-new', username: 'alice', emailVerified: true };

function pendingState(over: Partial<PendingRegistration> = {}): PendingRegistration {
  return {
    pendingId: 'p1', email: 'alice@example.com', resendAfterSeconds: SIGNUP.RESEND_AFTER_SECONDS, issuedAt: Date.now(),
    resendUsed: false, usernameTaken: false, ...over,
  };
}

function axiosError(status: number, message: string) {
  return new AxiosError('refused', 'ERR_BAD_REQUEST', undefined, undefined, {
    status, data: { success: false, error: message },
  } as never);
}

function mount(pending: PendingRegistration | null = pendingState()) {
  useAuthStore.setState({ pendingRegistration: pending });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={['/register']}>
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/login" element={<div data-testid="login-page" />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};

const text = () => container.textContent ?? '';
const codeInput = () => container.querySelector('input[aria-label="Sign-up code"]') as HTMLInputElement | null;
const button = (name: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined;
const usernameInput = () => container.querySelector('input[placeholder="Pick a username"]') as HTMLInputElement | null;

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit() {
  act(() => { button('Verify and create account')!.click(); });
  await flush();
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({
    user: null, isAuthenticated: false, isSubmitting: false, isRegistering: false,
    error: null, powProgress: null, pendingRegistration: null,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('RegisterPage — the code step', () => {
  it('replaces the form once the server accepted the registration', () => {
    mount();
    expect(container.querySelector('h1')?.textContent).toBe('Check your inbox');
    expect(text()).toContain('alice@example.com');
    expect(container.querySelector('#register-email')).toBeNull();
    expect(button('Create Account')).toBeUndefined();

    const input = codeInput()!;
    expect(input).toBeTruthy();
    expect(input.getAttribute('autocomplete')).toBe('one-time-code');
    expect(input.getAttribute('inputmode')).toBe('numeric');
    expect(input.maxLength).toBe(SIGNUP.CODE_LENGTH);
    // a text field: a number field would drop a leading zero
    expect(input.type).toBe('text');

    expect(button('Verify and create account')).toBeTruthy();
    expect(text()).toMatch(/spam/i);
    expect(text()).toContain('If you already have an account, sign in or reset your password');
    expect(container.querySelector('a[href="/login"]')).toBeTruthy();
    expect(container.querySelector('a[href="/forgot-password"]')).toBeTruthy();
  });

  it('shows the form, not the code step, while nothing is pending', () => {
    mount(null);
    expect(codeInput()).toBeNull();
    expect(container.querySelector('#register-email')).toBeTruthy();
  });

  it('keeps digits only, and submits only a complete code', async () => {
    mount();
    expect(button('Verify and create account')!.disabled).toBe(true);
    setInput(codeInput()!, '12a3');
    expect(codeInput()!.value).toBe('123');
    expect(button('Verify and create account')!.disabled).toBe(true);
    setInput(codeInput()!, '0123456789');
    expect(codeInput()!.value).toBe('012345');
    expect(button('Verify and create account')!.disabled).toBe(false);
  });

  it('a good code creates the account and signs the user in', async () => {
    api.post.mockResolvedValue({ data: { data: { user, accessToken: 'at', refreshToken: 'rt' } } });
    mount();
    setInput(codeInput()!, '012345');
    await submit();

    expect(api.post).toHaveBeenCalledWith('/auth/register/complete', { pendingId: 'p1', code: '012345' });
    expect(storage.setTokens).toHaveBeenCalledWith('at', 'rt', true);
    expect(socket.connectSocket).toHaveBeenCalledWith('at');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().pendingRegistration).toBeNull();
  });

  it('a refused code shows the translated error and keeps the step', async () => {
    api.post.mockRejectedValue(axiosError(400, SIGNUP_CODE_INVALID_MESSAGE));
    mount();
    setInput(codeInput()!, '999999');
    await submit();

    expect(text()).toContain('Invalid or expired code');
    expect(codeInput()).toBeTruthy();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('a taken username asks for another and retries with the SAME code', async () => {
    api.post.mockRejectedValueOnce(axiosError(409, USERNAME_TAKEN_MESSAGE));
    mount();
    expect(usernameInput()).toBeNull();
    setInput(codeInput()!, '424242');
    await submit();

    expect(text()).toContain('This username is already taken');
    const field = usernameInput()!;
    expect(field).toBeTruthy();
    expect(codeInput()!.value).toBe('424242');
    // no empty username goes out
    expect(button('Verify and create account')!.disabled).toBe(true);

    api.post.mockResolvedValueOnce({ data: { data: { user, accessToken: 'at', refreshToken: 'rt' } } });
    setInput(field, '  alice2 ');
    await submit();

    expect(api.post).toHaveBeenLastCalledWith('/auth/register/complete', { pendingId: 'p1', code: '424242', username: 'alice2' });
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('an address that already has an account says so, next to the way to sign in', async () => {
    api.post.mockRejectedValue(axiosError(409, SIGNUP_EMAIL_REGISTERED_MESSAGE));
    mount();
    setInput(codeInput()!, '123456');
    await submit();

    expect(text()).toContain('This email address already has an account. Sign in instead.');
    expect(container.querySelector('a[href="/login"]')).toBeTruthy();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('the resend waits for its delay, counts down, and is gone after its one use', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    api.post.mockResolvedValue({ data: { data: { pendingId: 'p1', resendAfterSeconds: SIGNUP.RESEND_AFTER_SECONDS } } });
    mount(pendingState({ issuedAt: Date.now() }));

    expect(button('Send a new code')!.disabled).toBe(true);
    expect(container.querySelector('[data-testid="register-code-countdown"]')?.textContent).toContain('10:00');

    act(() => { vi.advanceTimersByTime(61_000); });
    expect(container.querySelector('[data-testid="register-code-countdown"]')?.textContent).toContain('8:59');
    expect(button('Send a new code')!.disabled).toBe(true);

    act(() => { vi.advanceTimersByTime(SIGNUP.RESEND_AFTER_SECONDS * 1000); });
    expect(button('Send a new code')!.disabled).toBe(false);
    expect(container.querySelector('[data-testid="register-code-countdown"]')).toBeNull();

    act(() => { button('Send a new code')!.click(); });
    await flush();

    expect(api.post).toHaveBeenCalledWith('/auth/register/resend', { pendingId: 'p1' });
    expect(button('Send a new code')).toBeUndefined();
    expect(text()).toContain('use it instead of the previous one');
  });

  it('a refused resend keeps the button for another try', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.post.mockRejectedValue(axiosError(429, 'Too many requests. Please try again later.'));
    mount(pendingState({ issuedAt: Date.now() - SIGNUP.RESEND_AFTER_SECONDS * 1000 }));

    act(() => { button('Send a new code')!.click(); });
    await flush();

    expect(button('Send a new code')).toBeTruthy();
    expect(button('Send a new code')!.disabled).toBe(false);
    warn.mockRestore();
  });

  it('"Start over" brings the form back', () => {
    mount();
    act(() => { button('Start over')!.click(); });
    expect(codeInput()).toBeNull();
    expect(container.querySelector('#register-email')).toBeTruthy();
    expect(useAuthStore.getState().pendingRegistration).toBeNull();
  });
});
