import { useRef, useState, useCallback, useLayoutEffect, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useServerStore } from '../../stores/serverStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { useDMStore } from '../../stores/dmStore';
import { useFriendStore } from '../../stores/friendStore';
import { Avatar } from './Avatar';
import { Volume2, Crown, Shield, MessageSquare, UserPlus, UserMinus, Check, X, Clock, Flag } from 'lucide-react';
import { toast } from '../../stores/toastStore';
import { format } from 'date-fns';
import { clsx } from 'clsx';
import { api } from '../../services/api';
import { StaffBadge } from './StaffBadge';
import { ReportModal } from '../chat/ReportModal';

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

  // Fallback: fetch user profile from API when not in server members list (e.g. DM context)
  const [showReport, setShowReport] = useState(false);
  const [fetchedUser, setFetchedUser] = useState<{
    id: string; username: string; displayName: string;
    avatarUrl: string | null; bio?: string | null; status?: string; role?: string; createdAt?: string;
  } | null>(null);

  useEffect(() => {
    if (member) return;
    api.get(`/users/${userId}`).then((res: any) => {
      if (res.data?.data) setFetchedUser(res.data.data);
    }).catch(() => {});
  }, [userId, member]);

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
  }, [position !== null]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const currentUser = useAuthStore((s) => s.user);
  const isOwnProfile = currentUser?.id === userId;

  const handleOpenDM = async () => {
    try {
      const conversationId = await useDMStore.getState().openDM(userId);
      useServerStore.setState({ activeServerId: null, activeChannelId: null });
      useDMStore.getState().setActiveConversation(conversationId);
      onClose();
    } catch {
      toast.error('Failed to open conversation');
    }
  };

  const friends = useFriendStore((s) => s.friends);
  const pendingIncoming = useFriendStore((s) => s.pendingIncoming);
  const pendingOutgoing = useFriendStore((s) => s.pendingOutgoing);

  const friendshipInfo = useMemo(() => {
    const friend = friends.find((f) => f.user.id === userId);
    if (friend) return { status: 'friends' as const, friendshipId: friend.id };
    const incoming = pendingIncoming.find((f) => f.user.id === userId);
    if (incoming) return { status: 'pending_incoming' as const, friendshipId: incoming.id };
    const outgoing = pendingOutgoing.find((f) => f.user.id === userId);
    if (outgoing) return { status: 'pending_outgoing' as const, friendshipId: outgoing.id };
    return { status: 'none' as const, friendshipId: null };
  }, [friends, pendingIncoming, pendingOutgoing, userId]);

  const handleAddFriend = async () => {
    const username = member?.user.username ?? fetchedUser?.username;
    if (!username) return;
    try {
      const status = await useFriendStore.getState().sendRequest(username);
      toast.success(status === 'accepted' ? `You and ${username} are now friends!` : 'Friend request sent');
    } catch (err: any) {
      const msg = err.response?.data?.error || 'Failed to send friend request';
      toast.error(msg);
    }
  };

  const handleAcceptFriend = async () => {
    if (!friendshipInfo.friendshipId) return;
    try {
      await useFriendStore.getState().acceptRequest(friendshipInfo.friendshipId);
    } catch {
      toast.error('Failed to accept friend request');
    }
  };

  const handleDeclineFriend = async () => {
    if (!friendshipInfo.friendshipId) return;
    try {
      await useFriendStore.getState().removeFriendship(friendshipInfo.friendshipId);
    } catch {
      toast.error('Failed to decline friend request');
    }
  };

  const handleRemoveFriend = async () => {
    if (!friendshipInfo.friendshipId) return;
    try {
      await useFriendStore.getState().removeFriendship(friendshipInfo.friendshipId);
    } catch {
      toast.error('Failed to remove friend');
    }
  };

  // Resolve user data from server member or fallback API fetch
  const user = member?.user ?? fetchedUser;
  if (!user) return null;

  const role = member?.role ?? null;
  const joinedAt = member?.joinedAt ?? null;
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
          <div className="flex items-center gap-1.5">
            <p className="text-xs text-vox-text-muted">@{user.username}</p>
            {(user.role === 'admin' || user.role === 'superadmin') && <StaffBadge />}
          </div>

          <div className="mt-1 flex items-center gap-1.5">
            <div className={clsx('h-2.5 w-2.5 rounded-full', STATUS_COLORS[status])} />
            <span className={clsx('text-xs font-medium', STATUS_TEXT_COLORS[status])}>
              {STATUS_LABELS[status]}
            </span>
          </div>
        </div>

        {/* Action buttons */}
        {!isOwnProfile && (
          <div className="px-4 pb-2 flex gap-2">
            <button
              onClick={handleOpenDM}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-vox-accent-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-vox-accent-hover transition-colors"
            >
              <MessageSquare size={12} />
              Message
            </button>
            {friendshipInfo.status === 'none' && (
              <button
                onClick={handleAddFriend}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-vox-accent-success px-3 py-1.5 text-xs font-medium text-white hover:bg-vox-accent-success/80 transition-colors"
              >
                <UserPlus size={12} />
                Add Friend
              </button>
            )}
            {friendshipInfo.status === 'pending_outgoing' && (
              <button
                disabled
                className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-vox-bg-hover px-3 py-1.5 text-xs font-medium text-vox-text-muted cursor-not-allowed"
              >
                <Clock size={12} />
                Pending
              </button>
            )}
            {friendshipInfo.status === 'pending_incoming' && (
              <>
                <button
                  onClick={handleAcceptFriend}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-vox-accent-success px-3 py-1.5 text-xs font-medium text-white hover:bg-vox-accent-success/80 transition-colors"
                >
                  <Check size={12} />
                  Accept
                </button>
                <button
                  onClick={handleDeclineFriend}
                  className="flex items-center justify-center gap-1.5 rounded-md bg-vox-bg-hover px-2 py-1.5 text-xs font-medium text-vox-text-muted hover:bg-vox-accent-danger/20 hover:text-vox-accent-danger transition-colors"
                >
                  <X size={12} />
                </button>
              </>
            )}
            {friendshipInfo.status === 'friends' && (
              <button
                onClick={handleRemoveFriend}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-vox-bg-hover px-3 py-1.5 text-xs font-medium text-vox-text-muted hover:bg-vox-accent-danger/20 hover:text-vox-accent-danger transition-colors"
              >
                <UserMinus size={12} />
                Unfriend
              </button>
            )}
          </div>
        )}

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

        {/* Report User */}
        {!isOwnProfile && (
          <div className="border-t border-vox-border px-4 py-2">
            <button
              onClick={() => setShowReport(true)}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs rounded-md text-vox-accent-danger hover:bg-vox-accent-danger/10 transition-colors"
            >
              <Flag size={12} /> Report User
            </button>
          </div>
        )}
      </div>

      {showReport && (
        <ReportModal
          type="user"
          reportedUserId={userId}
          onClose={() => setShowReport(false)}
        />
      )}
    </div>,
    document.body
  );
}
