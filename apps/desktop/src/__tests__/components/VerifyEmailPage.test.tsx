import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AxiosError } from 'axios';

/**
 * The legacy verification link. Mail security gateways open the links in
 * incoming mail to scan them, so the page must never verify on load: only a
 * click on "Verify my email" posts the token, once.
 */

const post = vi.fn();
vi.mock('../../services/api', () => ({ api: { post: (...a: unknown[]) => post(...a) } }));

const checkAuth = vi.fn();
vi.mock('../../stores/authStore', () => {
  const state = () => ({ user: null, checkAuth });
  const useAuthStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useAuthStore.getState = state;
  return { useAuthStore };
});

import i18n from '../../i18n';
import { VerifyEmailPage, _resetProcessedTokensForTests } from '../../pages/VerifyEmailPage';

let container: HTMLDivElement;
let root: Root;

function mount(path = '/verify-email/TOKEN') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/verify-email/:token" element={<VerifyEmailPage />} />
          <Route path="/verify-email/" element={<VerifyEmailPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

function unmount() {
  act(() => root.unmount());
  container.remove();
}

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};

const text = () => container.textContent ?? '';
const verifyButton = () =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Verify my email') as HTMLButtonElement | undefined;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

beforeEach(() => {
  post.mockReset();
  checkAuth.mockReset();
  _resetProcessedTokensForTests();
});

afterEach(() => {
  if (container?.isConnected) unmount();
});

describe('VerifyEmailPage', () => {
  it('sends nothing on load: it shows the button', async () => {
    mount();
    await flush();
    expect(post).not.toHaveBeenCalled();
    expect(verifyButton()).toBeTruthy();
  });

  it('posts the token on click, then reports success and refreshes the session', async () => {
    post.mockResolvedValue({ data: { success: true } });
    mount();
    act(() => { verifyButton()!.click(); });
    await flush();

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/auth/verify-email', { token: 'TOKEN' });
    expect(text()).toContain('Your email has been verified successfully!');
    expect(checkAuth).toHaveBeenCalledTimes(1);
    expect(verifyButton()).toBeUndefined();
  });

  it('never posts the same token twice, across a remount too', async () => {
    post.mockImplementation(() => new Promise(() => {}));
    mount();
    act(() => { verifyButton()!.click(); });
    expect(post).toHaveBeenCalledTimes(1);
    unmount();

    // A StrictMode remount, or the same link opened again in this session
    mount();
    act(() => { verifyButton()!.click(); });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('a server refusal shows the reason and offers no retry', async () => {
    post.mockRejectedValue(new AxiosError('refused', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 400, data: { success: false, error: 'Invalid or expired verification link' },
    } as never));
    mount();
    act(() => { verifyButton()!.click(); });
    await flush();

    expect(text()).toContain('Invalid or expired verification link');
    expect(text()).not.toContain('Your email has been verified');
    expect(verifyButton()).toBeUndefined();
  });

  it('a request that got no answer brings the button back and can be retried', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    post.mockRejectedValueOnce(new AxiosError('Network Error', 'ERR_NETWORK'));
    mount();
    act(() => { verifyButton()!.click(); });
    await flush();

    expect(verifyButton()).toBeTruthy();
    expect(warn).toHaveBeenCalled();

    post.mockResolvedValueOnce({ data: { success: true } });
    act(() => { verifyButton()!.click(); });
    await flush();
    expect(post).toHaveBeenCalledTimes(2);
    expect(text()).toContain('Your email has been verified successfully!');
    warn.mockRestore();
  });

  it('a link without a token says so and sends nothing', async () => {
    mount('/verify-email/');
    await flush();
    expect(post).not.toHaveBeenCalled();
    expect(verifyButton()).toBeUndefined();
    expect(text()).toContain('Missing verification token.');
  });
});
