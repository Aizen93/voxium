import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The hover card of a person: never opened for the deleted-account
 * placeholder (`deleted:{conversationId}`, which names nobody: no profile
 * request, no member lookup), and closed from outside when that person's
 * account turns out to be deleted (utils/profilePopupBus.ts).
 */

const popup = vi.hoisted(() => ({ rendered: vi.fn() }));
vi.mock('../../components/common/UserProfilePopup', () => ({
  UserProfilePopup: ({ userId }: { userId: string }) => {
    popup.rendered(userId);
    return <div data-testid="profile-popup" data-user-id={userId} />;
  },
}));

import { UserHoverTarget } from '../../components/common/UserHoverTarget';
import { closeProfilePopupsOf } from '../../utils/profilePopupBus';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  popup.rendered.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function hover(el: Element) {
  act(() => { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
  act(() => { vi.advanceTimersByTime(400); });
}

describe('UserHoverTarget', () => {
  it('the placeholder: children only, no hover card however long the pointer stays', () => {
    act(() => root.render(<UserHoverTarget userId="deleted:conv-1"><span data-testid="name">x</span></UserHoverTarget>));
    hover(container.querySelector('[data-testid="name"]')!);
    expect(container.querySelector('[data-testid="profile-popup"]')).toBeNull();
    expect(popup.rendered).not.toHaveBeenCalled();
  });

  it('a person: the card opens on hover, and closes when that person\'s cards are closed from outside', () => {
    act(() => root.render(<UserHoverTarget userId="u-alice"><span data-testid="name">Alice</span></UserHoverTarget>));
    hover(container.querySelector('[data-testid="name"]')!);
    expect(container.querySelector('[data-testid="profile-popup"]')).not.toBeNull();

    act(() => closeProfilePopupsOf('u-bob'));
    expect(container.querySelector('[data-testid="profile-popup"]')).not.toBeNull();

    act(() => closeProfilePopupsOf('u-alice'));
    expect(container.querySelector('[data-testid="profile-popup"]')).toBeNull();
  });
});
