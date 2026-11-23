import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});
vi.mock('../../services/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
vi.mock('../../stores/chatStore', () => ({ useChatStore: { getState: () => ({ clearMessages: vi.fn() }) } }));

import { DMListFooter } from '../../components/dm/DMListFooter';
import { useDMStore } from '../../stores/dmStore';

const loadMore = vi.fn(async () => {});
let container: HTMLDivElement;
let root: Root;
const observers: Array<{ callback: (entries: Array<{ isIntersecting: boolean }>) => void; disconnect: ReturnType<typeof vi.fn> }> = [];

async function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<DMListFooter />));
}
const button = () => container.querySelector('[data-testid="dm-list-more"]') as HTMLButtonElement | null;

beforeEach(() => {
  loadMore.mockClear();
  observers.length = 0;
  vi.stubGlobal('IntersectionObserver', class {
    disconnect = vi.fn();
    observe = vi.fn();
    constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
      observers.push({ callback, disconnect: this.disconnect });
    }
  });
  useDMStore.setState({ listNextCursor: 'cur', isLoadingMore: false, loadMoreFailed: false, conversations: [], loadMoreConversations: loadMore });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('the end of the conversation list', () => {
  it('shows nothing once the whole list is loaded (no cursor)', async () => {
    useDMStore.setState({ listNextCursor: null });
    await render();
    expect(container.querySelector('[data-testid="dm-list-footer"]')).toBeNull();
  });

  it('offers a "load more" button that a keyboard reaches and that loads the next page', async () => {
    await render();
    const b = button()!;
    expect(b.textContent).toBe('dm.list.loadMore');
    expect(b.disabled).toBe(false);
    expect(b.tabIndex).toBe(0);
    b.focus();
    expect(document.activeElement).toBe(b);
    await act(async () => { b.click(); });
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('loading: the button stays mounted and focused, aria-disabled (never disabled) and busy, and a click loads nothing', async () => {
    await render();
    const before = button()!;
    before.focus();
    await act(async () => { useDMStore.setState({ isLoadingMore: true }); });
    const b = button()!;
    expect(b).toBe(before);
    expect(document.activeElement).toBe(b);
    expect(b.disabled).toBe(false);
    expect(b.getAttribute('aria-disabled')).toBe('true');
    expect(b.getAttribute('aria-busy')).toBe('true');
    expect(b.textContent).toBe('common.loading');
    await act(async () => { b.click(); });
    expect(loadMore).not.toHaveBeenCalled();
  });

  it('the status region is mounted before the failure and the same element then carries its text', async () => {
    await render();
    const region = container.querySelector('[data-testid="dm-list-more-failed"]')!;
    expect(region.getAttribute('role')).toBe('status');
    expect(region.textContent).toBe('');
    await act(async () => { useDMStore.setState({ loadMoreFailed: true }); });
    expect(container.querySelector('[data-testid="dm-list-more-failed"]')).toBe(region);
    expect(region.textContent).toBe('dm.list.loadMoreFailed');
  });

  it('failure: says so and offers the retry, and loads nothing by itself', async () => {
    useDMStore.setState({ loadMoreFailed: true });
    await render();
    expect(container.querySelector('[data-testid="dm-list-more-failed"]')!.textContent).toBe('dm.list.loadMoreFailed');
    expect(button()!.textContent).toBe('dm.list.loadMoreRetry');
    expect(observers).toHaveLength(0);
    await act(async () => { button()!.click(); });
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('the end of the list scrolling into view loads the next page; a sentinel out of view loads nothing', async () => {
    await render();
    expect(observers).toHaveLength(1);
    await act(async () => { observers[0].callback([{ isIntersecting: false }]); });
    expect(loadMore).not.toHaveBeenCalled();
    await act(async () => { observers[0].callback([{ isIntersecting: true }]); });
    expect(loadMore).toHaveBeenCalledTimes(1);
  });
});
