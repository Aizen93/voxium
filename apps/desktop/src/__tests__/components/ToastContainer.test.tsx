import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ToastContainer } from '../../components/layout/ToastContainer';
import { useToastStore, toast } from '../../stores/toastStore';

/**
 * Toasts are how the app reports failures, and the thing that failed is
 * usually the panel currently on top: the theme editor and the marketplace
 * render at z-[9999] behind a backdrop blur, member context menus at
 * z-[10000]. At the old z-[100] a "Theme name is required" raised BY the theme
 * editor rendered UNDERNEATH it, and the user saw nothing happen at all.
 *
 * That the layer beats every OTHER layer in the app is swept for in
 * styles/zIndexLayering.test.ts; this is the rendering half.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useToastStore.setState({ toasts: [] });
});

function renderWithError() {
  act(() => {
    root.render(<ToastContainer />);
  });
  act(() => {
    toast.error('Theme name is required');
  });
  return container.querySelector('[data-testid="toast-container"]');
}

describe('ToastContainer', () => {
  it('renders the message it was given', () => {
    expect(renderWithError()).toBeTruthy();
    expect(container.textContent).toContain('Theme name is required');
  });

  it('sits on a layer no modal can cover', () => {
    const layer = renderWithError()!;
    const match = layer.className.match(/z-\[(\d+)\]/);
    expect(match, `toast layer has no explicit z-index: ${layer.className}`).toBeTruthy();
    // The tallest modal layer in the app is z-[10000] (member context menu).
    expect(Number(match![1])).toBeGreaterThan(10000);
  });

  it('renders nothing at all when there is nothing to say', () => {
    act(() => {
      root.render(<ToastContainer />);
    });
    expect(container.querySelector('[data-testid="toast-container"]')).toBeNull();
  });
});
