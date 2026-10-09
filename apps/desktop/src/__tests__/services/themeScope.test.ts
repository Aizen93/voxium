import { describe, it, expect } from 'vitest';
import { THEME_COLOR_KEYS } from '@voxium/shared';
import type { ThemeColors } from '@voxium/shared';
import { getThemeScopeStyle } from '../../services/themeEngine';

/**
 * Scoping a theme to one subtree is what lets a preview show a theme the app
 * is not wearing. The trap it has to avoid: globals.css declares the Tailwind
 * color tokens at `:root` AS `var(--vox-…)`, and a custom property's var()
 * references are substituted on the element that DECLARES it — so descendants
 * inherit whatever the root theme resolved to. Re-pointing `--vox-chat` on a
 * subtree changes nothing a `bg-vox-chat` utility renders unless
 * `--color-vox-chat` moves with it.
 *
 * Same story for the v2 derived tokens (accent tints, strong border): they are
 * color-mixes of the authored keys, already baked against the root theme by
 * the time a subtree inherits them.
 */

function colorsWith(overrides: Partial<Record<string, string>> = {}): ThemeColors {
  const colors: Record<string, string> = {};
  for (const key of THEME_COLOR_KEYS) colors[key] = '#123456';
  return { ...colors, ...overrides } as ThemeColors;
}

const read = (style: Record<string, string>, prop: string) => style[prop];

describe('getThemeScopeStyle', () => {
  it('writes every authored key into BOTH custom-property namespaces', () => {
    const style = getThemeScopeStyle(colorsWith({ chat: '#0a0a0a', 'text-primary': '#fafafa' })) as unknown as Record<string, string>;

    for (const key of THEME_COLOR_KEYS) {
      expect(read(style, `--vox-${key}`), `--vox-${key} missing`).toBeDefined();
      expect(read(style, `--color-vox-${key}`), `--color-vox-${key} missing — Tailwind utilities would keep the root theme`).toBeDefined();
    }
    expect(read(style, '--vox-chat')).toBe('#0a0a0a');
    expect(read(style, '--color-vox-chat')).toBe('#0a0a0a');
  });

  it('rebuilds the derived v2 tokens from THIS palette, not the root one', () => {
    const style = getThemeScopeStyle(
      colorsWith({ 'accent-primary': '#ff0000', 'text-primary': '#00ff00' }),
    ) as unknown as Record<string, string>;

    expect(read(style, '--color-vox-accent-tint')).toContain('#ff0000');
    expect(read(style, '--color-vox-accent-tint-strong')).toContain('#ff0000');
    expect(read(style, '--color-vox-border-strong')).toContain('#00ff00');
    // Text on accent fills has always been white, in every built-in theme.
    expect(read(style, '--color-vox-on-accent')).toBe('#ffffff');
    // …and the un-prefixed namespace too, for the inline styles that read it.
    expect(read(style, '--vox-accent-tint')).toContain('#ff0000');
  });

  it('does not fall over on a half-typed palette', () => {
    // The editor calls this on every keystroke, including mid-edit garbage.
    const partial = { ...colorsWith() } as Record<string, string>;
    delete partial['accent-primary'];
    const style = getThemeScopeStyle(partial as unknown as ThemeColors) as unknown as Record<string, string>;

    expect(read(style, '--vox-accent-primary')).toBe('');
    expect(read(style, '--color-vox-accent-tint')).toContain('color-mix');
  });
});
