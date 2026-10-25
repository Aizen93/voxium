import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * `spacesStripMode` is a device preference like the theme: read from
 * localStorage at import, validated (anything but 'auto' is 'pinned'),
 * persisted on change, and untouched by the account reset that logout runs.
 */

describe('settingsStore — the spaces strip mode', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('defaults to pinned and persists a change', async () => {
    const { useSettingsStore } = await import('../../stores/settingsStore');
    expect(useSettingsStore.getState().spacesStripMode).toBe('pinned');

    useSettingsStore.getState().setSpacesStripMode('auto');
    expect(useSettingsStore.getState().spacesStripMode).toBe('auto');
    expect(JSON.parse(localStorage.getItem('voxium_settings')!).spacesStripMode).toBe('auto');

    useSettingsStore.getState().setSpacesStripMode('pinned');
    expect(JSON.parse(localStorage.getItem('voxium_settings')!).spacesStripMode).toBe('pinned');
  });

  it('reads a stored auto mode back at import', async () => {
    localStorage.setItem('voxium_settings', JSON.stringify({ spacesStripMode: 'auto' }));
    const { useSettingsStore } = await import('../../stores/settingsStore');
    expect(useSettingsStore.getState().spacesStripMode).toBe('auto');
  });

  it('refuses a value it does not know and falls back to pinned', async () => {
    localStorage.setItem('voxium_settings', JSON.stringify({ spacesStripMode: 'sideways' }));
    const { useSettingsStore } = await import('../../stores/settingsStore');
    expect(useSettingsStore.getState().spacesStripMode).toBe('pinned');
  });

  it('is a device preference: the account reset leaves it alone', async () => {
    const { useSettingsStore } = await import('../../stores/settingsStore');
    const { resetAccountStores } = await import('../../stores/resetStores');
    useSettingsStore.getState().setSpacesStripMode('auto');
    resetAccountStores();
    expect(useSettingsStore.getState().spacesStripMode).toBe('auto');
  });
});
