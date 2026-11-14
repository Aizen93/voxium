// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../../components/landing/publicPages.css', import.meta.url), 'utf8');

describe('public landing styles', () => {
  it('keeps navigation link styles with the shared landing chrome', () => {
    const landing = readFileSync(new URL('../../pages/LandingPage.tsx', import.meta.url), 'utf8');
    expect(landing).toMatch(/\.lp-public-nav-link\s*\{/);
    expect(landing).toContain(".lp-public-nav-link[aria-current='page']");
    expect(landing).toContain('.lp-public-nav-link:focus-visible');
    expect(landing).toMatch(/@media \(pointer: coarse\)\s*\{\s*\.lp-public-nav-link\s*\{[^}]*min-height: 44px;/);
    expect(styles).not.toContain('.lp-public-nav-link');
  });

  it('declares grid tracks and highlight colors before their modern overrides', () => {
    const rows = styles.match(/\.lp-public-map-row\s*\{([^}]+)\}/)?.[1];
    expect(rows).toMatch(/grid-template-columns:\s*var\(--map-route-columns\);\s*grid-template-columns:\s*subgrid;/);
    expect(styles.match(/--map-route-columns:\s*minmax\([^;]+;/g)).toHaveLength(2);

    const highlight = styles.match(/\.lp-public-destination\[data-active='true'\]\s*\{([^}]+)\}/)?.[1];
    expect(highlight).toMatch(/border-color:\s*var\(--signal\);/);
    expect(highlight).toMatch(/background:\s*#[0-9a-f]{6};/);
    expect(styles).toMatch(/@supports \(color: color-mix\(in srgb, black, white\)\)\s*\{\s*\.lp-public-destination\[data-active='true'\]\s*\{[^}]*color-mix\(/);
  });
});
