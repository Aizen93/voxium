import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { THEME_COLOR_KEYS, BUILT_IN_THEME_IDS } from '@voxium/shared';

/**
 * The brand palette, asserted rather than eyeballed.
 *
 * Voxium's brand look is the DARK theme: deep indigo surfaces around Electric
 * Sapphire (#5B5BF7), with Soft Periwinkle (#8D8DF2) mixed into every
 * translucent layer and Wisteria Blue (#7D9BF5) for links. Two regressions
 * have actually shipped to this branch and are cheap to re-introduce: the
 * default quietly flipping to a different theme, and a "rework the Voxium
 * theme" pass that rewrites the OTHER built-in themes alongside it. Both are
 * pinned here.
 */

const ROOT = resolve(__dirname, '../../..');
const css = readFileSync(resolve(ROOT, 'src/styles/themes.css'), 'utf8');
const settings = readFileSync(resolve(ROOT, 'src/stores/settingsStore.ts'), 'utf8');

/** Pull one theme's authored custom properties out of themes.css. */
function themeBlock(id: string): Record<string, string> {
  const start = css.indexOf(`[data-theme="${id}"] {`);
  expect(start, `theme ${id} is missing`).toBeGreaterThan(-1);
  const end = css.indexOf('}', start);
  const body = css.slice(start, end);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--vox-([a-z0-9-]+):\s*([^;]+);/g)) {
    out[m[1]] = m[2].split('/*')[0].trim();
  }
  return out;
}

function srgb(c: number) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((ch) => ch + ch).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}
function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe('the Voxium brand theme (dark)', () => {
  const dark = themeBlock('dark');

  it('is what a fresh install gets', () => {
    expect(settings).toMatch(/theme: 'dark',/);
    expect(settings).toMatch(/let theme: ThemeId = 'dark';/);
    expect(settings).not.toMatch(/let theme: ThemeId = 'light';/);
  });

  it('is what the theme picker offers first', () => {
    const list = settings.slice(settings.indexOf('export const THEMES'));
    expect(list.indexOf("id: 'dark'")).toBeLessThan(list.indexOf("id: 'light'"));
  });

  it('is built on the supplied swatches, not on grey or invented violet', () => {
    expect(dark['accent-primary']).toBe('#5b5bf7'); // Electric Sapphire
    expect(dark['text-link']).toBe('#7d9bf5'); // Wisteria Blue
    // Every translucent layer is mixed from Soft Periwinkle — that is what
    // keeps the dark UI indigo rather than grey.
    for (const key of ['bg-hover', 'bg-active', 'border', 'scrollbar-thumb']) {
      expect(dark[key], key).toMatch(/rgba\(141, 141, 242/);
    }
  });

  it('keeps its surfaces dark — this is not a light product', () => {
    for (const key of ['bg-primary', 'bg-secondary', 'bg-tertiary', 'chat', 'sidebar', 'bg-floating']) {
      expect(luminance(dark[key]), `${key} should be a dark surface`).toBeLessThan(0.05);
    }
  });

  it('keeps the original signature surface as the reading panel', () => {
    // #1a1a2e is the hex Voxium has always been — the rework restructures
    // around it, it does not replace it.
    expect(dark['chat']).toBe('#1a1a2e');
  });

  it('keeps text readable on the surface it actually sits on', () => {
    for (const surface of ['chat', 'bg-primary'] as const) {
      for (const ink of ['text-primary', 'text-secondary'] as const) {
        const ratio = contrast(dark[ink], dark[surface]);
        expect(ratio, `${ink} on ${surface} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
      // Muted is metadata (timestamps, section labels) — AA-large is the bar.
      const muted = contrast(dark['text-muted'], dark[surface]);
      expect(muted, `text-muted on ${surface} = ${muted.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
  });

  it('carries legible white ink on accent-filled controls', () => {
    // The shared default in :root — the sapphire is deep enough that dark ink
    // would fail on it, and white is what the app has always used.
    expect(css).toMatch(/--vox-on-accent:\s*#ffffff/);
    expect(contrast('#ffffff', dark['accent-primary'])).toBeGreaterThanOrEqual(3);
  });

  it('keeps danger/success/warning distinguishable against the panel', () => {
    for (const key of ['accent-danger', 'accent-success', 'accent-warning'] as const) {
      expect(contrast(dark[key], dark.chat), key).toBeGreaterThanOrEqual(3);
    }
  });

  it('exposes the brand gradient from the supplied swatches', () => {
    expect(css).toMatch(/--vox-brand-from:\s*#5b5bf7/);
    expect(css).toMatch(/--vox-brand-via:\s*#a08bf0/);
    expect(css).toMatch(/--vox-brand-to:\s*#7d9bf5/);
  });
});

describe('the other built-in themes', () => {
  it('are untouched — only the Voxium theme was reworked', () => {
    // Spot-pinned to their pre-redesign values. If one of these fails, a
    // "rework the default theme" pass has leaked into a theme it was told
    // to leave alone.
    const light = themeBlock('light');
    expect(light['bg-primary']).toBe('#f2f3f5');
    expect(light['accent-primary']).toBe('#5b5bf7');
    expect(light['border']).toBe('#c8c8d8');

    const midnight = themeBlock('midnight');
    expect(midnight['bg-primary']).toBe('#0a0a12');
    expect(midnight['accent-primary']).toBe('#2090ff');

    const tactical = themeBlock('tactical');
    expect(tactical['bg-primary']).toBe('#161816');
    expect(tactical['accent-primary']).toBe('#4ade50');
  });

  it('leaves every built-in theme complete, so none renders half-styled', () => {
    for (const id of BUILT_IN_THEME_IDS) {
      const block = themeBlock(id);
      for (const key of THEME_COLOR_KEYS) {
        expect(block[key], `${id} is missing --vox-${key}`).toBeTruthy();
      }
    }
  });
});
