import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AxiosError } from 'axios';

/**
 * "Not you? Block Voxium mail to this address": the page a victim of a bot
 * registration lands on from the e-mail. It holds nothing but the token in
 * the URL, asks the server whether that mailbox is blocked, and one click
 * blocks it or allows it again. The address is never on screen.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }) };
});

const post = vi.fn();
vi.mock('../../services/api', () => ({ api: { post: (...a: unknown[]) => post(...a) } }));

import { MailBlockPage } from '../../pages/MailBlockPage';

let container: HTMLDivElement;
let root: Root;

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

function mount(path = '/mail-block/TOKEN') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/mail-block/:token" element={<MailBlockPage />} />
          <Route path="/" element={<div data-testid="home" />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const text = () => container.textContent ?? '';
const http = (status: number) => new AxiosError('refused', 'ERR_BAD_REQUEST', undefined, undefined, { status, data: {} } as never);

beforeEach(() => {
  post.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('MailBlockPage', () => {
  it('asks the status with the token from the URL and offers to block an unblocked mailbox', async () => {
    post.mockResolvedValueOnce({ data: { success: true, data: { blocked: false } } });
    mount('/mail-block/TOK-123');
    expect(byId('mail-block-checking')).not.toBeNull();
    await flush();

    expect(post).toHaveBeenCalledWith('/auth/mail-block/status', { token: 'TOK-123' });
    expect(byId('mail-block-checking')).toBeNull();
    expect(byId('mail-block-status')?.textContent).toBe('auth.mailBlock.intro');
    expect(byId('mail-block-action')?.textContent).toBe('auth.mailBlock.block');
    expect(text()).toContain('auth.mailBlock.note');
  });

  it('one click blocks: posts the token, shows the done banner and flips the button to "allow"', async () => {
    post.mockResolvedValueOnce({ data: { success: true, data: { blocked: false } } });
    mount();
    await flush();

    post.mockResolvedValueOnce({ data: { success: true, data: { blocked: true } } });
    act(() => byId('mail-block-action')!.click());
    expect(byId('mail-block-action')?.textContent).toBe('auth.mailBlock.working');
    expect((byId('mail-block-action') as HTMLButtonElement).disabled).toBe(true);
    await flush();

    expect(post).toHaveBeenLastCalledWith('/auth/mail-block', { token: 'TOKEN' });
    expect(byId('mail-block-done')?.textContent).toBe('auth.mailBlock.blockedDone');
    expect(byId('mail-block-action')?.textContent).toBe('auth.mailBlock.allow');
    expect((byId('mail-block-action') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a blocked mailbox is told so and can be allowed again from the same link', async () => {
    post.mockResolvedValueOnce({ data: { success: true, data: { blocked: true } } });
    mount();
    await flush();

    expect(byId('mail-block-status')?.textContent).toBe('auth.mailBlock.blockedIntro');
    expect(byId('mail-block-action')?.textContent).toBe('auth.mailBlock.allow');

    post.mockResolvedValueOnce({ data: { success: true, data: { blocked: false } } });
    act(() => byId('mail-block-action')!.click());
    await flush();

    expect(post).toHaveBeenLastCalledWith('/auth/mail-unblock', { token: 'TOKEN' });
    expect(byId('mail-block-done')?.textContent).toBe('auth.mailBlock.allowedDone');
    expect(byId('mail-block-action')?.textContent).toBe('auth.mailBlock.block');
  });

  it('a 400 means the link itself is refused: no retry, a way home', async () => {
    post.mockRejectedValueOnce(http(400));
    mount();
    await flush();

    expect(text()).toContain('auth.mailBlock.invalidLink');
    expect(byId('mail-block-retry')).toBeNull();
    expect(byId('mail-block-action')).toBeNull();
    expect(container.querySelector('a[href="/"]')).not.toBeNull();
  });

  it('a transport or server failure offers a retry that asks the status again', async () => {
    post.mockRejectedValueOnce(new Error('network'));
    mount();
    await flush();
    expect(text()).toContain('auth.mailBlock.failed');

    post.mockResolvedValueOnce({ data: { success: true, data: { blocked: false } } });
    act(() => byId('mail-block-retry')!.click());
    await flush();

    expect(post).toHaveBeenCalledTimes(2);
    expect(byId('mail-block-action')?.textContent).toBe('auth.mailBlock.block');
  });

  it('a failed click is reported the same way, and a 400 on the click reads as an expired link', async () => {
    post.mockResolvedValueOnce({ data: { success: true, data: { blocked: false } } });
    mount();
    await flush();

    post.mockRejectedValueOnce(http(500));
    act(() => byId('mail-block-action')!.click());
    await flush();
    expect(text()).toContain('auth.mailBlock.failed');

    post.mockResolvedValueOnce({ data: { success: true, data: { blocked: false } } });
    act(() => byId('mail-block-retry')!.click());
    await flush();
    post.mockRejectedValueOnce(http(400));
    act(() => byId('mail-block-action')!.click());
    await flush();
    expect(text()).toContain('auth.mailBlock.invalidLink');
  });

  it('never shows an address: the page only ever has the token', async () => {
    post.mockResolvedValueOnce({ data: { success: true, data: { blocked: false, email: 'victim@example.com' } } });
    mount();
    await flush();
    expect(text()).not.toContain('victim@example.com');
    expect(text()).not.toContain('TOKEN');
  });
});
