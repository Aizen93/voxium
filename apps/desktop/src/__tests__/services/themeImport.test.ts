import { describe, it, expect } from 'vitest';
import { THEME_COLOR_KEYS } from '@voxium/shared';
import { importTheme, exportTheme } from '../../services/themeEngine';
import type { CommunityThemeData } from '@voxium/shared';

/**
 * JSON import is the third gate the hex-only color rule closed, alongside
 * publishing and the editor's own fields: a theme exported from this app —
 * with the translucent hover/active/border/scrollbar layers the 2026 palettes
 * are built on — could not be imported back into it.
 *
 * `exportTheme` is exercised too, so the round trip is pinned end to end
 * rather than just the half that reads.
 */

function themeJson(overrides: Record<string, string> = {}): CommunityThemeData {
  const colors: Record<string, string> = {};
  for (const key of THEME_COLOR_KEYS) colors[key] = '#1a1a2e';
  return {
    name: 'Round Trip',
    description: 'exported from the editor',
    tags: ['dark'],
    colors: { ...colors, ...overrides } as CommunityThemeData['colors'],
    version: 1,
  };
}

const asFile = (data: unknown) =>
  new File([JSON.stringify(data, null, 2)], 'theme.voxtheme.json', { type: 'application/json' });

describe('importTheme', () => {
  it('accepts a theme whose hover/border/scrollbar layers are translucent', async () => {
    const imported = await importTheme(
      asFile(
        themeJson({
          'bg-hover': 'rgba(141, 141, 242, 0.08)',
          'bg-active': 'rgba(141, 141, 242, 0.14)',
          border: 'rgba(141, 141, 242, 0.12)',
          'scrollbar-thumb': 'rgba(141, 141, 242, 0.14)',
          'scrollbar-thumb-hover': 'rgba(141, 141, 242, 0.26)',
        }),
      ),
    );

    expect(imported.name).toBe('Round Trip');
    // The alpha is what the theme IS — flattening it here would be a silent
    // downgrade of someone else's design.
    expect(imported.colors['bg-hover']).toBe('rgba(141, 141, 242, 0.08)');
    expect(imported.colors.border).toBe('rgba(141, 141, 242, 0.12)');
  });

  it('still rejects a translucent opaque surface', async () => {
    await expect(importTheme(asFile(themeJson({ chat: 'rgba(0, 0, 0, 0.5)' })))).rejects.toThrow(/chat/);
  });

  it('still rejects junk in a color slot', async () => {
    await expect(importTheme(asFile(themeJson({ 'bg-hover': 'url(evil)' })))).rejects.toThrow(/bg-hover/);
    await expect(importTheme(asFile({ name: 'X' }))).rejects.toThrow();
  });

  it('round-trips what exportTheme writes', async () => {
    // exportTheme builds a blob URL and clicks an <a>; capture the payload
    // rather than the download, which jsdom cannot perform.
    const theme = themeJson({ 'bg-hover': 'rgba(141, 141, 242, 0.08)' });
    let captured = '';
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    // jsdom cannot navigate, and a real anchor click logs a loud "Not
    // implemented" through the virtual console.
    const originalClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = ((blob: Blob) => {
      void blob.text().then((t) => { captured = t; });
      return 'blob:stub';
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
    HTMLAnchorElement.prototype.click = function noop() {};
    try {
      exportTheme(theme);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      HTMLAnchorElement.prototype.click = originalClick;
    }

    expect(captured, 'exportTheme wrote nothing').not.toBe('');
    const reimported = await importTheme(asFile(JSON.parse(captured)));
    expect(reimported.colors['bg-hover']).toBe('rgba(141, 141, 242, 0.08)');
  });
});
