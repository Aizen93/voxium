import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Tip } from '../../components/Tip';

/** The shared help-icon tooltip used by the feature flag and rate limit pages. */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const tooltip = () => document.body.querySelector('[role="tooltip"]');

describe('Tip', () => {
  it('renders the icon and no tooltip until hovered', async () => {
    await act(async () => { root.render(<Tip text="Explains the rule" />); });

    expect(container.querySelector('.cursor-help svg')).not.toBeNull();
    expect(tooltip()).toBeNull();
  });

  it('shows the text in a tooltip portaled to the body while hovered', async () => {
    await act(async () => { root.render(<Tip text="Explains the rule" />); });
    const icon = container.querySelector('.cursor-help') as HTMLElement;

    await act(async () => {
      icon.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    });

    const shown = tooltip();
    expect(shown?.textContent).toBe('Explains the rule');
    expect(container.contains(shown)).toBe(false);
    expect((shown as HTMLElement).style.position).toBe('fixed');
  });

  it('hides the tooltip when the pointer leaves', async () => {
    await act(async () => { root.render(<Tip text="Explains the rule" />); });
    const icon = container.querySelector('.cursor-help') as HTMLElement;
    await act(async () => {
      icon.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    });
    expect(tooltip()).not.toBeNull();

    await act(async () => {
      icon.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    });

    expect(tooltip()).toBeNull();
  });
});
