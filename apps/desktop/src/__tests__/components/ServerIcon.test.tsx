import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ServerIcon, hueFor } from '../../components/server/ServerIcon';

/**
 * The generated icon is what makes a dense rail scannable — most servers have
 * no uploaded image, and a column of identical grey chips is unreadable.
 *
 * Two properties carry that: the colour must be STABLE for a given server (or
 * it changes every render and stops being a landmark), and it must stay inside
 * the logo's violet-to-blue arc (or a rail of lime and orange chips sits next
 * to a violet logo).
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: React.ReactNode) {
  act(() => root.render(node));
  return container.firstElementChild as HTMLElement;
}

describe('ServerIcon', () => {
  it('shows up to two initials for a multi-word name', () => {
    const el = render(<ServerIcon id="a" name="Design Guild" />);
    expect(el.textContent).toBe('DG');
  });

  it('handles one-word and extra-word names without overflowing', () => {
    expect(render(<ServerIcon id="a" name="Cooking" />).textContent).toBe('C');
    expect(render(<ServerIcon id="b" name="A Very Long Server Name" />).textContent).toBe('AV');
  });

  it('does not render an empty chip for a blank name', () => {
    expect(render(<ServerIcon id="a" name="   " />).textContent).toBe('?');
  });

  /**
   * The colour rules are asserted on the pure function rather than the rendered
   * element. jsdom's CSSOM rejects `linear-gradient(... hsl(...))` outright, so
   * the gradient never reaches the DOM in tests — an earlier version of this
   * file scraped it from the element, found nothing, and "passed" 200
   * iterations without checking anything.
   */
  it('gives the same server the same hue every time', () => {
    // A landmark that changes colour is not a landmark.
    expect(hueFor('server-42')).toBe(hueFor('server-42'));
  });

  it('gives different servers different hues', () => {
    const hues = new Set(['alpha', 'bravo', 'charlie', 'delta', 'echo'].map(hueFor));
    expect(hues.size).toBeGreaterThan(1);
  });

  it('stays inside the brand arc, never wandering into green or orange', () => {
    // Base hue is constrained to blue(217)..violet(262), and the gradient's
    // second stop sits 18deg below the first, so nothing may fall outside
    // 199..262 — the range that still reads as "the logo's family".
    for (let i = 0; i < 500; i++) {
      const hue = hueFor(`server-${i}`);
      expect(hue).toBeGreaterThanOrEqual(217);
      expect(hue).toBeLessThanOrEqual(262);
      expect(hue - 18).toBeGreaterThanOrEqual(199);
    }
  });

  it('spreads ids across the arc instead of clumping on one hue', () => {
    // A hash that returned the same value for everything would satisfy every
    // assertion above and make the whole feature pointless.
    const spread = new Set(Array.from({ length: 300 }, (_, i) => hueFor(`s-${i}`)));
    expect(spread.size).toBeGreaterThan(20);
  });

  it('prefers a real icon when the server has one', () => {
    const el = render(<ServerIcon id="a" name="Design Guild" iconUrl="icons/abc.png" />);
    expect(el.tagName).toBe('IMG');
    expect(el.getAttribute('src')).toContain('icons/abc.png');
  });

  it('falls back to initials when that image fails to load', () => {
    // Broken/expired icon keys must not leave a blank hole in the rail.
    const el = render(<ServerIcon id="a" name="Design Guild" iconUrl="icons/gone.png" />);
    act(() => {
      el.dispatchEvent(new Event('error'));
    });
    expect(container.firstElementChild?.textContent).toBe('DG');
  });
});
