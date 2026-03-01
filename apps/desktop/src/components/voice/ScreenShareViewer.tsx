import { useRef, useEffect } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { Maximize, PictureInPicture2, MonitorOff } from 'lucide-react';

export function ScreenShareViewer() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { screenSharingUserId, remoteScreenStream, screenStream, isScreenSharing, channelUsers, activeChannelId } = useVoiceStore();
  const localUserId = useAuthStore((s) => s.user?.id);
  const setViewMode = useVoiceStore((s) => s.setScreenShareViewMode);
  const stopScreenShare = useVoiceStore((s) => s.stopScreenShare);

  const isLocalSharing = screenSharingUserId === localUserId;
  const stream = isLocalSharing ? screenStream : remoteScreenStream;

  // Find the sharer's display name
  const users = activeChannelId ? channelUsers.get(activeChannelId) || [] : [];
  const sharer = users.find((u) => u.id === screenSharingUserId);
  const sharerName = sharer?.displayName || 'Someone';

  useEffect(() => {
    const video = videoRef.current;
    if (video && stream) {
      video.srcObject = stream;
    }
    return () => {
      if (video) {
        video.srcObject = null;
      }
    };
  }, [stream]);

  const handleFullscreen = () => {
    if (videoRef.current) {
      videoRef.current.requestFullscreen?.();
    }
  };

  return (
    <div className="flex h-full flex-col bg-black">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-vox-bg-secondary border-b border-vox-border">
        <span className="text-sm text-vox-text-primary">
          <span className="font-semibold">{isLocalSharing ? 'You are' : sharerName + ' is'}</span>
          {' '}sharing their screen
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleFullscreen}
            className="rounded p-1.5 text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary transition-colors"
            title="Fullscreen"
          >
            <Maximize size={16} />
          </button>
          <button
            onClick={() => setViewMode('floating')}
            className="rounded p-1.5 text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary transition-colors"
            title="Pop out to floating panel"
          >
            <PictureInPicture2 size={16} />
          </button>
          {isScreenSharing && (
            <button
              onClick={stopScreenShare}
              className="rounded p-1.5 text-vox-accent-danger hover:bg-vox-accent-danger/20 transition-colors"
              title="Stop sharing"
            >
              <MonitorOff size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Video */}
      <div className="flex flex-1 items-center justify-center min-h-0">
        {stream ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <p className="text-vox-text-muted text-sm">Waiting for screen share stream...</p>
        )}
      </div>
    </div>
  );
}
