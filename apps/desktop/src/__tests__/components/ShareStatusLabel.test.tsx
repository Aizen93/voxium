import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The share stage's header line. The sharer's own line is red with a pulsing
// recording dot: on Windows the app hides WebView2's share bar, so this is the
// one indicator that the screen is leaving the machine (owner, 2026-11-08).

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string, opts?: { name?: string }) => (opts?.name ? `${key}:${opts.name}` : key) }),
  };
});

import { ShareStatusLabel } from '../../components/voice/ShareStatusLabel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe('ShareStatusLabel', () => {
  it('the sharer sees a red line with a pulsing red dot, announced as a status', () => {
    act(() => { root.render(<ShareStatusLabel isLocalSharing sharerName="Alice" />); });
    const line = container.querySelector('[data-testid="sharing-indicator"]')!;
    expect(line).not.toBeNull();
    expect(line.textContent).toContain('voice.youAreSharing');
    expect(line.getAttribute('role')).toBe('status');
    expect(line.className).toContain('text-vox-accent-danger');
    expect(line.className).toContain('font-semibold');
    const dot = line.querySelector('[data-testid="sharing-indicator-dot"]')!;
    expect(dot).not.toBeNull();
    expect(dot.getAttribute('aria-hidden')).toBe('true');
    const fills = Array.from(dot.querySelectorAll('span')).map((s) => s.className);
    expect(fills).toHaveLength(2);
    expect(fills.every((c) => c.includes('bg-vox-accent-danger') && c.includes('rounded-full'))).toBe(true);
    // the halo pulses only for users who have not asked for reduced motion
    expect(fills.some((c) => c.includes('motion-safe:animate-ping'))).toBe(true);
  });

  it("a viewer's line names the sharer and stays neutral: no red, no dot", () => {
    act(() => { root.render(<ShareStatusLabel isLocalSharing={false} sharerName="Alice" />); });
    expect(container.textContent).toBe('voice.userIsSharing:Alice');
    expect(container.querySelector('[data-testid="sharing-indicator"]')).toBeNull();
    expect(container.querySelector('[data-testid="sharing-indicator-dot"]')).toBeNull();
    expect(container.innerHTML).not.toContain('text-vox-accent-danger');
  });
});
