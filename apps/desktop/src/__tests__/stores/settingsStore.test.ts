import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * `spacesStripMode` is a device preference like the theme: read from
 * localStorage at import, validated (anything but 'auto' is 'pinned'),
 * persisted on change, and untouched by the account reset that logout runs.
 */

describe('settingsStore â€” the spaces strip mode', () => {
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

describe('settingsStore — the noise-gate threshold default', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  async function loaded() {
    const { useSettingsStore } = await import('../../stores/settingsStore');
    const { DEFAULT_NOISE_GATE_THRESHOLD } = await import('../../services/audioDefaults');
    return { threshold: useSettingsStore.getState().noiseGateThreshold, DEFAULT_NOISE_GATE_THRESHOLD };
  }

  it('is 0.008, what a fresh install has always had', async () => {
    const { threshold, DEFAULT_NOISE_GATE_THRESHOLD } = await loaded();
    expect(DEFAULT_NOISE_GATE_THRESHOLD).toBe(0.008);
    expect(threshold).toBe(DEFAULT_NOISE_GATE_THRESHOLD);
  });

  it('is the same for a stored entry that has no threshold', async () => {
    localStorage.setItem('voxium_settings', JSON.stringify({ theme: 'dark' }));
    const { threshold, DEFAULT_NOISE_GATE_THRESHOLD } = await loaded();
    expect(threshold).toBe(DEFAULT_NOISE_GATE_THRESHOLD);
  });

  it.each([null, 'loud', true, {}])('is the same for a stored threshold of %j', async (value) => {
    localStorage.setItem('voxium_settings', JSON.stringify({ noiseGateThreshold: value }));
    const { threshold, DEFAULT_NOISE_GATE_THRESHOLD } = await loaded();
    expect(threshold).toBe(DEFAULT_NOISE_GATE_THRESHOLD);
  });

  it('keeps a saved value, and a fallback never rewrites the stored entry', async () => {
    localStorage.setItem('voxium_settings', JSON.stringify({ noiseGateThreshold: 0.03 }));
    expect((await loaded()).threshold).toBe(0.03);
    expect(JSON.parse(localStorage.getItem('voxium_settings')!).noiseGateThreshold).toBe(0.03);

    vi.resetModules();
    const lost = JSON.stringify({ theme: 'dark' });
    localStorage.setItem('voxium_settings', lost);
    await loaded();
    expect(localStorage.getItem('voxium_settings')).toBe(lost);
  });

  it('is the analyser starting value too: no literal threshold is left in either file', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(import.meta.dirname, '../..');
    const analyser = fs.readFileSync(path.join(root, 'services/audioAnalyser.ts'), 'utf8');
    const store = fs.readFileSync(path.join(root, 'stores/settingsStore.ts'), 'utf8');
    expect(analyser).toMatch(/let threshold = DEFAULT_NOISE_GATE_THRESHOLD;/);
    expect(store).toMatch(/noiseGateThreshold: DEFAULT_NOISE_GATE_THRESHOLD,/);
    expect(store).not.toMatch(/noiseGateThreshold:\s*0\./);
    expect(analyser).not.toMatch(/let threshold = 0\./);
  });
});
