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
      useVoiceStore.setState({ pttActive: false });

      const { localStream, activeChannelId, dmCallConversationId } = useVoiceStore.getState();
      if ((!activeChannelId && !dmCallConversationId) || !localStream) return;

      // Disable raw mic tracks
      localStream.getAudioTracks().forEach((track) => { track.enabled = false; });

      // Pause SFU audio producer (server voice only)
      if (activeChannelId) {
        const { msProducers } = useVoiceStore.getState();
        for (const producer of msProducers.values()) {
          if (producer.kind === 'audio') producer.pause();
        }
      }

      // Debounce the mute emission to avoid flooding on rapid key taps
      if (muteTimeoutRef.current) clearTimeout(muteTimeoutRef.current);
      muteTimeoutRef.current = setTimeout(() => {
        const socket = getSocket();
        if (socket) {
          if (activeChannelId) socket.emit('voice:mute', true);
          else if (dmCallConversationId) socket.emit('dm:voice:mute', true);
        }
        muteTimeoutRef.current = null;
      }, 150);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.code !== pushToTalkKey) return;
      if (e.repeat) return;
      if (isTextInput(document.activeElement)) return;

      const { activeChannelId, dmCallConversationId, localStream } = useVoiceStore.getState();
      // PTT overrides mute — no selfMute check. The key press temporarily unmutes.
      if ((!activeChannelId && !dmCallConversationId) || !localStream) return;

      e.preventDefault();
      pressedRef.current = true;
      useVoiceStore.setState({ pttActive: true });

      // Cancel any pending mute so we don't send mute→unmute back-to-back
      if (muteTimeoutRef.current) {
        clearTimeout(muteTimeoutRef.current);
        muteTimeoutRef.current = null;
      }

      // Enable raw mic tracks
      localStream.getAudioTracks().forEach((track) => { track.enabled = true; });

      // Resume SFU audio producer (server voice only)
      if (activeChannelId) {
        const { msProducers } = useVoiceStore.getState();
        for (const producer of msProducers.values()) {
          if (producer.kind === 'audio') producer.resume();
        }
      }

      const socket = getSocket();
      if (socket) {
        if (activeChannelId) socket.emit('voice:mute', false);
        else if (dmCallConversationId) socket.emit('dm:voice:mute', false);
      }
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
      release();
    };
  }, [voiceMode, pushToTalkKey]);
}
