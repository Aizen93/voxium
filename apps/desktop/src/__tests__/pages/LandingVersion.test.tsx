import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { APP_VERSION } from '@voxium/shared';

// The landing page shows the running version (owner, 2026-11-08): a badge next
// to the download buttons and in the footer, linking to that version's release.
// APP_VERSION reads the shared package's manifest, so the release bump moves it.

import { VersionBadge, RELEASE_URL } from '../../pages/LandingPage';

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

describe('VersionBadge', () => {
  it('shows the running version and links to that release, in a new tab without a referrer', () => {
    act(() => { root.render(<VersionBadge />); });
    const badge = container.querySelector('[data-testid="landing-version"]') as HTMLAnchorElement;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe(`v${APP_VERSION}`);
    expect(badge.getAttribute('href')).toBe(RELEASE_URL);
    expect(RELEASE_URL).toBe(`https://github.com/Aizen93/voxium/releases/tag/v${APP_VERSION}`);
    expect(badge.getAttribute('target')).toBe('_blank');
    expect(badge.getAttribute('rel')).toBe('noopener noreferrer');
    // language-neutral on purpose: no translation key to keep in 11 locales
    expect(badge.textContent).toMatch(/^v\d+\.\d+\.\d+/);
  });

  it('takes extra classes for its placement', () => {
    act(() => { root.render(<VersionBadge className="self-center" />); });
    expect(container.querySelector('[data-testid="landing-version"]')!.className).toContain('self-center');
  });
});
