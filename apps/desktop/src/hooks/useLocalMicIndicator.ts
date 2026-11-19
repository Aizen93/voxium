import { useTranslation } from 'react-i18next';
import { useVoiceStore } from '../stores/voiceStore';
import { useSettingsStore } from '../stores/settingsStore';

export interface LocalMicIndicator {
  /** The microphone is not sending anything right now: the muted icon. */
  micOff: boolean;
  /** Muted by the user's own mute flag (red), as opposed to push-to-talk waiting for its key. */
  manualMute: boolean;
  /** Push-to-talk is on, a call is live and the key is up. */
  pttIdle: boolean;
  /** Title and aria-label of the mute control. */
  label: string;
}

/**
 * What the LOCAL user's own microphone controls should say. In push-to-talk
 * mode the store's `selfMute` (the manual flag) stays false while the key is up,
 * although the microphone is off and the server has been told the user is
 * muted, so the controls read `pttActive` too: key up in a live call is the
 * muted icon, key held is the open one (push-to-talk overrides the mute flag).
 * This is display only: the flag, the mute events and what other people see
 * are not touched. Outside a call there is nothing to wait for, so only the
 * flag shows.
 */
export function useLocalMicIndicator(): LocalMicIndicator {
  const { t } = useTranslation();
  const selfMute = useVoiceStore((s) => s.selfMute);
  const pttActive = useVoiceStore((s) => s.pttActive);
  const inCall = useVoiceStore((s) => !!s.activeChannelId || !!s.dmCallConversationId);
  const pushToTalk = useSettingsStore((s) => s.voiceMode === 'push_to_talk');

  const pttIdle = pushToTalk && inCall && !pttActive;
  const pttHeld = inCall && pttActive; // the key overrides the mute flag
  const micOff = pttHeld ? false : selfMute || pttIdle;
  const manualMute = selfMute && !pttHeld;
  const label = pttIdle && !selfMute
    ? t('settings.audio.holdToTransmit')
    : selfMute ? t('voice.unmute') : t('voice.mute');

  return { micOff, manualMute, pttIdle, label };
}
