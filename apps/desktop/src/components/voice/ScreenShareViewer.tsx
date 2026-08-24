import { useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { useAnnotationStore } from '../../stores/annotationStore';
import { useMaskLayoutStore } from '../../stores/maskLayoutStore';
import { Maximize, PictureInPicture2, MonitorOff } from 'lucide-react';
import { AnnotationCanvas } from './AnnotationCanvas';
import { AnnotationToolbar } from './AnnotationToolbar';
import { AnnotationEditorLayer, ALL_EDITOR_TOOLS, type ToolCapabilities } from './AnnotationEditorLayer';
import { availableToolDefs } from './annotationPresets';
import { useAnnotationShortcuts } from '../../hooks/useAnnotationShortcuts';
import { useStageZoom, ZoomPill, MagnifierLens } from './StageZoom';
import { ReactionStrip, ReactionOverlay } from './Reactions';
import { SnapshotMenu } from './SnapshotMenu';
import { useAnnotationLiveStore } from '../../stores/annotationLiveStore';

// A board has nothing to cover — every tool but the privacy mask
const WHITEBOARD_CAPABILITIES: ToolCapabilities = {
  tools: new Set(ALL_EDITOR_TOOLS),
  masks: false,
  images: true,
};

export function ScreenShareViewer() {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const { screenSharingUserId, remoteScreenStream, screenStream, isScreenSharing, screenShareFrozen, channelUsers, activeChannelId } = useVoiceStore();
  const localUserId = useAuthStore((s) => s.user?.id);
  const setViewMode = useVoiceStore((s) => s.setScreenShareViewMode);
  const stopScreenShare = useVoiceStore((s) => s.stopScreenShare);
  const isEditing = useAnnotationStore((s) => s.isEditing);
  const sourceChangeHold = useAnnotationStore((s) => s.sourceChangeHold);
  const confirmSourceChange = useAnnotationStore((s) => s.confirmSourceChange);
  const setIsEditing = useAnnotationStore((s) => s.setIsEditing);
  const annotationsVersion = useVoiceStore((s) => s.screenShareAnnotationsVersion);
  const appliedLayout = useMaskLayoutStore((s) => s.appliedLayout);
  const snapshotNotice = useAnnotationLiveStore((s) => s.snapshotNotice);
  const shareKind = useVoiceStore((s) => s.shareKind);
  const keepApplied = useMaskLayoutStore((s) => s.keepApplied);
  const startFresh = useMaskLayoutStore((s) => s.startFresh);

  const isLocalSharing = screenSharingUserId === localUserId;
  const zoomStageRef = useRef<HTMLDivElement>(null);
  // Keys follow the toolbar exactly: the same list, the same v2 gate. The
  // hook is a no-op while not editing, so mounting it unconditionally is fine.
  const shortcutTools = useMemo(() => (isLocalSharing ? availableToolDefs(annotationsVersion) : []), [isLocalSharing, annotationsVersion]);
  useAnnotationShortcuts(shortcutTools);
  const stream = isLocalSharing ? screenStream : remoteScreenStream;
  // Zoom is CLIENT-ONLY and disabled while the sharer edits — the editor maps
  // pointer to normalized coords from an untransformed layer rect (disabling
  // also RESETS, so the layer never mounts transformed).
  const { zoom, style: zoomStyle, handlers: zoomHandlers, reset: resetZoom } = useStageZoom(
    zoomStageRef,
    !!stream && !(isLocalSharing && isEditing),
  );

  // Find the sharer's display name
  const users = activeChannelId ? channelUsers.get(activeChannelId) || [] : [];
  const sharer = users.find((u) => u.id === screenSharingUserId);
  const sharerName = sharer?.displayName || t('voice.someone');

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

  // Fullscreen the stage wrapper, NOT the bare <video> — the annotation
  // canvas is a DOM sibling and would be invisible in element fullscreen.
  const handleFullscreen = () => {
    if (stageRef.current) {
      stageRef.current.requestFullscreen?.();
    }
  };

  return (
    <div className="flex h-full flex-col bg-black">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-vox-bg-secondary border-b border-vox-border">
        <span className="text-sm text-vox-text-primary">
          {isLocalSharing ? t('voice.youAreSharing') : t('voice.userIsSharing', { name: sharerName })}
        </span>
        <div className="flex items-center gap-1">
          {stream && <SnapshotMenu videoRef={videoRef} sharerName={sharerName} />}
          <button
            onClick={handleFullscreen}
            className="rounded p-1.5 text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary transition-colors"
            title={t('voice.fullscreen')}
            aria-label={t('voice.fullscreen')}
          >
            <Maximize size={16} />
          </button>
          <button
            onClick={() => setViewMode('floating')}
            className="rounded p-1.5 text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary transition-colors"
            title={t('voice.popOut')}
            aria-label={t('voice.popOut')}
          >
            <PictureInPicture2 size={16} />
          </button>
          {isScreenSharing && (
            <button
              onClick={stopScreenShare}
              className="rounded p-1.5 text-vox-accent-danger hover:bg-vox-accent-danger/20 transition-colors"
              title={t('voice.stopSharing')}
              aria-label={t('voice.stopSharing')}
            >
              <MonitorOff size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Stage = the fullscreen target. The toolbar and the frozen banner live
          INSIDE it, or the sharer would lose all editing controls (and the
          only warning that viewers see a frozen share) the moment they go
          fullscreen — the Fullscreen API renders nothing outside the target. */}
      <div ref={stageRef} className="flex flex-1 flex-col min-h-0 bg-black">
        {isLocalSharing && <AnnotationToolbar />}
        {isLocalSharing && appliedLayout && (
          <div className="flex items-center justify-center gap-3 bg-vox-accent-info/90 px-3 py-1 text-xs font-medium text-white" data-testid="layout-applied-banner">
            <span>{t('voice.annotations.layoutApplied', { count: appliedLayout.count })}</span>
            <button
              onClick={keepApplied}
              className="rounded bg-black/20 px-2 py-0.5 font-semibold hover:bg-black/30"
              data-testid="layout-keep"
            >
              {t('voice.annotations.layoutKeep')}
            </button>
            <button
              onClick={startFresh}
              className="rounded bg-black/20 px-2 py-0.5 font-semibold hover:bg-black/30"
              data-testid="layout-fresh"
            >
              {t('voice.annotations.layoutFresh')}
            </button>
          </div>
        )}
        {isLocalSharing && sourceChangeHold && (
          <div className="flex items-center justify-center gap-3 bg-vox-accent-warning/90 px-3 py-1 text-xs font-medium text-black" data-testid="source-change-banner">
            <span>
              {t('voice.annotations.sourceChanged', {
                from: `${sourceChangeHold.fromW}×${sourceChangeHold.fromH}`,
                to: `${sourceChangeHold.toW}×${sourceChangeHold.toH}`,
              })}
            </span>
            <button
              onClick={() => { setIsEditing(true); useAnnotationStore.getState().setActiveTool('mask'); }}
              className="rounded bg-black/20 px-2 py-0.5 font-semibold hover:bg-black/30"
            >
              {t('voice.annotations.sourceChangedEdit')}
            </button>
            <button
              onClick={confirmSourceChange}
              className="rounded bg-black/20 px-2 py-0.5 font-semibold hover:bg-black/30"
              data-testid="source-change-resume"
            >
              {t('voice.annotations.sourceChangedResume')}
            </button>
          </div>
        )}
        {isLocalSharing && screenShareFrozen && !sourceChangeHold && (
          <div className="bg-vox-accent-danger/90 px-3 py-1 text-center text-xs font-medium text-white">
            {t('voice.annotations.sharePaused')}
          </div>
        )}
        <div
          ref={zoomStageRef}
          className="relative flex flex-1 items-center justify-center min-h-0 overflow-hidden"
          {...zoomHandlers}
        >
          {stream ? (
            <>
              {/* The transformed parent holds BOTH the video and the canvas,
                  so the overlay stays registered to the pixels at any zoom */}
              <div className="relative flex h-full w-full items-center justify-center" style={zoomStyle} data-testid="zoom-surface">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  preload="none"
                  className="max-h-full max-w-full object-contain"
                />
                <AnnotationCanvas videoRef={videoRef} />
                {isLocalSharing && isEditing && (
                  <AnnotationEditorLayer videoRef={videoRef} capabilities={shareKind === 'whiteboard' ? WHITEBOARD_CAPABILITIES : undefined} />
                )}
              </div>
              <ZoomPill zoom={zoom} onReset={resetZoom} />
              <MagnifierLens videoRef={videoRef} stageRef={zoomStageRef} disabled={zoom.scale > 1 || (isLocalSharing && isEditing)} />
              {/* Reactions are UI, not content: siblings of the zoom surface so they never scale */}
              <ReactionOverlay />
              <ReactionStrip />
              {isLocalSharing && snapshotNotice && (
                <div className="absolute left-2 top-2 z-20 rounded bg-black/70 px-2 py-1 text-xs text-white" data-testid="snapshot-notice">
                  {t('voice.snapshot.notice', {
                    name: users.find((u) => u.id === snapshotNotice.userId)?.displayName || t('voice.someone'),
                  })}
                </div>
              )}
            </>
          ) : (
            <p className="text-vox-text-muted text-sm">{t('voice.waitingForStream')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
