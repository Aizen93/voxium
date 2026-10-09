import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The default theme is `dark` — the Voxium brand look.
 *
 * A redesign pass once flipped the default to light AND force-migrated every
 * stored `dark` preference along with it. These tests pin the contract that
 * replaced it: a fresh install gets dark, and a stored choice — any stored
 * choice — is loaded exactly as written, never rewritten at load time.
 */

const STORAGE_KEY = 'voxium_settings';

/** Load settingsStore fresh so its module-level `loadPersistedSettings()` reruns. */
async function bootWith(stored: Record<string, unknown> | null) {
  localStorage.clear();
  if (stored) localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  document.documentElement.removeAttribute('data-theme');
  vi.resetModules();
  const mod = await import('../../stores/settingsStore');
  return mod.useSettingsStore.getState();
}

const savedTheme = () => {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as { theme?: string }) : null;
};

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.resetModules();
});

describe('the default theme', () => {
  it('gives a brand-new install the dark Voxium theme', async () => {
    const state = await bootWith(null);
    expect(state.theme).toBe('dark');
  });

  it('applies it to the document, not just the store', async () => {
    await bootWith(null);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('never rewrites a stored choice at load time', async () => {
    for (const theme of ['dark', 'light', 'midnight', 'tactical']) {
      const state = await bootWith({ theme });
      expect(state.theme, theme).toBe(theme);
      expect(document.documentElement.getAttribute('data-theme')).toBe(theme);
    }
  });

  it('ignores the version stamp a since-reverted migration wrote', async () => {
    // Settings saved by the migration build carry `version: 2`. The field is
    // meaningless now; the stored theme must simply be respected.
    const state = await bootWith({ theme: 'light', version: 2 });
    expect(state.theme).toBe('light');
  });

  it('keeps a selected custom theme', async () => {
    const custom = {
      localId: 'abc',
      data: { colors: {}, patterns: {} },
    };
    const state = await bootWith({ theme: 'custom:abc', customThemes: [custom] });
    expect(state.theme).toBe('custom:abc');
  });

  it('falls back to dark when a custom theme has gone missing', async () => {
    const state = await bootWith({ theme: 'custom:gone', customThemes: [] });
    expect(state.theme).toBe('dark');
  });

  it('round-trips a picked theme across launches', async () => {
    const state = await bootWith(null);
    state.setTheme('midnight');
    expect(savedTheme()?.theme).toBe('midnight');

    const next = await bootWith(savedTheme() as Record<string, unknown>);
    expect(next.theme).toBe('midnight');
  });
});
