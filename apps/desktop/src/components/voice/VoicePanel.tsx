import { useVoiceStore } from '../../stores/voiceStore';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { useLocalAudioLevel } from '../../hooks/useLocalAudioLevel';
import { ConnectionQuality } from './ConnectionQuality';
import { UserHoverTarget } from '../common/UserHoverTarget';
import { Mic, MicOff, Headphones, HeadphoneOff, PhoneOff, Monitor, MonitorOff } from 'lucide-react';
import { clsx } from 'clsx';

export function VoicePanel() {
  const { activeChannelId, channelUsers, selfMute, selfDeaf, toggleMute, toggleDeaf, leaveChannel, latency, isScreenSharing, screenSharingUserId, startScreenShare, stopScreenShare } = useVoiceStore();
  const { channels } = useServerStore();
  const { user } = useAuthStore();
  const localAudioLevel = useLocalAudioLevel();

  if (!activeChannelId) return null;

  const channel = channels.find((c) => c.id === activeChannelId);
  const users = channelUsers.get(activeChannelId) || [];

  const latencyColor = latency === null ? 'text-vox-text-muted' :
    latency < 100 ? 'text-vox-voice-connected' :
    latency < 200 ? 'text-vox-accent-warning' :
    'text-vox-accent-danger';

  return (
    <div className="fixed bottom-0 left-[72px] w-60 border-t border-vox-border bg-vox-sidebar">
      {/* Voice Connected Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-vox-border">
        <ConnectionQuality latency={latency} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="text-xs font-semibold text-vox-voice-connected">
              Voice Connected
            </p>
            {latency !== null && (
              <span className={clsx('text-[10px] font-medium', latencyColor)}>
                {latency}ms
              </span>
            )}
          </div>
          <p className="truncate text-[10px] text-vox-text-muted">
            {channel?.name || 'Voice Channel'}
          </p>
        </div>
        <button
          onClick={leaveChannel}
          className="rounded-md p-1.5 text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-accent-danger transition-colors"
          title="Disconnect"
        >
          <PhoneOff size={16} />
        </button>
      </div>

      {/* Voice Users */}
      {users.length > 0 && (
        <div className="max-h-32 overflow-y-auto px-2 py-1">
          {users.map((voiceUser) => {
            const isLocal = voiceUser.id === user?.id;
            const isSpeaking = isLocal ? (localAudioLevel > 0.05 && !selfMute) : voiceUser.speaking;

            return (
              <UserHoverTarget key={voiceUser.id} userId={voiceUser.id}>
                <div className="flex items-center gap-2 rounded px-2 py-1">
                  <div className={clsx(
                    'h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-semibold text-white ring-2 transition-all',
                    isSpeaking ? 'ring-vox-voice-speaking bg-vox-voice-speaking' :
                    voiceUser.selfMute ? 'ring-vox-voice-muted bg-vox-bg-hover' :
                    'ring-transparent bg-vox-accent-primary'
                  )}>
                    {voiceUser.displayName?.[0]?.toUpperCase() || '?'}
                  </div>
                  <span className={clsx(
                    'text-xs truncate flex-1',
                    voiceUser.selfMute ? 'text-vox-text-muted' : 'text-vox-text-primary'
                  )}>
                    {voiceUser.displayName}
                  </span>
                  {voiceUser.selfMute && <MicOff size={12} className="text-vox-voice-muted" />}
                  {voiceUser.selfDeaf && <HeadphoneOff size={12} className="text-vox-voice-muted" />}
                </div>
              </UserHoverTarget>
            );
          })}
        </div>
      )}

      {/* Voice Controls */}
      <div className="flex items-center justify-center gap-2 px-3 py-2 border-t border-vox-border">
        <button
          onClick={toggleMute}
          className={clsx(
            'rounded-full p-2 transition-colors',
            selfMute
              ? 'bg-vox-accent-danger/20 text-vox-accent-danger hover:bg-vox-accent-danger/30'
              : 'bg-vox-bg-hover text-vox-text-primary hover:bg-vox-bg-active'
          )}
          title={selfMute ? 'Unmute' : 'Mute'}
        >
          {selfMute ? <MicOff size={18} /> : <Mic size={18} />}
        </button>

        <button
          onClick={toggleDeaf}
          className={clsx(
            'rounded-full p-2 transition-colors',
            selfDeaf
              ? 'bg-vox-accent-danger/20 text-vox-accent-danger hover:bg-vox-accent-danger/30'
              : 'bg-vox-bg-hover text-vox-text-primary hover:bg-vox-bg-active'
          )}
          title={selfDeaf ? 'Undeafen' : 'Deafen'}
        >
          {selfDeaf ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
        </button>

        {/* Screen Share */}
        {(() => {
          const otherSharing = screenSharingUserId && screenSharingUserId !== user?.id;
          return (
            <button
              onClick={() => isScreenSharing ? stopScreenShare() : startScreenShare()}
              disabled={!!otherSharing}
              className={clsx(
                'rounded-full p-2 transition-colors',
                isScreenSharing
                  ? 'bg-vox-voice-connected/20 text-vox-voice-connected hover:bg-vox-accent-danger/20 hover:text-vox-accent-danger'
                  : otherSharing
                    ? 'bg-vox-bg-hover text-vox-text-muted cursor-not-allowed opacity-50'
                    : 'bg-vox-bg-hover text-vox-text-primary hover:bg-vox-bg-active'
              )}
              title={isScreenSharing ? 'Stop Sharing' : otherSharing ? 'Someone is already sharing' : 'Share Screen'}
            >
              {isScreenSharing ? <MonitorOff size={18} /> : <Monitor size={18} />}
            </button>
          );
        })()}
      </div>
    </div>
  );
}
