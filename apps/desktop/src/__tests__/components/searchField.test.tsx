import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The message search is scoped to one space or one conversation, so it lives
 * as a field in that chat's header (where the loop icon was), not in the
 * sidebar column, which now carries the brand mark. Ctrl/⌘K keeps opening it
 * from anywhere. (Where it sits is pinned by searchPlacement.test.ts.)
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

import { SearchField } from '../../components/search/SearchField';

let container: HTMLDivElement;
let root: Root;
const platform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  if (platform) Object.defineProperty(Navigator.prototype, 'platform', platform);
});

const field = () => container.querySelector('[data-testid="search-field"]') as HTMLButtonElement;

describe('SearchField', () => {
  it('reads as the search box, names what it searches, and opens on click', () => {
    const onOpen = vi.fn();
    act(() => {
      root.render(<SearchField onOpen={onOpen} label="chat.searchMessages" />);
    });
    expect(field().textContent).toContain('search.placeholder');
    expect(field().getAttribute('aria-label')).toBe('chat.searchMessages');
    expect(field().getAttribute('title')).toBe('chat.searchMessages');
    expect(field().querySelector('kbd')!.textContent).toBe('common.ctrlKey K');
    act(() => {
      field().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows the command key on a Mac', () => {
    Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => 'MacIntel' });
    act(() => {
      root.render(<SearchField onOpen={() => {}} label="dm.searchMessages" />);
    });
    expect(field().querySelector('kbd')!.textContent).toBe('⌘K');
  });
});
