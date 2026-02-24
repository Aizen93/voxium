import { create } from 'zustand';

const STORAGE_KEY = 'voxium_settings';

type VoiceMode = 'voice_activity' | 'push_to_talk';

interface PersistedSettings {
  audioInputDeviceId: string;
  audioOutputDeviceId: string;
  noiseGateThreshold: number;
  voiceMode: VoiceMode;
  pushToTalkKey: string;
  enableNotificationSounds: boolean;
  enableDesktopNotifications: boolean;
}

interface SettingsState extends PersistedSettings {
  isSettingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
  setAudioInputDeviceId: (deviceId: string) => void;
  setAudioOutputDeviceId: (deviceId: string) => void;
  setNoiseGateThreshold: (threshold: number) => void;
  setVoiceMode: (mode: VoiceMode) => void;
  setPushToTalkKey: (key: string) => void;
  setEnableNotificationSounds: (enabled: boolean) => void;
  setEnableDesktopNotifications: (enabled: boolean) => void;
}

function loadPersistedSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        audioInputDeviceId: parsed.audioInputDeviceId || '',
        audioOutputDeviceId: parsed.audioOutputDeviceId || '',
        noiseGateThreshold: typeof parsed.noiseGateThreshold === 'number' ? parsed.noiseGateThreshold : 0.015,
        voiceMode: parsed.voiceMode === 'push_to_talk' ? 'push_to_talk' : 'voice_activity',
        pushToTalkKey: typeof parsed.pushToTalkKey === 'string' ? parsed.pushToTalkKey : 'Backquote',
        enableNotificationSounds: parsed.enableNotificationSounds !== false,
        enableDesktopNotifications: parsed.enableDesktopNotifications !== false,
      };
    }
  } catch {
    // ignore parse errors
  }
  return { audioInputDeviceId: '', audioOutputDeviceId: '', noiseGateThreshold: 0.015, voiceMode: 'voice_activity', pushToTalkKey: 'Backquote', enableNotificationSounds: true, enableDesktopNotifications: true };
}

function persistSettings(state: PersistedSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      audioInputDeviceId: state.audioInputDeviceId,
      audioOutputDeviceId: state.audioOutputDeviceId,
      noiseGateThreshold: state.noiseGateThreshold,
      voiceMode: state.voiceMode,
      pushToTalkKey: state.pushToTalkKey,
      enableNotificationSounds: state.enableNotificationSounds,
      enableDesktopNotifications: state.enableDesktopNotifications,
    }));
  } catch {
    // ignore storage errors
  }
}

const initial = loadPersistedSettings();

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...initial,
  isSettingsOpen: false,

  openSettings: () => set({ isSettingsOpen: true }),
  closeSettings: () => set({ isSettingsOpen: false }),

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
  },

  setVoiceMode: (mode: VoiceMode) => {
    set({ voiceMode: mode });
    persistSettings(get());
  },

  setPushToTalkKey: (key: string) => {
    set({ pushToTalkKey: key });
    persistSettings(get());
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
