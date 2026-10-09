import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The create-or-join modal's hand-over to Explore: a "Browse public spaces"
 * link in the join half, only when the parent can open Explore.
 */

const t = (k: string) => k;
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t }) };
});
vi.mock('../../stores/serverStore', () => {
  const state = () => ({ createServer: vi.fn(), setActiveServer: vi.fn(), joinServer: vi.fn(), uploadServerIcon: vi.fn() });
  const useServerStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) => (sel ? sel(state()) : state());
  useServerStore.getState = state;
  return { useServerStore };
});
vi.mock('../../stores/toastStore', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../../components/common/ImageUploadButton', () => ({ ImageUploadButton: () => null }));

import { CreateServerModal } from '../../components/server/CreateServerModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();
const onExplore = vi.fn();
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
const joinTab = () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'server.create.joinExisting')!;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('CreateServerModal — Explore hand-over', () => {
  it('offers Browse public spaces in the join half and hands over (closing itself first)', () => {
    act(() => { root.render(<CreateServerModal onClose={onClose} onExplore={onExplore} />); });
    expect(q('[data-testid="create-modal-explore"]')).toBeNull(); // the create half
    act(() => { joinTab().click(); });
    const link = q('[data-testid="create-modal-explore"]')!;
    expect(link.textContent).toBe('discovery.browsePublic');
    act(() => { link.click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onExplore).toHaveBeenCalledTimes(1);
  });

  it('shows no link when the parent cannot open Explore', () => {
    act(() => { root.render(<CreateServerModal onClose={onClose} />); });
    act(() => { joinTab().click(); });
    expect(q('[data-testid="create-modal-explore"]')).toBeNull();
  });
});
