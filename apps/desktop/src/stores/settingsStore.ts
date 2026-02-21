import { create } from 'zustand';

const STORAGE_KEY = 'voxium_settings';

interface PersistedSettings {
  audioInputDeviceId: string;
  audioOutputDeviceId: string;
  noiseGateThreshold: number;
}

interface SettingsState extends PersistedSettings {
  isSettingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
  setAudioInputDeviceId: (deviceId: string) => void;
  setAudioOutputDeviceId: (deviceId: string) => void;
  setNoiseGateThreshold: (threshold: number) => void;
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
      };
    }
  } catch {
    // ignore parse errors
  }
  return { audioInputDeviceId: '', audioOutputDeviceId: '', noiseGateThreshold: 0.015 };
}

function persistSettings(state: PersistedSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      audioInputDeviceId: state.audioInputDeviceId,
      audioOutputDeviceId: state.audioOutputDeviceId,
      noiseGateThreshold: state.noiseGateThreshold,
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
}));
