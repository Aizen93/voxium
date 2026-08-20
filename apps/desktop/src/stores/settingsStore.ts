import { create } from 'zustand';
import type { CommunityThemeData } from '@voxium/shared';
import { BUILT_IN_THEME_IDS } from '@voxium/shared';
import { applyCustomThemeColors, clearCustomThemeColors, applyCustomPatterns } from '../services/themeEngine';
import i18n from '../i18n';
import { applyLanguageDirection } from '../i18n';

const STORAGE_KEY = 'voxium_settings';

type VoiceMode = 'voice_activity' | 'push_to_talk';
export type VoiceQuality = 'low' | 'medium' | 'high';

type BuiltInThemeId = (typeof BUILT_IN_THEME_IDS)[number];

/** Theme identifier: built-in ID or 'custom:<localId>' for community themes */
export type ThemeId = BuiltInThemeId | `custom:${string}`;

/**
 * The tabs of the settings modal. Declared here rather than in the modal so
 * callers can deep-link (`openSettings('security')`) without importing the
 * component — and so a renamed tab breaks at the call sites, not at runtime.
 */
export type SettingsTab = 'account' | 'security' | 'appearance' | 'audio' | 'language';

export const THEMES: { id: BuiltInThemeId; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'tactical', label: 'Tactical' },
];

/** Opus maxBitrate in bps for each quality level */
export const VOICE_QUALITY_BITRATE: Record<VoiceQuality, number> = {
  low: 16_000,
  medium: 32_000,
  high: 64_000,
};

interface LocalCustomTheme {
  localId: string;
  remoteId?: string;
  data: CommunityThemeData;
  source: 'created' | 'installed';
}

interface PersistedSettings {
  theme: ThemeId;
  customThemes: LocalCustomTheme[];
  language: string;
  audioInputDeviceId: string;
  audioOutputDeviceId: string;
  noiseGateThreshold: number;
  voiceMode: VoiceMode;
  voiceQuality: VoiceQuality;
  pushToTalkKey: string;
  enableNoiseSuppression: boolean;
  enableNotificationSounds: boolean;
  enableDesktopNotifications: boolean;
}

interface SettingsState extends PersistedSettings {
  isSettingsOpen: boolean;
  /**
   * A tab the opener asked for, consumed once by the modal.
   *
   * It is a REQUEST, not the current tab: the modal owns which tab is showing
   * (the user clicks the nav), so parking that here would give two owners to
   * one piece of state. Clearing it on consumption is what keeps a later plain
   * `openSettings()` landing on the default instead of re-opening wherever the
   * last deep link pointed.
   */
  initialSettingsTab: SettingsTab | null;
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  /** Called by the modal once it has honoured `initialSettingsTab`. */
  clearInitialSettingsTab: () => void;
  setTheme: (theme: ThemeId) => void;
  /**
   * Re-apply the stored theme to the document without changing (or
   * re-persisting) it — how the marketplace and the theme editor put the app
   * back after a full-app preview painted someone else's colors on <html>.
   */
  reapplyTheme: () => void;
  setLanguage: (lang: string) => void;
  setAudioInputDeviceId: (deviceId: string) => void;
  setAudioOutputDeviceId: (deviceId: string) => void;
  setNoiseGateThreshold: (threshold: number) => void;
  setVoiceMode: (mode: VoiceMode) => void;
  setVoiceQuality: (quality: VoiceQuality) => void;
  setPushToTalkKey: (key: string) => void;
  setEnableNoiseSuppression: (enabled: boolean) => void;
  setEnableNotificationSounds: (enabled: boolean) => void;
  setEnableDesktopNotifications: (enabled: boolean) => void;
  // Custom theme management
  installCustomTheme: (remoteId: string, data: CommunityThemeData) => string;
  uninstallCustomTheme: (localId: string) => void;
  saveLocalTheme: (localId: string, data: CommunityThemeData) => void;
  createLocalTheme: (data: CommunityThemeData) => string;
  deleteLocalTheme: (localId: string) => void;
  getCustomTheme: (localId: string) => LocalCustomTheme | undefined;
  setThemeRemoteId: (localId: string, remoteId: string) => void;
}

function isBuiltInTheme(id: string): id is BuiltInThemeId {
  return (BUILT_IN_THEME_IDS as readonly string[]).includes(id);
}

function loadPersistedSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);

      // Validate theme ID
      let theme: ThemeId = 'dark';
      if (typeof parsed.theme === 'string') {
        if (isBuiltInTheme(parsed.theme)) {
          theme = parsed.theme;
        } else if (parsed.theme.startsWith('custom:')) {
          theme = parsed.theme;
        }
      }

      // Load custom themes
      const customThemes: LocalCustomTheme[] = Array.isArray(parsed.customThemes)
        ? parsed.customThemes.filter(
            (t: unknown) =>
              t && typeof t === 'object' &&
              typeof (t as LocalCustomTheme).localId === 'string' &&
              (t as LocalCustomTheme).data &&
              typeof (t as LocalCustomTheme).data === 'object',
          )
        : [];

      // If custom theme references a missing local theme, fall back to dark
      if (theme.startsWith('custom:')) {
        const localId = theme.slice(7);
        if (!customThemes.some((t) => t.localId === localId)) {
          theme = 'dark';
        }
      }

      return {
        theme,
        customThemes,
        language: typeof parsed.language === 'string' ? parsed.language : '',
        audioInputDeviceId: parsed.audioInputDeviceId || '',
        audioOutputDeviceId: parsed.audioOutputDeviceId || '',
        noiseGateThreshold: typeof parsed.noiseGateThreshold === 'number' ? parsed.noiseGateThreshold : 0.03,
        voiceMode: parsed.voiceMode === 'push_to_talk' ? 'push_to_talk' : 'voice_activity',
        voiceQuality: (['low', 'medium', 'high'].includes(parsed.voiceQuality) ? parsed.voiceQuality : 'medium') as VoiceQuality,
        pushToTalkKey: typeof parsed.pushToTalkKey === 'string' ? parsed.pushToTalkKey : 'Backquote',
        enableNoiseSuppression: parsed.enableNoiseSuppression !== false,
        enableNotificationSounds: parsed.enableNotificationSounds !== false,
        enableDesktopNotifications: parsed.enableDesktopNotifications !== false,
      };
    }
  } catch {
    // ignore parse errors
  }
  return {
    theme: 'dark',
    customThemes: [],
    language: '',
    audioInputDeviceId: '',
    audioOutputDeviceId: '',
    noiseGateThreshold: 0.008,
    voiceMode: 'voice_activity',
    voiceQuality: 'medium',
    pushToTalkKey: 'Backquote',
    enableNoiseSuppression: true,
    enableNotificationSounds: true,
    enableDesktopNotifications: true,
  };
}

function persistSettings(state: PersistedSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      theme: state.theme,
      customThemes: state.customThemes,
      language: state.language,
      audioInputDeviceId: state.audioInputDeviceId,
      audioOutputDeviceId: state.audioOutputDeviceId,
      noiseGateThreshold: state.noiseGateThreshold,
      voiceMode: state.voiceMode,
      voiceQuality: state.voiceQuality,
      pushToTalkKey: state.pushToTalkKey,
      enableNoiseSuppression: state.enableNoiseSuppression,
      enableNotificationSounds: state.enableNotificationSounds,
      enableDesktopNotifications: state.enableDesktopNotifications,
    }));
  } catch {
    // ignore storage errors
  }
}

const initial = loadPersistedSettings();

/** Apply a theme (built-in or custom) to the document */
function applyTheme(theme: ThemeId, customThemes: LocalCustomTheme[]) {
  if (theme.startsWith('custom:')) {
    const localId = theme.slice(7);
    const custom = customThemes.find((t) => t.localId === localId);
    if (custom) {
      applyCustomThemeColors(custom.data.colors);
      applyCustomPatterns(custom.data.patterns);
      return;
    }
    // Fallback if custom theme not found
    clearCustomThemeColors();
    document.documentElement.setAttribute('data-theme', 'dark');
    return;
  }
  clearCustomThemeColors();
  document.documentElement.setAttribute('data-theme', theme);
}

function generateLocalId(): string {
  return crypto.randomUUID();
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...initial,
  isSettingsOpen: false,
  initialSettingsTab: null,

  // No argument keeps the old behaviour exactly: open on the default tab.
  openSettings: (tab?: SettingsTab) => set({ isSettingsOpen: true, initialSettingsTab: tab ?? null }),
  // Also drops an unconsumed request, so a deep link that never got rendered
  // cannot resurface on the next open.
  closeSettings: () => set({ isSettingsOpen: false, initialSettingsTab: null }),
  clearInitialSettingsTab: () => set({ initialSettingsTab: null }),

  setTheme: (theme: ThemeId) => {
    applyTheme(theme, get().customThemes);
    set({ theme });
    persistSettings(get());
  },

  reapplyTheme: () => {
    applyTheme(get().theme, get().customThemes);
  },

  setLanguage: (lang: string) => {
    i18n.changeLanguage(lang);
    applyLanguageDirection(lang);
    set({ language: lang });
    persistSettings(get());
  },

  setAudioInputDeviceId: (deviceId: string) => {
    set({ audioInputDeviceId: deviceId });
    persistSettings(get());
  },

  setAudioOutputDeviceId: (deviceId: string) => {
    set({ audioOutputDeviceId: deviceId });
    persistSettings(get());
  },

  setNoiseGateThreshold: (threshold: number) => {
    set({ noiseGateThreshold: threshold });
    persistSettings(get());
    // Sync to the live audioAnalyser immediately so the slider takes effect in real-time
    import('../services/audioAnalyser').then(({ setNoiseGateThreshold: setAnalyserThreshold }) => {
      setAnalyserThreshold(threshold);
    });
  },

  setVoiceMode: (mode: VoiceMode) => {
    set({ voiceMode: mode });
    persistSettings(get());
  },

  setVoiceQuality: (quality: VoiceQuality) => {
    set({ voiceQuality: quality });
    persistSettings(get());
  },

  setPushToTalkKey: (key: string) => {
    set({ pushToTalkKey: key });
    persistSettings(get());
  },

  setEnableNoiseSuppression: (enabled: boolean) => {
    set({ enableNoiseSuppression: enabled });
    persistSettings(get());
    // Sync to the live audioAnalyser immediately
    import('../services/audioAnalyser').then(({ setNoiseSuppression }) => {
      setNoiseSuppression(enabled);
    });
  },

  setEnableNotificationSounds: (enabled: boolean) => {
    set({ enableNotificationSounds: enabled });
    persistSettings(get());
  },

  setEnableDesktopNotifications: (enabled: boolean) => {
    set({ enableDesktopNotifications: enabled });
    persistSettings(get());
  },

  // ─── Custom theme management ──────────────────────────────────────────

  installCustomTheme: (remoteId: string, data: CommunityThemeData) => {
    const existing = get().customThemes.find((t) => t.remoteId === remoteId);
    if (existing) {
      // Update existing installed theme
      const customThemes = get().customThemes.map((t) =>
        t.remoteId === remoteId ? { ...t, data } : t,
      );
      set({ customThemes });
      persistSettings(get());
      return existing.localId;
    }
    const localId = generateLocalId();
    const newTheme: LocalCustomTheme = { localId, remoteId, data, source: 'installed' };
    set({ customThemes: [...get().customThemes, newTheme] });
    persistSettings(get());
    return localId;
  },

  uninstallCustomTheme: (localId: string) => {
    const state = get();
    const customThemes = state.customThemes.filter((t) => t.localId !== localId);
    const updates: Partial<PersistedSettings> = { customThemes };
    // If the active theme is being uninstalled, switch to dark
    if (state.theme === `custom:${localId}`) {
      updates.theme = 'dark';
      clearCustomThemeColors();
      document.documentElement.setAttribute('data-theme', 'dark');
    }
    set(updates);
    persistSettings(get());
  },

  saveLocalTheme: (localId: string, data: CommunityThemeData) => {
    const customThemes = get().customThemes.map((t) =>
      t.localId === localId ? { ...t, data } : t,
    );
    set({ customThemes });
    persistSettings(get());
    // If this is the active theme, re-apply colors + patterns
    if (get().theme === `custom:${localId}`) {
      applyCustomThemeColors(data.colors);
      applyCustomPatterns(data.patterns);
    }
  },

  createLocalTheme: (data: CommunityThemeData) => {
    const localId = generateLocalId();
    const newTheme: LocalCustomTheme = { localId, data, source: 'created' };
    set({ customThemes: [...get().customThemes, newTheme] });
    persistSettings(get());
    return localId;
  },

  deleteLocalTheme: (localId: string) => {
    const state = get();
    const customThemes = state.customThemes.filter((t) => t.localId !== localId);
    const updates: Partial<PersistedSettings> = { customThemes };
    if (state.theme === `custom:${localId}`) {
      updates.theme = 'dark';
      clearCustomThemeColors();
      document.documentElement.setAttribute('data-theme', 'dark');
    }
    set(updates);
    persistSettings(get());
  },

  getCustomTheme: (localId: string) => {
    return get().customThemes.find((t) => t.localId === localId);
  },

  setThemeRemoteId: (localId: string, remoteId: string) => {
    const customThemes = get().customThemes.map((t) =>
      t.localId === localId ? { ...t, remoteId } : t,
    );
    set({ customThemes });
    persistSettings(get());
  },
}));

// Apply persisted theme on app startup (before React renders)
applyTheme(useSettingsStore.getState().theme, useSettingsStore.getState().customThemes);
