import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Avatar } from '../../components/common/Avatar';

/**
 * Avatar shape contract: squared (the v2 look) everywhere by default, a true
 * circle on profile surfaces that ask for one — the hover profile popup wraps
 * the avatar in a circular ring, and a squared avatar inside a round ring is
 * exactly the mismatch this pins against.
 */

let container: HTMLDivElement;
let root: Root;

function render(el: React.ReactElement) {
  act(() => {
    root.render(el);
  });
}
const avatarEl = () => container.firstElementChild as HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Avatar shape', () => {
  it('defaults to the squared v2 look', () => {
    render(<Avatar displayName="Mara" size="lg" />);
    expect(avatarEl().className).toContain('rounded-2xl');
    expect(avatarEl().className).not.toContain('rounded-full');
  });

  it('renders a true circle when shape="circle"', () => {
    render(<Avatar displayName="Mara" size="lg" shape="circle" />);
    expect(avatarEl().className).toContain('rounded-full');
    expect(avatarEl().className).not.toContain('rounded-2xl');
  });

  it('keeps the circle on image avatars too, not just the initials fallback', () => {
    render(<Avatar avatarUrl="avatars/x.webp" displayName="Mara" shape="circle" />);
    const img = container.querySelector('img')!;
    expect(img).toBeTruthy();
    expect(img.className).toContain('rounded-full');
  });
});
