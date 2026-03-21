import { create } from 'zustand';

const STORAGE_KEY = 'voxium_settings';

type VoiceMode = 'voice_activity' | 'push_to_talk';
export type VoiceQuality = 'low' | 'medium' | 'high';

/** Built-in themes. Future custom themes will extend this. */
export type ThemeId = 'dark' | 'light' | 'midnight';

export const THEMES: { id: ThemeId; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'midnight', label: 'Midnight' },
];

/** Opus maxBitrate in bps for each quality level */
export const VOICE_QUALITY_BITRATE: Record<VoiceQuality, number> = {
  low: 16_000,
  medium: 32_000,
  high: 64_000,
};

interface PersistedSettings {
  theme: ThemeId;
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
  openSettings: () => void;
  closeSettings: () => void;
  setTheme: (theme: ThemeId) => void;
  setAudioInputDeviceId: (deviceId: string) => void;
  setAudioOutputDeviceId: (deviceId: string) => void;
  setNoiseGateThreshold: (threshold: number) => void;
  setVoiceMode: (mode: VoiceMode) => void;
  setVoiceQuality: (quality: VoiceQuality) => void;
  setPushToTalkKey: (key: string) => void;
  setEnableNoiseSuppression: (enabled: boolean) => void;
  setEnableNotificationSounds: (enabled: boolean) => void;
  setEnableDesktopNotifications: (enabled: boolean) => void;
}

function loadPersistedSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        theme: (['dark', 'light', 'midnight'].includes(parsed.theme) ? parsed.theme : 'dark') as ThemeId,
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
  return { theme: 'dark' as ThemeId, audioInputDeviceId: '', audioOutputDeviceId: '', noiseGateThreshold: 0.008, voiceMode: 'voice_activity', voiceQuality: 'medium' as VoiceQuality, pushToTalkKey: 'Backquote', enableNoiseSuppression: true, enableNotificationSounds: true, enableDesktopNotifications: true };
}

function persistSettings(state: PersistedSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      theme: state.theme,
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

/** Apply theme to the document root element */
function applyTheme(theme: ThemeId) {
  document.documentElement.setAttribute('data-theme', theme);
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...initial,
  isSettingsOpen: false,

  openSettings: () => set({ isSettingsOpen: true }),
  closeSettings: () => set({ isSettingsOpen: false }),

  setTheme: (theme: ThemeId) => {
    applyTheme(theme);
    set({ theme });
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
}));

// Apply persisted theme on app startup (before React renders)
applyTheme(useSettingsStore.getState().theme);
