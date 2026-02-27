import { useVoiceStore } from '../../stores/voiceStore';
import { useServerStore } from '../../stores/serverStore';
import { useDMStore } from '../../stores/dmStore';
import { useFriendStore } from '../../stores/friendStore';
import { Avatar } from '../common/Avatar';
import { Phone, PhoneOff } from 'lucide-react';

export function IncomingCallModal() {
  const incomingCall = useVoiceStore((s) => s.incomingCall);
  const acceptCall = useVoiceStore((s) => s.acceptCall);
  const declineCall = useVoiceStore((s) => s.declineCall);

  if (!incomingCall) return null;

  const handleAccept = async () => {
    const { conversationId } = incomingCall;
    await acceptCall();
    // Navigate to the DM conversation so the user sees the call UI
    useServerStore.setState({ activeServerId: null, activeChannelId: null });
    useFriendStore.getState().setShowFriendsView(false);
    useDMStore.getState().setActiveConversation(conversationId);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="flex w-72 flex-col items-center gap-4 rounded-lg bg-vox-bg-secondary p-6 shadow-xl animate-fade-in">
        <Avatar
          avatarUrl={incomingCall.from.avatarUrl}
          displayName={incomingCall.from.displayName}
          size="lg"
        />
        <div className="text-center">
          <p className="text-sm font-semibold text-vox-text-primary">
            {incomingCall.from.displayName}
          </p>
          <p className="text-xs text-vox-text-muted">Incoming voice call...</p>
        </div>

        <div className="flex gap-4">
          <button
            onClick={declineCall}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-vox-accent-danger text-white transition-colors hover:bg-vox-accent-danger/80"
            title="Decline"
          >
            <PhoneOff size={20} />
          </button>
          <button
            onClick={handleAccept}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-vox-voice-connected text-white transition-colors hover:bg-vox-voice-connected/80"
            title="Accept"
          >
            <Phone size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}
