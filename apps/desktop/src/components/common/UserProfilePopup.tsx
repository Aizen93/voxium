import { useRef, useState, useCallback, useLayoutEffect, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useServerStore } from '../../stores/serverStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { Avatar } from './Avatar';
import { Volume2, Crown, Shield } from 'lucide-react';
import { format } from 'date-fns';
import { clsx } from 'clsx';

const POPUP_WIDTH = 300;
const GAP = 8;

interface Props {
  userId: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  popupProps: {
    onMouseEnter: () => void;
    onMouseLeave: () => void;
  };
  onClose: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do Not Disturb',
  offline: 'Offline',
};

const STATUS_COLORS: Record<string, string> = {
  online: 'bg-vox-accent-success',
  idle: 'bg-vox-accent-warning',
  dnd: 'bg-vox-accent-danger',
  offline: 'bg-vox-text-muted',
};

const STATUS_TEXT_COLORS: Record<string, string> = {
  online: 'text-vox-accent-success',
  idle: 'text-vox-accent-warning',
  dnd: 'text-vox-accent-danger',
  offline: 'text-vox-text-muted',
};

export function UserProfilePopup({ userId, anchorRef, popupProps, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const member = useServerStore((s) => s.members.find((m) => m.userId === userId));
  const channels = useServerStore((s) => s.channels);
  const channelUsers = useVoiceStore((s) => s.channelUsers);

  // Find voice channel this user is in
  let voiceChannelName: string | null = null;
  for (const [channelId, users] of channelUsers.entries()) {
    if (users.some((u) => u.id === userId)) {
      const ch = channels.find((c) => c.id === channelId);
      if (ch) voiceChannelName = ch.name;
      break;
    }
  }

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Horizontal: prefer RIGHT of anchor, fallback to LEFT
    let left: number;
    const spaceRight = vw - rect.right;
    if (spaceRight >= POPUP_WIDTH + GAP) {
      left = rect.right + GAP;
    } else if (rect.left >= POPUP_WIDTH + GAP) {
      left = rect.left - POPUP_WIDTH - GAP;
    } else {
      left = Math.max(GAP, vw - POPUP_WIDTH - GAP);
    }

    // Vertical: align top with anchor top, clamp to viewport
    let top = rect.top;
    const container = containerRef.current;
    const popupHeight = container?.offsetHeight || 300;
    if (top + popupHeight > vh - GAP) {
      top = Math.max(GAP, vh - popupHeight - GAP);
    }

    setPosition({ top, left });
  }, [anchorRef]);

  useLayoutEffect(() => {
    updatePosition();
    window.addEventListener('resize', updatePosition);
    return () => window.removeEventListener('resize', updatePosition);
  }, [updatePosition]);

  // Re-measure after first render when we have the actual popup height
  useEffect(() => {
    if (position) updatePosition();
    // Only run once after initial position set
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position !== null]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!member) return null;

  const { user, role, joinedAt } = member;
  const status = user.status || 'offline';

  return createPortal(
    <div
      ref={containerRef}
      className="fixed z-50"
      style={{
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        width: POPUP_WIDTH,
        visibility: position ? 'visible' : 'hidden',
      }}
      onMouseEnter={popupProps.onMouseEnter}
      onMouseLeave={popupProps.onMouseLeave}
    >
      <div className="rounded-lg border border-vox-border bg-vox-bg-floating shadow-xl overflow-hidden">
        {/* Banner strip */}
        <div className="h-14 bg-vox-accent-primary/30" />

        {/* Avatar + identity section */}
        <div className="relative px-4 pb-3">
          <div className="-mt-10 mb-2">
            <div className="rounded-full border-4 border-vox-bg-floating inline-block">
              <Avatar
                avatarUrl={user.avatarUrl}
                displayName={user.displayName}
                size="lg"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <h3 className="text-base font-bold text-vox-text-primary truncate">
              {user.displayName}
            </h3>
            {role === 'owner' && (
              <span className="shrink-0" aria-label="Owner">
                <Crown size={14} className="text-vox-accent-warning" />
              </span>
            )}
            {role === 'admin' && (
              <span className="shrink-0" aria-label="Admin">
                <Shield size={14} className="text-vox-accent-primary" />
              </span>
            )}
          </div>
          <p className="text-xs text-vox-text-muted">@{user.username}</p>

          <div className="mt-1 flex items-center gap-1.5">
            <div className={clsx('h-2.5 w-2.5 rounded-full', STATUS_COLORS[status])} />
            <span className={clsx('text-xs font-medium', STATUS_TEXT_COLORS[status])}>
              {STATUS_LABELS[status]}
            </span>
          </div>
        </div>

        {/* Divider + details */}
        <div className="border-t border-vox-border mx-3" />

        <div className="px-4 py-3 space-y-3">
          {/* Bio */}
          {user.bio && (
            <div>
              <h4 className="text-[10px] font-bold uppercase tracking-wide text-vox-text-muted mb-1">About Me</h4>
              <p className="text-xs text-vox-text-secondary leading-relaxed">{user.bio}</p>
            </div>
          )}

          {/* Voice channel */}
          {voiceChannelName && (
            <div className="flex items-center gap-1.5 text-xs text-vox-voice-connected">
              <Volume2 size={14} className="shrink-0" />
              <span>In: #{voiceChannelName}</span>
            </div>
          )}

          {/* Dates */}
          {user.createdAt && !isNaN(new Date(user.createdAt).getTime()) && (
            <div>
              <h4 className="text-[10px] font-bold uppercase tracking-wide text-vox-text-muted mb-1">Voxium Member Since</h4>
              <p className="text-xs text-vox-text-secondary">
                {format(new Date(user.createdAt), 'MMM d, yyyy')}
              </p>
            </div>
          )}
          {joinedAt && !isNaN(new Date(joinedAt).getTime()) && (
            <div>
              <h4 className="text-[10px] font-bold uppercase tracking-wide text-vox-text-muted mb-1">Joined Server</h4>
              <p className="text-xs text-vox-text-secondary">
                {format(new Date(joinedAt), 'MMM d, yyyy')}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
