import { useVoiceStore } from '../../stores/voiceStore';
import { useDMStore } from '../../stores/dmStore';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { useLocalAudioLevel } from '../../hooks/useLocalAudioLevel';
import { UserHoverTarget } from '../common/UserHoverTarget';
import { Mic, MicOff, Headphones, HeadphoneOff, PhoneOff, Phone } from 'lucide-react';
import { clsx } from 'clsx';

/**
 * Global DM voice panel — mirrors VoicePanel but for DM calls.
 * Renders in both ChannelSidebar (server view) and DMList (DM view)
 * so the user always sees their active DM call.
 */
export function DMVoicePanel() {
  const dmCallConversationId = useVoiceStore((s) => s.dmCallConversationId);
  const dmCallUsers = useVoiceStore((s) => s.dmCallUsers);
  const selfMute = useVoiceStore((s) => s.selfMute);
  const selfDeaf = useVoiceStore((s) => s.selfDeaf);
  const toggleMute = useVoiceStore((s) => s.toggleMute);
  const toggleDeaf = useVoiceStore((s) => s.toggleDeaf);
  const leaveDMCall = useVoiceStore((s) => s.leaveDMCall);
  const { user } = useAuthStore();
  const localAudioLevel = useLocalAudioLevel();

  const conversations = useDMStore((s) => s.conversations);
  const setActiveConversation = useDMStore((s) => s.setActiveConversation);
  const activeServerId = useServerStore((s) => s.activeServerId);

  if (!dmCallConversationId) return null;

  const conversation = conversations.find((c) => c.id === dmCallConversationId);
  const participantName = conversation?.participant.displayName || 'DM Call';
  const waiting = dmCallUsers.length <= 1;

  const handleNavigateToCall = () => {
    // Clear active server to switch to DM view, then open the conversation
    if (activeServerId) {
      useServerStore.setState({ activeServerId: null });
    }
    setActiveConversation(dmCallConversationId);
  };

  return (
    <div data-testid="dm-voice-panel" className="border-t border-vox-border bg-vox-sidebar">
      {/* Call Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-vox-border">
        <button
          onClick={handleNavigateToCall}
          className="flex min-w-0 flex-1 items-center gap-2 text-left hover:opacity-80 transition-opacity"
        >
          <Phone size={14} className="shrink-0 text-vox-voice-connected" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-vox-voice-connected">
              {waiting ? 'Calling...' : 'In a Call'}
            </p>
            <p className="truncate text-[10px] text-vox-text-muted">
              {participantName}
            </p>
          </div>
        </button>
        <button
          onClick={leaveDMCall}
          className="shrink-0 rounded-md p-1.5 text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-accent-danger transition-colors"
          title="Disconnect"
        >
          <PhoneOff size={16} />
        </button>
      </div>

      {/* Call Users */}
      {dmCallUsers.length > 0 && (
        <div className="max-h-24 overflow-y-auto px-2 py-1">
          {dmCallUsers.map((voiceUser) => {
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

      {/* Call Controls */}
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
      </div>
    </div>
  );
}
