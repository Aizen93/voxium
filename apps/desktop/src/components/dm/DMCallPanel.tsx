import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { useLocalAudioLevel } from '../../hooks/useLocalAudioLevel';
import { Avatar } from '../common/Avatar';
import { Mic, MicOff, Headphones, HeadphoneOff, PhoneOff } from 'lucide-react';
import { clsx } from 'clsx';

export function DMCallPanel() {
  const { dmCallUsers, selfMute, selfDeaf, toggleMute, toggleDeaf, leaveDMCall } = useVoiceStore();
  const { user } = useAuthStore();
  const localAudioLevel = useLocalAudioLevel();

  const waiting = dmCallUsers.length <= 1;

  return (
    <div className="flex flex-col items-center bg-vox-bg-secondary border-b border-vox-border py-6 px-4">
      {/* User Avatars */}
      <div className="flex items-center justify-center gap-8 mb-4">
        {dmCallUsers.map((voiceUser) => {
          const isLocal = voiceUser.id === user?.id;
          const isSpeaking = isLocal
            ? (localAudioLevel > 0.05 && !selfMute)
            : voiceUser.speaking;

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
        <p className="text-sm text-vox-text-muted mb-4 animate-pulse">Calling...</p>
      )}

      {/* Controls */}
      <div className="flex items-center gap-3">
        <button
          onClick={toggleMute}
          className={clsx(
            'rounded-full p-3 transition-colors',
            selfMute
              ? 'bg-vox-accent-danger/20 text-vox-accent-danger hover:bg-vox-accent-danger/30'
              : 'bg-vox-bg-hover text-vox-text-primary hover:bg-vox-bg-active'
          )}
          title={selfMute ? 'Unmute' : 'Mute'}
        >
          {selfMute ? <MicOff size={20} /> : <Mic size={20} />}
        </button>

        <button
          onClick={toggleDeaf}
          className={clsx(
            'rounded-full p-3 transition-colors',
            selfDeaf
              ? 'bg-vox-accent-danger/20 text-vox-accent-danger hover:bg-vox-accent-danger/30'
              : 'bg-vox-bg-hover text-vox-text-primary hover:bg-vox-bg-active'
          )}
          title={selfDeaf ? 'Undeafen' : 'Deafen'}
        >
          {selfDeaf ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
        </button>

        <button
          onClick={leaveDMCall}
          className="rounded-full bg-vox-accent-danger p-3 text-white hover:bg-vox-accent-danger/80 transition-colors"
          title="Leave Call"
        >
          <PhoneOff size={20} />
        </button>
      </div>
    </div>
  );
}
