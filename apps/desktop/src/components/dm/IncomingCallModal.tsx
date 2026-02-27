import { useVoiceStore } from '../../stores/voiceStore';
import { Avatar } from '../common/Avatar';
import { Phone, PhoneOff } from 'lucide-react';

export function IncomingCallModal() {
  const incomingCall = useVoiceStore((s) => s.incomingCall);
  const acceptCall = useVoiceStore((s) => s.acceptCall);
  const declineCall = useVoiceStore((s) => s.declineCall);

  if (!incomingCall) return null;

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
            onClick={acceptCall}
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
