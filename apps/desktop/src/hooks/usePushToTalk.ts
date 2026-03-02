import { useEffect, useRef } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { useVoiceStore } from '../stores/voiceStore';
import { getSocket } from '../services/socket';

function isTextInput(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

export function usePushToTalk() {
  const voiceMode = useSettingsStore((s) => s.voiceMode);
  const pushToTalkKey = useSettingsStore((s) => s.pushToTalkKey);
  const pressedRef = useRef(false);
  const muteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (voiceMode !== 'push_to_talk') return;

    function release() {
      if (!pressedRef.current) return;
      pressedRef.current = false;

      const { localStream, activeChannelId } = useVoiceStore.getState();
      if (!activeChannelId || !localStream) return;

      // Disable raw mic tracks — the noise gate pipeline stays running
      // but the AudioContext source outputs silence when tracks are disabled
      localStream.getAudioTracks().forEach((track) => { track.enabled = false; });

      // Debounce the mute emission to avoid flooding on rapid key taps
      if (muteTimeoutRef.current) clearTimeout(muteTimeoutRef.current);
      muteTimeoutRef.current = setTimeout(() => {
        const socket = getSocket();
        if (socket) socket.emit('voice:mute', true);
        muteTimeoutRef.current = null;
      }, 150);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.code !== pushToTalkKey) return;
      if (e.repeat) return;
      if (isTextInput(document.activeElement)) return;

      const { activeChannelId, selfMute, localStream } = useVoiceStore.getState();
      if (!activeChannelId || selfMute || !localStream) return;

      e.preventDefault();
      pressedRef.current = true;

      // Cancel any pending mute so we don't send mute→unmute back-to-back
      if (muteTimeoutRef.current) {
        clearTimeout(muteTimeoutRef.current);
        muteTimeoutRef.current = null;
      }

      // Enable raw mic tracks — noise gate pipeline handles the rest
      localStream.getAudioTracks().forEach((track) => { track.enabled = true; });

      const socket = getSocket();
      if (socket) socket.emit('voice:mute', false);
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.code !== pushToTalkKey) return;
      release();
    }

    function onBlur() {
      release();
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      if (muteTimeoutRef.current) clearTimeout(muteTimeoutRef.current);
      // Release on cleanup in case key is held when mode changes
      release();
    };
  }, [voiceMode, pushToTalkKey]);
}
