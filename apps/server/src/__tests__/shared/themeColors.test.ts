import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  THEME_COLOR_KEYS,
  TRANSLUCENT_THEME_COLOR_KEYS,
  allowsAlphaThemeColor,
  isValidThemeColorValue,
  validateThemeColors,
} from '@voxium/shared';

/**
 * Theme color validation, and the bug it shipped: the rule was hex-only for
 * every key except `selection-*`, written when every built-in palette was
 * opaque. The 2026 redesign then made hover, active, hairline borders and
 * scrollbars translucent BY DESIGN — so "Start from: Dark" in the theme editor
 * produced a palette that saved locally and was rejected on publish with
 * `Invalid color value for "bg-hover"`. Importing such a theme from JSON hit
 * the same wall.
 *
 * The line drawn now: a key that paints ON a surface may carry alpha; a key
 * that IS a surface may not (a translucent panel would show the layer behind
 * a thing meant to be solid).
 *
 * The last test reads the real stylesheet, so a future palette that makes a
 * NEW key translucent fails here rather than in a user's publish dialog.
 */

const THEMES_CSS = fileURLToPath(
  new URL('../../../../desktop/src/styles/themes.css', import.meta.url),
);

function palette(overrides: Record<string, string> = {}): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const key of THEME_COLOR_KEYS) colors[key] = '#1a1a2e';
  return { ...colors, ...overrides };
}

describe('allowsAlphaThemeColor', () => {
  it('covers exactly the layers that paint on top of a surface', () => {
    expect([...TRANSLUCENT_THEME_COLOR_KEYS].sort()).toEqual(
      ['bg-active', 'bg-hover', 'border', 'scrollbar-thumb', 'scrollbar-thumb-hover', 'selection-bg', 'selection-text'].sort(),
    );
    for (const key of TRANSLUCENT_THEME_COLOR_KEYS) expect(allowsAlphaThemeColor(key)).toBe(true);
  });

  it('does not let an opaque surface go translucent', () => {
    for (const key of ['bg-primary', 'bg-secondary', 'bg-tertiary', 'bg-floating', 'sidebar', 'channel', 'chat']) {
      expect(allowsAlphaThemeColor(key), `${key} must stay opaque`).toBe(false);
    }
  });

  it('is a closed set — an unknown key gets no alpha', () => {
    expect(allowsAlphaThemeColor('not-a-key')).toBe(false);
    expect(allowsAlphaThemeColor('')).toBe(false);
  });
});

describe('isValidThemeColorValue', () => {
  it('takes hex everywhere', () => {
    for (const key of THEME_COLOR_KEYS) {
      expect(isValidThemeColorValue(key, '#5b5bf7'), key).toBe(true);
    }
  });

  it('takes rgba() on translucent keys and refuses it elsewhere', () => {
    expect(isValidThemeColorValue('bg-hover', 'rgba(141, 141, 242, 0.08)')).toBe(true);
    expect(isValidThemeColorValue('border', 'rgba(141, 141, 242, 0.12)')).toBe(true);
    expect(isValidThemeColorValue('chat', 'rgba(26, 26, 46, 0.5)')).toBe(false);
    expect(isValidThemeColorValue('bg-primary', 'rgba(0, 0, 0, 1)')).toBe(false);
  });

  it('still refuses anything that is not a color', () => {
    // The loosening must not become "any string on these keys" — these values
    // are written straight into a CSS custom property.
    for (const bad of [
      'red',
      'url(evil)',
      'rgba(300, 0, 0, 1)',
      'rgba(0,0,0,2)',
      'rgb(1, 2, 3)',
      '#fff',
      '#5b5bf7; background: url(x)',
      'rgba(141, 141, 242, 0.08) !important',
      'var(--x)',
      '',
    ]) {
      expect(isValidThemeColorValue('bg-hover', bad), `accepted ${JSON.stringify(bad)}`).toBe(false);
    }
    expect(isValidThemeColorValue('bg-hover', 42)).toBe(false);
    expect(isValidThemeColorValue('bg-hover', null)).toBe(false);
  });
});

describe('validateThemeColors', () => {
  it('accepts the shipped dark palette — the one the editor starts from', () => {
    expect(
      validateThemeColors(
        palette({
          'bg-hover': 'rgba(141, 141, 242, 0.08)',
          'bg-active': 'rgba(141, 141, 242, 0.14)',
          border: 'rgba(141, 141, 242, 0.12)',
          'scrollbar-thumb': 'rgba(141, 141, 242, 0.14)',
          'scrollbar-thumb-hover': 'rgba(141, 141, 242, 0.26)',
          'selection-bg': 'rgba(91, 91, 247, 0.35)',
        }),
      ),
    ).toBeNull();
  });

  it('accepts an all-opaque palette — light/midnight/tactical still publish', () => {
    expect(validateThemeColors(palette())).toBeNull();
  });

  it('names the offending key, and says what that key allows', () => {
    expect(validateThemeColors(palette({ chat: 'rgba(0, 0, 0, 0.5)' }))).toBe(
      'Invalid color value for "chat": must be hex (#RRGGBB)',
    );
    expect(validateThemeColors(palette({ 'bg-hover': 'nope' }))).toBe(
      'Invalid color value for "bg-hover": must be hex (#RRGGBB) or rgba()',
    );
  });

  it('still enforces the key set', () => {
    const missing = palette();
    delete missing['bg-primary'];
    expect(validateThemeColors(missing)).not.toBeNull();
    expect(validateThemeColors({ ...palette(), extra: '#000000' })).not.toBeNull();
  });

  it('every value the built-in themes actually ship passes', () => {
    // The regression guard with teeth: parse themes.css and validate each
    // [data-theme] block the way a publish would.
    const css = readFileSync(THEMES_CSS, 'utf8');
    const blocks = [...css.matchAll(/\[data-theme="(\w+)"\]\s*\{([\s\S]*?)\n\}/g)];
    const authored = blocks.filter(([, , body]) => body.includes('--vox-bg-primary'));
    expect(authored.length, 'no theme blocks parsed out of themes.css').toBeGreaterThanOrEqual(4);

    for (const [, name, body] of authored) {
      const colors: Record<string, string> = {};
      for (const [, key, value] of body.matchAll(/--vox-([a-z-]+):\s*([^;]+);/g)) {
        if ((THEME_COLOR_KEYS as readonly string[]).includes(key)) colors[key] = value.trim();
      }
      expect(Object.keys(colors).length, `${name} is missing authored keys`).toBe(THEME_COLOR_KEYS.length);
      expect(validateThemeColors(colors), `built-in theme "${name}" cannot be published`).toBeNull();
    }
  });
});
