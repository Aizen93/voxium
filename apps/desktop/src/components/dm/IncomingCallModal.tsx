import { useEffect } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useServerStore } from '../../stores/serverStore';
import { useDMStore } from '../../stores/dmStore';
import { useFriendStore } from '../../stores/friendStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { toast } from '../../stores/toastStore';
import { startCallRingtone, stopCallRingtone } from '../../services/notificationSounds';
import { Avatar } from '../common/Avatar';
import { Phone, PhoneOff } from 'lucide-react';

function IncomingCallContent({ incomingCall }: { incomingCall: { conversationId: string; from: { id: string; avatarUrl?: string | null; displayName: string } } }) {
  const acceptCall = useVoiceStore((s) => s.acceptCall);
  const declineCall = useVoiceStore((s) => s.declineCall);

  useEffect(() => {
    if (useSettingsStore.getState().enableNotificationSounds) {
      startCallRingtone();
    }
    return () => stopCallRingtone();
  }, []);

  const handleAccept = async () => {
    try {
      const { conversationId } = incomingCall;
      await acceptCall();

      // Ensure the conversation is in the local store (it may not be if this is a new DM)
      const dmStore = useDMStore.getState();
      if (!dmStore.conversations.some((c) => c.id === conversationId)) {
        await dmStore.fetchConversations();
      }

      // Navigate to the DM conversation so the user sees the call UI
      useServerStore.setState({ activeServerId: null, activeChannelId: null });
      useFriendStore.getState().setShowFriendsView(false);
      dmStore.setActiveConversation(conversationId);
    } catch (err) {
      console.error('Failed to accept call:', err);
      toast.error('Failed to accept call');
    }
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

export function IncomingCallModal() {
  const incomingCall = useVoiceStore((s) => s.incomingCall);
  if (!incomingCall) return null;
  return <IncomingCallContent incomingCall={incomingCall} />;
}
