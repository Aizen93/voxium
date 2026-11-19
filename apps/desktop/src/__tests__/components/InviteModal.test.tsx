import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The invite dialog shows and copies a link to the web client's
 * /invite/:code page, built by utils/webClientUrl.ts: in a browser on the
 * page's own origin, never on VITE_WS_URL (the API server, which has no
 * such page).
 */

const t = (k: string) => k;
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t }) };
});
const { createInvite } = vi.hoisted(() => ({ createInvite: vi.fn() }));
vi.mock('../../stores/serverStore', () => {
  const state = () => ({ createInvite });
  const useServerStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useServerStore.getState = state;
  return { useServerStore };
});

import { InviteModal } from '../../components/server/InviteModal';
import { resetWebClientBaseForTests } from '../../utils/webClientUrl';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  resetWebClientBaseForTests();
  vi.stubEnv('VITE_WS_URL', 'https://api.example.com');
  createInvite.mockResolvedValue('UsLnacI8');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllEnvs();
  resetWebClientBaseForTests();
});

async function open() {
  await act(async () => { root.render(<InviteModal serverId="s1" onClose={() => {}} />); });
  return container.querySelector('input[readonly]') as HTMLInputElement;
}

describe('InviteModal', () => {
  it('shows the link on the web client\'s origin (this page), not the API server\'s', async () => {
    const input = await open();
    expect(createInvite).toHaveBeenCalledWith('s1');
    expect(input.value).toBe(`${window.location.origin}/invite/UsLnacI8`);
    expect(input.value).not.toContain('api.example.com');
  });

  it('copies that same link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await open();
    const copy = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('common.copy'))!;
    await act(async () => { copy.click(); });
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/invite/UsLnacI8`);
  });
});
