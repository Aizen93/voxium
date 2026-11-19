import { useTranslation } from 'react-i18next';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { useLocalSpeaking } from '../../hooks/useLocalSpeaking';
import { Avatar } from '../common/Avatar';
import { Mic, MicOff, Headphones, HeadphoneOff, PhoneOff } from 'lucide-react';
import { clsx } from 'clsx';

/** Rendered only during a DM call (DMChatArea), so its frame loop is too. */
export function DMCallPanel() {
  const { t } = useTranslation();
  // One selector per field: the whole store would re-render this on every
  // voice event the socket receives, the speaking of other channels included
  const dmCallUsers = useVoiceStore((s) => s.dmCallUsers);
  const selfMute = useVoiceStore((s) => s.selfMute);
  const selfDeaf = useVoiceStore((s) => s.selfDeaf);
  const pttActive = useVoiceStore((s) => s.pttActive);
  const toggleMute = useVoiceStore((s) => s.toggleMute);
  const toggleDeaf = useVoiceStore((s) => s.toggleDeaf);
  const leaveDMCall = useVoiceStore((s) => s.leaveDMCall);
  const { user } = useAuthStore();
  // Push-to-talk overrides mute: the ring can light only while either lets the mic through
  const micOpen = !selfMute || pttActive;
  const localSpeaking = useLocalSpeaking(micOpen);

  const waiting = dmCallUsers.length <= 1;

  return (
    <div className="flex flex-col items-center bg-vox-bg-secondary border-b border-vox-border py-6 px-4">
      {/* User Avatars */}
      <div className="flex items-center justify-center gap-8 mb-4">
        {dmCallUsers.map((voiceUser) => {
          const isLocal = voiceUser.id === user?.id;
          const isSpeaking = isLocal ? (localSpeaking && micOpen) : voiceUser.speaking;

          return (
            <div key={voiceUser.id} className="flex flex-col items-center gap-2">
              <Avatar
                avatarUrl={voiceUser.avatarUrl}
                displayName={voiceUser.displayName}
                size="lg"
                speaking={isSpeaking}
              />
              <span className={clsx(
                'text-sm font-medium',
                voiceUser.selfMute ? 'text-vox-text-muted' : 'text-vox-text-primary'
              )}>
                {voiceUser.displayName}
              </span>
              {(voiceUser.selfMute || voiceUser.selfDeaf) && (
                <div className="flex items-center gap-1">
                  {voiceUser.selfMute && <MicOff size={14} className="text-vox-voice-muted" />}
                  {voiceUser.selfDeaf && <HeadphoneOff size={14} className="text-vox-voice-muted" />}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Status Text */}
      {waiting && (
        <p className="text-sm text-vox-text-muted mb-4 animate-pulse">{t('dm.calling')}</p>
      )}

      {/* Controls */}
      <div className="flex items-center gap-3">
        <button
          onClick={toggleMute}
          className={clsx(
            'rounded-lg p-2.5 transition-colors',
            selfMute
              ? 'bg-vox-accent-danger/20 text-vox-accent-danger hover:bg-vox-accent-danger/30'
              : 'bg-vox-bg-hover text-vox-text-primary hover:bg-vox-bg-active'
          )}
          title={selfMute ? t('voice.unmute') : t('voice.mute')}
          aria-label={selfMute ? t('voice.unmute') : t('voice.mute')}
        >
          {selfMute ? <MicOff size={20} /> : <Mic size={20} />}
        </button>

        <button
          onClick={toggleDeaf}
          className={clsx(
            'rounded-lg p-2.5 transition-colors',
            selfDeaf
              ? 'bg-vox-accent-danger/20 text-vox-accent-danger hover:bg-vox-accent-danger/30'
              : 'bg-vox-bg-hover text-vox-text-primary hover:bg-vox-bg-active'
          )}
          title={selfDeaf ? t('voice.undeafen') : t('voice.deafen')}
          aria-label={selfDeaf ? t('voice.undeafen') : t('voice.deafen')}
        >
          {selfDeaf ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
        </button>

        <button
          onClick={leaveDMCall}
          className="rounded-full bg-vox-accent-danger p-3 text-white hover:bg-vox-accent-danger/80 transition-colors"
          title={t('dm.endCall')}
          aria-label={t('dm.endCall')}
        >
          <PhoneOff size={20} />
        </button>
      </div>
    </div>
  );
}
