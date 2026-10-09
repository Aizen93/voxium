import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HeroAppMock } from '../../components/landing/HeroAppMock';

/**
 * The landing hero's product window is a scale model of the REAL app shell —
 * it is the first screenshot most visitors ever see, so it must depict the
 * current UI (2026 redesign), not the retired one.
 *
 * What these tests pin: the spaces strip (tabs along the top) exists, the old
 * vertical server rail does not, the occupied voice channel renders as a card
 * with a Join affordance, and the shell shows the user card and the floating
 * chat panel with the animated conversation.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<HeroAppMock />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('HeroAppMock (landing hero product window)', () => {
  it('shows the spaces strip: active named tab, live/unread tabs, find pill', () => {
    const strip = container.querySelector('[data-testid="app-mock-strip"]');
    expect(strip).toBeTruthy();
    expect(strip!.textContent).toContain('Voxium HQ');
    expect(strip!.textContent).toContain('Find a space');
    // Overflow chip for the long tail of spaces
    expect(strip!.textContent).toContain('+2');
    // Live-voice equalizer bars on a non-active tab
    expect(strip!.querySelector('.mock-eq-1')).toBeTruthy();
  });

  it('does not render the retired vertical server rail', () => {
    // The pre-redesign mock was a w-14 icon rail on bg-vox-sidebar.
    expect(container.querySelector('.bg-vox-sidebar')).toBeNull();
    expect(container.querySelector('.w-14')).toBeNull();
  });

  it('renders the occupied voice channel as a card with a Join affordance', () => {
    const card = container.querySelector('[data-testid="app-mock-voice-card"]');
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain('Lounge');
    expect(card!.textContent).toContain('Join voice');
    expect(card!.textContent).toContain('Alice');
    expect(card!.textContent).toContain('Bob');
  });

  it('renders the signed-in user card at the bottom of the sidebar column', () => {
    const userCard = container.querySelector('[data-testid="app-mock-user-card"]');
    expect(userCard).toBeTruthy();
    expect(userCard!.textContent).toContain('Charlie');
    expect(userCard!.textContent).toContain('Online');
  });

  it('keeps the animated conversation and message input in the chat panel', () => {
    expect(container.textContent).toContain('Hey, welcome to Voxium!');
    expect(container.textContent).toContain('Alice is typing...');
    expect(container.textContent).toContain('Message #general');
    expect(container.querySelector('.mock-msg-1')).toBeTruthy();
    expect(container.querySelector('.mock-cursor')).toBeTruthy();
  });
});
