import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiscoveryServer } from '@voxium/shared';

/**
 * "Request to join": the optional message is validated with the shared
 * validator BEFORE the request, sent trimmed (or not at all), and the dialog
 * survives a refusal so the text is not lost.
 */

const t = (k: string, o?: Record<string, unknown>) => (o && 'name' in o ? `${k}:${o.name}` : k);
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t }) };
});

import { JoinRequestDialog } from '../../components/discovery/JoinRequestDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const server: DiscoveryServer = {
  id: 'srv-1', name: 'Lingua Lounge', iconUrl: null, description: null, tags: [], memberCount: 3, onlineCount: 0, weeklyMessages: 0,
  joinMode: 'approval', featured: false, isMember: false, requestPending: false, createdAt: '2026-10-01T00:00:00.000Z', statsRefreshedAt: null,
};

let container: HTMLDivElement;
let root: Root;
const onSend = vi.fn();
const onClose = vi.fn();

async function render(busy = false) {
  await act(async () => { root.render(<JoinRequestDialog server={server} busy={busy} onSend={onSend} onClose={onClose} />); });
}
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const setValue = (el: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

beforeEach(() => {
  vi.clearAllMocks();
  onSend.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('JoinRequestDialog', () => {
  it('names the space, says what the moderators will see, and sends the TRIMMED message', async () => {
    await render();
    expect(q('[data-testid="join-request-dialog"]')!.textContent).toContain('discovery.request.title:Lingua Lounge');
    expect(q('[data-testid="join-request-dialog"]')!.textContent).toContain('discovery.request.description');
    await act(async () => { setValue(q('[data-testid="join-request-message"]') as HTMLTextAreaElement, '  EU evenings, can take a callout  '); });
    await act(async () => { q('[data-testid="join-request-send"]')!.click(); });
    expect(onSend).toHaveBeenCalledWith('EU evenings, can take a callout');
  });

  it('an empty message is sent as none at all', async () => {
    await render();
    await act(async () => { setValue(q('[data-testid="join-request-message"]') as HTMLTextAreaElement, '   '); });
    await act(async () => { q('[data-testid="join-request-send"]')!.click(); });
    expect(onSend).toHaveBeenCalledWith(undefined);
  });

  it('refuses a bidi override locally, shows the translated reason inline, and clears it on the next keystroke', async () => {
    await render();
    await act(async () => { setValue(q('[data-testid="join-request-message"]') as HTMLTextAreaElement, `hi${String.fromCharCode(0x202e)}`); });
    await act(async () => { q('[data-testid="join-request-send"]')!.click(); });
    expect(onSend).not.toHaveBeenCalled();
    expect(q('[data-testid="join-request-error"]')!.textContent).toBe('serverErrors.joinMessageUnsupportedChars');
    await act(async () => { setValue(q('[data-testid="join-request-message"]') as HTMLTextAreaElement, 'hi'); });
    expect(q('[data-testid="join-request-error"]')!.textContent).toBe('');
  });

  it('a refused send keeps the dialog and the draft; busy disables everything', async () => {
    onSend.mockRejectedValue(new Error('Your request was declined recently. Please try again later.'));
    await render();
    await act(async () => { setValue(q('[data-testid="join-request-message"]') as HTMLTextAreaElement, 'keep me'); });
    await act(async () => { q('[data-testid="join-request-send"]')!.click(); });
    expect(q('[data-testid="join-request-dialog"]')).not.toBeNull();
    expect((q('[data-testid="join-request-message"]') as HTMLTextAreaElement).value).toBe('keep me');
    expect(onClose).not.toHaveBeenCalled();

    await render(true);
    expect((q('[data-testid="join-request-send"]') as HTMLButtonElement).disabled).toBe(true);
    expect((q('[data-testid="join-request-message"]') as HTMLTextAreaElement).disabled).toBe(true);
    await act(async () => { q('[data-testid="join-request-send"]')!.click(); });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('closes from the X and from a click on the backdrop', async () => {
    await render();
    await act(async () => { q('[aria-label="common.close"]')!.click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => {
      q('[data-testid="join-request-dialog"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
