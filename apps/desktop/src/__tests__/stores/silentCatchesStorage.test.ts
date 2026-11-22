import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A storage read or write that fails (private mode, a corrupt entry) keeps
 * its fallback and says why.
 */

vi.mock('../../services/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() } }));

describe('stores: storage and fetch failures are logged', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    vi.restoreAllMocks();
  });

  const text = () => warn.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');

  it('settings: a corrupt entry falls back to the defaults and warns', async () => {
    localStorage.setItem('voxium_settings', '{not json');
    const { useSettingsStore } = await import('../../stores/settingsStore');
    expect(useSettingsStore.getState().spacesStripMode).toBe('pinned');
    expect(text()).toContain('Could not read the saved settings');
  });

  it('settings: a failing save warns once, however many changes follow', async () => {
    const { useSettingsStore } = await import('../../stores/settingsStore');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    useSettingsStore.getState().setSpacesStripMode('auto');
    useSettingsStore.getState().setSpacesStripMode('pinned');
    useSettingsStore.getState().setSpacesStripMode('auto');
    const lines = warn.mock.calls.filter((c: unknown[]) => c.join(' ').includes('Could not save the settings'));
    expect(lines).toHaveLength(1);
    expect(text()).toContain('quota');
    expect(useSettingsStore.getState().spacesStripMode).toBe('auto');
  });

  it('announcements: a corrupt entry reads as nothing dismissed and warns', async () => {
    localStorage.setItem('voxium_dismissed_announcements', '{nope');
    const { useAnnouncementStore } = await import('../../stores/announcementStore');
    expect(useAnnouncementStore.getState().dismissedIds).toEqual([]);
    expect(text()).toContain('Could not read the dismissed announcements');
  });

  it('pinned spaces: a corrupt entry reads as none pinned and warns', async () => {
    localStorage.setItem('voxium_pinned_spaces', '{nope');
    const { useServerStore } = await import('../../stores/serverStore');
    expect(useServerStore.getState().pinnedServerIds).toEqual([]);
    expect(text()).toContain('Could not read the pinned spaces');
  });

  it('pinned spaces: a failing save still pins for the session and warns', async () => {
    const { useServerStore } = await import('../../stores/serverStore');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    useServerStore.getState().togglePinServer('s-1');
    expect(useServerStore.getState().pinnedServerIds).toEqual(['s-1']);
    expect(text()).toContain('Could not save the pinned spaces');
    expect(text()).toContain('denied');
  });

  it('support: a failing ticket load warns and leaves the panel empty', async () => {
    const { api } = await import('../../services/api');
    (api.get as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network Error'));
    const { useSupportStore } = await import('../../stores/supportStore');
    await useSupportStore.getState().fetchTicket();
    expect(useSupportStore.getState().ticket).toBeNull();
    expect(text()).toContain('Could not load the open ticket');
    expect(text()).toContain('Network Error');
  });
});
