import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { useServerStore } from '../../stores/serverStore';
import { getTranslatedError } from '../../utils/serverErrors';
import { useVoiceStore } from '../../stores/voiceStore';
import { useChatStore } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';
import { Volume2, Plus, ChevronRight, MicOff, HeadphoneOff, UserPlus, Trash2, FolderPlus, GripVertical, Monitor, Shield, Settings, AudioLines, Lock, Users, LogOut, Copy } from 'lucide-react';
import { InviteModal } from '../server/InviteModal';
import { ServerSettingsModal } from '../server/ServerSettingsModal';
import { ChannelPermissionsEditor } from '../server/ChannelPermissionsEditor';
import { SecureChannelCreateModal } from '../server/SecureChannelCreateModal';
import { SecureChannelMembersModal } from '../server/SecureChannelMembersModal';
import { VoicePanel } from '../voice/VoicePanel';
import { MemberContextMenu } from '../server/MemberContextMenu';
import { DMVoicePanel } from '../voice/DMVoicePanel';
import { Avatar } from '../common/Avatar';
import { UserHoverTarget } from '../common/UserHoverTarget';
import { toast } from '../../stores/toastStore';
import { copyToClipboard } from '../../utils/clipboard';
import { clsx } from 'clsx';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Permissions, hasPermission, permissionsFromString } from '@voxium/shared';
import type { Channel, Category } from '@voxium/shared';
import { isSecureVoiceSupported } from '../../services/e2e/voiceFrameTransform';

const COLLAPSED_KEY = 'voxium_collapsed_categories';
const CH_PREFIX = 'ch-';
const CAT_PREFIX = 'cat-';
const UNCAT_DROPPABLE = 'uncategorized';

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* ignore */ }
  return new Set();
}

function saveCollapsed(collapsed: Set<string>) {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
}

// ─── Sortable Channel Item ──────────────────────────────────────────────────

function SortableChannelItem({
  channel,
  isAdmin,
  isActive,
  isVoiceActive,
  unread,
  voiceUsers,
  currentUserId,
  onSelectText,
  onJoinVoice,
  onDelete,
  onContextMenu,
  onVoiceUserContextMenu,
}: {
  channel: Channel;
  isAdmin: boolean;
  isActive: boolean;
  isVoiceActive: boolean;
  unread: number;
  voiceUsers: { id: string; displayName: string; avatarUrl: string | null; selfMute: boolean; selfDeaf: boolean; serverMuted: boolean; serverDeafened: boolean; speaking: boolean; screenSharing?: boolean }[];
  currentUserId: string | undefined;
  // members lookup for nickname resolution is done via store hook below
  onSelectText: (id: string) => void;
  onJoinVoice: (id: string) => void;
  onDelete: (id: string) => void;
  onContextMenu?: (e: React.MouseEvent, channel: Channel) => void;
  onVoiceUserContextMenu?: (e: React.MouseEvent, userId: string) => void;
}) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: CH_PREFIX + channel.id, disabled: !isAdmin });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const isText = channel.type === 'text';

  // An occupied voice channel is the liveliest thing in the sidebar, so it
  // renders as an elevated card rather than a quiet row: bold header with a
  // live count, the participants, and an explicit Join affordance. The card
  // border picks up the accent when it is YOUR channel.
  if (!isText && voiceUsers.length > 0) {
    return (
      <div ref={setNodeRef} style={style}>
        <div
          data-testid="voice-channel-card"
          onContextMenu={(e) => { if (onContextMenu) { e.preventDefault(); e.stopPropagation(); onContextMenu(e, channel); } }}
          className={clsx(
            'group my-1 overflow-hidden rounded-xl border bg-vox-bg-floating transition-colors',
            isVoiceActive ? 'border-vox-accent-primary/35' : 'border-vox-border',
          )}
        >
          <div className="flex h-[34px] w-full items-center gap-1 px-2">
            {isAdmin && (
              <button
                {...attributes}
                {...listeners}
                className="shrink-0 cursor-grab opacity-0 group-hover:opacity-60 hover:!opacity-100 text-vox-text-muted touch-none"
                tabIndex={-1}
              >
                <GripVertical size={12} />
              </button>
            )}
            <button
              onClick={() => onJoinVoice(channel.id)}
              className="flex min-w-0 flex-1 items-center gap-2 text-[13.5px] font-semibold text-vox-text-primary"
            >
              <Volume2 size={15} className="shrink-0" />
              <span className="truncate">{channel.name}</span>
            </button>
            <span className="shrink-0 text-[11px] font-medium tabular-nums text-vox-text-muted">
              {voiceUsers.length}
            </span>
            {isAdmin && (
              <button
                onClick={() => onDelete(channel.id)}
                className="shrink-0 opacity-0 group-hover:opacity-100 text-vox-text-muted hover:text-vox-accent-danger transition-all"
                title={t('channel.deleteChannel')}
                aria-label={t('channel.deleteChannel')}
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
          <VoiceUserList voiceUsers={voiceUsers} currentUserId={currentUserId} onContextMenu={onVoiceUserContextMenu || (() => {})} />
          {!isVoiceActive && (
            <div className="px-1.5 pb-1.5 pt-1">
              <button
                onClick={() => onJoinVoice(channel.id)}
                className="tint flex h-[30px] w-full items-center justify-center rounded-lg text-[12.5px] font-semibold transition-colors hover:bg-vox-accent-tint-strong"
              >
                {t('channel.joinVoice')}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={setNodeRef} style={style}>
      <div
        onContextMenu={(e) => { if (onContextMenu) { e.preventDefault(); e.stopPropagation(); onContextMenu(e, channel); } }}
        className={clsx(
          'group flex h-[31px] w-full items-center gap-1 rounded-md px-1.5 text-[13.5px] transition-colors',
          isText
            ? isActive
              ? 'bg-vox-accent-tint text-vox-text-primary font-semibold'
              : unread > 0
                ? 'text-vox-text-primary font-semibold hover:bg-vox-bg-hover'
                : 'text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-secondary'
            : isVoiceActive
              ? 'bg-vox-accent-tint text-vox-text-primary font-semibold'
              : 'text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-secondary'
        )}
      >
        {isAdmin && (
          <button
            {...attributes}
            {...listeners}
            className="shrink-0 cursor-grab opacity-0 group-hover:opacity-60 hover:!opacity-100 text-vox-text-muted touch-none"
            tabIndex={-1}
          >
            <GripVertical size={12} />
          </button>
        )}
        <button
          onClick={() => isText ? onSelectText(channel.id) : onJoinVoice(channel.id)}
          className="flex min-w-0 flex-1 items-center gap-2"
        >
          {isText
            ? (
              <span
                aria-hidden
                className={clsx(
                  'w-3 shrink-0 text-center font-mono text-[13px] leading-none',
                  isActive ? 'text-vox-accent-primary' : 'text-vox-text-muted/70',
                )}
              >
                #
              </span>
            )
            : <Volume2 size={15} className={clsx('shrink-0', isVoiceActive ? 'text-vox-voice-connected' : 'opacity-60')} />
          }
          <span className="truncate">{channel.name}</span>
        </button>
        {isText && unread > 0 && (
          <span className="flex h-[17px] min-w-[17px] shrink-0 items-center justify-center rounded-full bg-vox-accent-primary px-[5px] text-[10.5px] font-bold text-vox-on-accent">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
        {isAdmin && (
          <button
            onClick={() => onDelete(channel.id)}
            className="shrink-0 opacity-0 group-hover:opacity-100 text-vox-text-muted hover:text-vox-accent-danger transition-all"
            title={t('channel.deleteChannel')}
            aria-label={t('channel.deleteChannel')}
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Sortable Category Header ───────────────────────────────────────────────

// ─── Voice User List (with nickname resolution) ─────────────────────────────

function VoiceUserList({ voiceUsers, currentUserId, onContextMenu }: {
  voiceUsers: { id: string; displayName: string; avatarUrl: string | null; selfMute: boolean; selfDeaf: boolean; serverMuted: boolean; serverDeafened: boolean; speaking: boolean; screenSharing?: boolean }[];
  currentUserId: string | undefined;
  onContextMenu: (e: React.MouseEvent, userId: string) => void;
}) {
  const { t } = useTranslation();
  const members = useServerStore((s) => s.members);

  return (
    <div className="space-y-0.5 px-1.5">
      {voiceUsers.map((vu) => {
        const member = members.find((m) => m.userId === vu.id);
        const name = member?.nickname || vu.displayName;
        const roleColor = member?.roles?.length
          ? [...member.roles].sort((a, b) => b.position - a.position)[0]?.color
          : null;

        return (
          <UserHoverTarget key={vu.id} userId={vu.id}>
            <div
              data-testid={`voice-user-${vu.id}`}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-vox-bg-hover cursor-default"
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(e, vu.id); }}
            >
              <Avatar
                avatarUrl={vu.avatarUrl}
                displayName={vu.displayName}
                size="xs"
                speaking={vu.speaking}
              />
              <span
                className={clsx(
                  'text-xs truncate flex-1',
                  vu.id === currentUserId ? 'font-medium' : '',
                  // The person talking right now surfaces to full brightness,
                  // like the mock — unless a role color owns the name.
                  !roleColor && (vu.speaking ? 'text-vox-text-primary' : 'text-vox-text-secondary')
                )}
                style={roleColor ? { color: roleColor } : undefined}
              >
                {name}
                {vu.id === currentUserId && ` ${t('channel.you')}`}
              </span>
              <div className="flex items-center gap-0.5 shrink-0">
                {vu.speaking && <AudioLines size={11} className="text-vox-voice-speaking" />}
                {vu.screenSharing && <Monitor size={10} className="text-vox-voice-connected" />}
                {vu.serverMuted && <span title={t('channel.serverMuted')}><MicOff size={10} className="text-vox-accent-danger" /></span>}
                {vu.selfMute && !vu.serverMuted && <MicOff size={10} className="text-vox-voice-muted" />}
                {vu.serverDeafened && <span title={t('channel.serverDeafened')}><HeadphoneOff size={10} className="text-vox-accent-danger" /></span>}
                {vu.selfDeaf && !vu.serverDeafened && <HeadphoneOff size={10} className="text-vox-voice-muted" />}
              </div>
            </div>
          </UserHoverTarget>
        );
      })}
    </div>
  );
}

// ─── Sortable Category Header ───────────────────────────────────────────────

function SortableCategoryHeader({
  category,
  isAdmin,
  isCollapsed,
  onToggle,
  onCreateChannel,
  onDelete,
  children,
}: {
  category: Category;
  isAdmin: boolean;
  isCollapsed: boolean;
  onToggle: () => void;
  onCreateChannel: (catId: string) => void;
  onDelete: (catId: string) => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: CAT_PREFIX + category.id, disabled: !isAdmin });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="mt-4 first:mt-0">
      <div className="mb-1 flex items-center justify-between px-1 group/cat">
        {isAdmin && (
          <button
            {...attributes}
            {...listeners}
            className="shrink-0 cursor-grab opacity-0 group-hover/cat:opacity-60 hover:!opacity-100 text-vox-text-muted touch-none mr-0.5"
            tabIndex={-1}
          >
            <GripVertical size={10} />
          </button>
        )}
        <button
          onClick={onToggle}
          className="section-label flex min-w-0 flex-1 items-center gap-1 hover:text-vox-text-secondary transition-colors"
        >
          <ChevronRight
            size={12}
            className={clsx('shrink-0 transition-transform', !isCollapsed && 'rotate-90')}
          />
          <span className="truncate">{category.name}</span>
        </button>
        {isAdmin && (
          <div className="flex items-center gap-0.5 opacity-0 group-hover/cat:opacity-100 transition-opacity">
            <button
              onClick={() => onCreateChannel(category.id)}
              className="text-vox-text-muted hover:text-vox-text-primary transition-colors"
              title={t('channel.createChannel')}
              aria-label={t('channel.createChannel')}
            >
              <Plus size={14} />
            </button>
            <button
              onClick={() => onDelete(category.id)}
              className="text-vox-text-muted hover:text-vox-accent-danger transition-colors"
              title={t('channel.deleteCategory')}
              aria-label={t('channel.deleteCategory')}
            >
              <Trash2 size={12} />
            </button>
          </div>
        )}
      </div>

      {!isCollapsed && children}
    </div>
  );
}

// ─── Channel Drag Overlay (ghost while dragging) ────────────────────────────

function ChannelOverlay({ channel }: { channel: Channel }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-vox-bg-active px-2 py-1.5 text-sm text-vox-text-primary font-medium shadow-lg border border-vox-border w-52">
      {channel.type === 'text'
        ? <span aria-hidden className="w-3 shrink-0 text-center font-mono text-[13px] leading-none text-vox-text-muted/70">#</span>
        : <Volume2 size={16} className="shrink-0 opacity-60" />
      }
      <span className="truncate">{channel.name}</span>
    </div>
  );
}

function CategoryOverlay({ category }: { category: Category }) {
  return (
    <div className="flex items-center gap-1 rounded bg-vox-bg-active px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-vox-text-primary shadow-lg border border-vox-border w-52">
      <ChevronRight size={12} className="shrink-0 rotate-90" />
      <span className="truncate">{category.name}</span>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function ChannelSidebar() {
  const { t } = useTranslation();
  const { channels, categories, activeChannelId, setActiveChannel, activeServerId, servers, createChannel, deleteChannel, createCategory, deleteCategory, members, unreadCounts, reorderCategories, reorderChannels, fetchEffectivePermissions, leaveSecureChannel } = useServerStore();
  const { joinChannel, activeChannelId: voiceChannelId, channelUsers } = useVoiceStore();
  const { clearMessages, fetchMessages } = useChatStore();
  const { user } = useAuthStore();
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showServerSettings, setShowServerSettings] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [createChannelCategoryId, setCreateChannelCategoryId] = useState<string | null>(null);
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelType, setNewChannelType] = useState<'text' | 'voice'>('text');
  const [showCreateCategory, setShowCreateCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [channelContextMenu, setChannelContextMenu] = useState<{ channel: Channel; position: { x: number; y: number } } | null>(null);
  const [voiceUserCtx, setVoiceUserCtx] = useState<{ userId: string; position: { x: number; y: number } } | null>(null);
  const [permissionsEditorChannel, setPermissionsEditorChannel] = useState<{ id: string; name: string; type: 'text' | 'voice' } | null>(null);
  const [showSecureCreate, setShowSecureCreate] = useState(false);
  const [secureMembersChannel, setSecureMembersChannel] = useState<{ id: string; name: string } | null>(null);
  const [canCreateSecure, setCanCreateSecure] = useState(false);
  const ctxRef = useRef<HTMLDivElement>(null);

  const activeServer = servers.find((s) => s.id === activeServerId);
  const currentMember = members.find((m) => m.userId === user?.id);
  const isAdmin = currentMember?.role === 'owner' || currentMember?.role === 'admin';
  // Encoded-transform support decides whether secure VOICE channels are
  // joinable on this runtime at all (spec §21) — stable per session
  const secureVoiceSupported = useMemo(() => isSecureVoiceSupported(), []);

  // Fingerprint of everything that can change THIS user's effective server
  // permissions: legacy role, assigned role ids, and those roles' bitmasks.
  // Live role edits update the store, which re-runs the permission fetch below
  // — without it, a freshly granted CREATE_SECURE_CHANNELS would not show the
  // create control until the next server switch.
  const roles = useServerStore((s) => s.roles);
  const myPermsKey = useMemo(() => {
    const assigned = new Set((currentMember?.roles ?? []).map((r) => r.id));
    const bits = roles
      .filter((r) => r.isDefault || assigned.has(r.id))
      .map((r) => `${r.id}:${r.permissions}`)
      .sort()
      .join('|');
    return `${currentMember?.role ?? ''}|${bits}`;
  }, [currentMember, roles]);

  // Secure-channel creation is gated on the PERMISSION BIT, not the legacy
  // member.role field — a custom role can carry CREATE_SECURE_CHANNELS.
  useEffect(() => {
    setCanCreateSecure(false);
    if (!activeServerId) return;
    let cancelled = false;
    fetchEffectivePermissions(activeServerId)
      .then((bits) => {
        if (!cancelled) {
          setCanCreateSecure(hasPermission(permissionsFromString(bits), Permissions.CREATE_SECURE_CHANNELS));
        }
      })
      .catch((err) => console.warn('[SecureChannel] Failed to fetch effective permissions:', err));
    return () => { cancelled = true; };
  }, [activeServerId, myPermsKey, fetchEffectivePermissions]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  // Persist collapsed state
  useEffect(() => {
    saveCollapsed(collapsed);
  }, [collapsed]);

  const toggleCollapsed = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Close channel context menu on outside click or Escape
  useEffect(() => {
    if (!channelContextMenu) return;
    function handleClick(e: MouseEvent) {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) {
        setChannelContextMenu(null);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setChannelContextMenu(null);
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [channelContextMenu]);

  // Adjust context menu position to stay within viewport
  useEffect(() => {
    if (channelContextMenu && ctxRef.current) {
      const rect = ctxRef.current.getBoundingClientRect();
      let x = channelContextMenu.position.x;
      let y = channelContextMenu.position.y;
      if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
      if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
      if (x < 0) x = 8;
      if (y < 0) y = 8;
      if (x !== channelContextMenu.position.x || y !== channelContextMenu.position.y) {
        setChannelContextMenu({ ...channelContextMenu, position: { x, y } });
      }
    }
  }, [channelContextMenu]);

  const handleVoiceUserContextMenu = useCallback((e: React.MouseEvent, userId: string) => {
    // Close channel context menu if open
    setChannelContextMenu(null);
    setVoiceUserCtx({ userId, position: { x: e.clientX, y: e.clientY } });
  }, []);

  const handleChannelContextMenu = useCallback((e: React.MouseEvent, channel: Channel) => {
    // Secure channels: every member gets a menu (members/leave; the creator
    // manage items). Plaintext channels keep the admin-only menu.
    if (!channel.secure && !isAdmin) return;
    setChannelContextMenu({ channel, position: { x: e.clientX, y: e.clientY } });
  }, [isAdmin]);

  // Secure channels render in their own section — visible at all only because
  // the server listed them for us (membership); never draggable/categorized
  const secureChannels = useMemo(
    () => channels.filter((c) => c.secure === true).sort((a, b) => a.name.localeCompare(b.name)),
    [channels]
  );

  // Sort channels within each group by position (secure ones excluded)
  const channelsByCategory = useMemo(() => {
    const map = new Map<string | null, Channel[]>();
    for (const ch of channels) {
      if (ch.secure) continue;
      const key = ch.categoryId ?? null;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(ch);
    }
    // Sort each group by position
    for (const [, chs] of map) {
      chs.sort((a, b) => a.position - b.position);
    }
    return map;
  }, [channels]);

  const sortedCategories = useMemo(
    () => [...categories].sort((a, b) => a.position - b.position),
    [categories]
  );

  const uncategorizedChannels = channelsByCategory.get(null) || [];

  // Sortable IDs for DndContext
  const categoryIds = useMemo(
    () => sortedCategories.map((c) => CAT_PREFIX + c.id),
    [sortedCategories]
  );

  const uncategorizedChannelIds = useMemo(
    () => uncategorizedChannels.map((c) => CH_PREFIX + c.id),
    [uncategorizedChannels]
  );

  // ─── Handlers ───────────────────────────────────────────────────────────

  const handleSelectTextChannel = (channelId: string) => {
    setActiveChannel(channelId);
    clearMessages();
    fetchMessages(channelId);
  };

  const handleJoinVoice = (channelId: string) => {
    joinChannel(channelId, activeServerId ?? undefined);
  };

  const handleCreateChannel = async () => {
    if (!activeServerId || !newChannelName.trim()) return;
    try {
      await createChannel(activeServerId, newChannelName.trim(), newChannelType, createChannelCategoryId || undefined);
      toast.success(t('channel.channelCreated'));
      setNewChannelName('');
      setShowCreateChannel(false);
    } catch (err) {
      toast.error(getTranslatedError(err, t, 'channel.failedToCreateChannel'));
    }
  };

  const handleDeleteChannel = async (channelId: string) => {
    if (!activeServerId) return;
    try {
      await deleteChannel(activeServerId, channelId);
      toast.success(t('channel.channelDeleted'));
    } catch {
      toast.error(t('channel.failedToDeleteChannel'));
    }
  };

  const handleLeaveSecureChannel = async (channelId: string) => {
    if (!activeServerId || !user?.id) return;
    try {
      await leaveSecureChannel(activeServerId, channelId, user.id);
      toast.success(t('secureChannel.left'));
    } catch (err) {
      toast.error(getTranslatedError(err, t, 'secureChannel.failedToLeave'));
    }
  };

  // The one sanctioned way a secure channel's id leaves its membership.
  // Admins cannot list secure channels (§19 opacity) — their only lever is
  // delete-by-id in server settings — so a member who wants one shut down
  // hands the id over. Messages in secure channels cannot be reported; the
  // members deal with each other, and this is how they escalate.
  const handleCopySecureChannelId = async (channelId: string) => {
    try {
      await copyToClipboard(channelId);
      toast.success(t('secureChannel.idCopied'));
    } catch (err) {
      console.warn('[SecureChannel] Failed to copy channel id:', err);
      toast.error(t('secureChannel.idCopyFailed'));
    }
  };

  const handleCreateCategory = async () => {
    if (!activeServerId || !newCategoryName.trim()) return;
    try {
      await createCategory(activeServerId, newCategoryName.trim());
      toast.success(t('channel.categoryCreated'));
      setNewCategoryName('');
      setShowCreateCategory(false);
    } catch {
      toast.error(t('channel.failedToCreateCategory'));
    }
  };

  const handleDeleteCategory = async (categoryId: string) => {
    if (!activeServerId) return;
    try {
      await deleteCategory(activeServerId, categoryId);
      toast.success(t('channel.categoryDeleted'));
    } catch {
      toast.error(t('channel.failedToDeleteCategory'));
    }
  };

  const openCreateChannel = (categoryId: string | null, type: 'text' | 'voice') => {
    setCreateChannelCategoryId(categoryId);
    setNewChannelType(type);
    setShowCreateChannel(true);
  };

  // ─── DnD Handlers ──────────────────────────────────────────────────────

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  };

  const handleDragCancel = () => {
    setActiveDragId(null);
  };

  // Determine which container (category) a sortable id lives in
  const findContainerForChannel = useCallback((sortableId: string): string | null => {
    const chId = sortableId.replace(CH_PREFIX, '');
    const ch = channels.find((c) => c.id === chId);
    return ch?.categoryId ?? null;
  }, [channels]);

  const handleDragOver = (_event: DragOverEvent) => {
    // We handle everything in onDragEnd for simplicity
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over || !activeServerId) return;

    const activeId = active.id as string;
    const overId = over.id as string;
    if (activeId === overId) return;

    const isCategory = activeId.startsWith(CAT_PREFIX);
    const isChannel = activeId.startsWith(CH_PREFIX);

    if (isCategory) {
      // Reorder categories
      const draggedCatId = activeId.replace(CAT_PREFIX, '');
      const overCatId = overId.replace(CAT_PREFIX, '');

      const oldIndex = sortedCategories.findIndex((c) => c.id === draggedCatId);
      const newIndex = sortedCategories.findIndex((c) => c.id === overCatId);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = [...sortedCategories];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);

      const order = reordered.map((c, i) => ({ id: c.id, position: i }));
      reorderCategories(activeServerId, order);
    } else if (isChannel) {
      const draggedChId = activeId.replace(CH_PREFIX, '');

      // Determine target container
      let targetCategoryId: string | null;
      if (overId === UNCAT_DROPPABLE || overId.startsWith(CH_PREFIX)) {
        // Dropped on a channel — find its container
        if (overId === UNCAT_DROPPABLE) {
          targetCategoryId = null;
        } else {
          targetCategoryId = findContainerForChannel(overId);
        }
      } else if (overId.startsWith(CAT_PREFIX)) {
        // Dropped on a category header — put it in that category
        targetCategoryId = overId.replace(CAT_PREFIX, '');
      } else {
        return;
      }

      const sourceCategoryId = findContainerForChannel(activeId);

      // Get channels in the target container
      const targetChannels = [...(channelsByCategory.get(targetCategoryId) || [])];

      if (sourceCategoryId === targetCategoryId) {
        // Same container — simple reorder
        const overChId = overId.replace(CH_PREFIX, '');
        const oldIndex = targetChannels.findIndex((c) => c.id === draggedChId);
        const newIndex = targetChannels.findIndex((c) => c.id === overChId);
        if (oldIndex === -1 || newIndex === -1) return;

        const [moved] = targetChannels.splice(oldIndex, 1);
        targetChannels.splice(newIndex, 0, moved);

        const order = targetChannels.map((c, i) => ({
          id: c.id,
          position: i,
          categoryId: targetCategoryId,
        }));
        reorderChannels(activeServerId, order);
      } else {
        // Cross-container move
        const sourceChannels = [...(channelsByCategory.get(sourceCategoryId) || [])];
        const draggedChannel = sourceChannels.find((c) => c.id === draggedChId);
        if (!draggedChannel) return;

        // Remove from source
        const filteredSource = sourceChannels.filter((c) => c.id !== draggedChId);

        // Insert into target
        if (overId.startsWith(CH_PREFIX)) {
          const overChId = overId.replace(CH_PREFIX, '');
          const overIndex = targetChannels.findIndex((c) => c.id === overChId);
          targetChannels.splice(overIndex >= 0 ? overIndex : targetChannels.length, 0, draggedChannel);
        } else {
          // Dropped on category header or uncategorized zone — append
          targetChannels.push(draggedChannel);
        }

        // Build combined order for all affected channels
        const order = [
          ...filteredSource.map((c, i) => ({ id: c.id, position: i, categoryId: sourceCategoryId })),
          ...targetChannels.map((c, i) => ({ id: c.id, position: i, categoryId: targetCategoryId })),
        ];
        reorderChannels(activeServerId, order);
      }
    }
  };

  // ─── Drag overlay content ─────────────────────────────────────────────

  const dragOverlayContent = useMemo(() => {
    if (!activeDragId) return null;
    if (activeDragId.startsWith(CAT_PREFIX)) {
      const cat = categories.find((c) => c.id === activeDragId.replace(CAT_PREFIX, ''));
      return cat ? <CategoryOverlay category={cat} /> : null;
    }
    if (activeDragId.startsWith(CH_PREFIX)) {
      const ch = channels.find((c) => c.id === activeDragId.replace(CH_PREFIX, ''));
      return ch ? <ChannelOverlay channel={ch} /> : null;
    }
    return null;
  }, [activeDragId, categories, channels]);

  // ─── Render ───────────────────────────────────────────────────────────

  const onlineCount = members.filter((m) => m.user.status && m.user.status !== 'offline').length;

  return (
    <div className="flex h-full w-full flex-col bg-vox-channel">
      {/* Server name header — open row on the page background, no border box */}
      <div className="flex h-10 flex-none items-center gap-2 px-3 pt-1">
        <h2 className="truncate text-[14.5px] font-semibold tracking-[-0.01em] text-vox-text-primary">
          {activeServer?.name || t('channel.server')}
        </h2>
        <span className="ml-auto whitespace-nowrap text-[11px] text-vox-text-muted/80">
          {onlineCount} {t('channel.online').toLowerCase()}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setShowInviteModal(true)}
            className="flex h-[26px] w-[26px] items-center justify-center rounded-md text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary transition-colors"
            title={t('channel.invitePeople')}
            aria-label={t('channel.invitePeople')}
          >
            <UserPlus size={15} />
          </button>
          {isAdmin && (
            <button
              onClick={() => setShowServerSettings(true)}
              className="flex h-[26px] w-[26px] items-center justify-center rounded-md text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary transition-colors"
              title={t('channel.serverSettings')}
              aria-label={t('channel.serverSettings')}
            >
              <Settings size={15} />
            </button>
          )}
        </div>
      </div>

      {/* Channels list */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          {/* Uncategorized channels */}
          {uncategorizedChannels.length > 0 && (
            <div className="mb-1">
              <SortableContext items={uncategorizedChannelIds} strategy={verticalListSortingStrategy}>
                {uncategorizedChannels.map((ch) => (
                  <SortableChannelItem
                    key={ch.id}
                    channel={ch}
                    isAdmin={isAdmin}
                    isActive={activeChannelId === ch.id}
                    isVoiceActive={voiceChannelId === ch.id}
                    unread={ch.type === 'text' && activeChannelId !== ch.id ? (unreadCounts[ch.id] || 0) : 0}
                    voiceUsers={ch.type !== 'text' ? (channelUsers.get(ch.id) || []) : []}
                    currentUserId={user?.id}
                    onSelectText={handleSelectTextChannel}
                    onJoinVoice={handleJoinVoice}
                    onDelete={handleDeleteChannel}
                    onContextMenu={handleChannelContextMenu}
                    onVoiceUserContextMenu={handleVoiceUserContextMenu}
                  />
                ))}
              </SortableContext>
            </div>
          )}

          {/* Categories — sortable among themselves */}
          <SortableContext items={categoryIds} strategy={verticalListSortingStrategy}>
            {sortedCategories.map((cat) => {
              const catChannels = channelsByCategory.get(cat.id) || [];
              const catChannelIds = catChannels.map((c) => CH_PREFIX + c.id);

              return (
                <SortableCategoryHeader
                  key={cat.id}
                  category={cat}
                  isAdmin={isAdmin}
                  isCollapsed={collapsed.has(cat.id)}
                  onToggle={() => toggleCollapsed(cat.id)}
                  onCreateChannel={(catId) => openCreateChannel(catId, 'text')}
                  onDelete={handleDeleteCategory}
                >
                  <SortableContext items={catChannelIds} strategy={verticalListSortingStrategy}>
                    {catChannels.map((ch) => (
                      <SortableChannelItem
                        key={ch.id}
                        channel={ch}
                        isAdmin={isAdmin}
                        isActive={activeChannelId === ch.id}
                        isVoiceActive={voiceChannelId === ch.id}
                        unread={ch.type === 'text' && activeChannelId !== ch.id ? (unreadCounts[ch.id] || 0) : 0}
                        voiceUsers={ch.type !== 'text' ? (channelUsers.get(ch.id) || []) : []}
                        currentUserId={user?.id}
                        onSelectText={handleSelectTextChannel}
                        onJoinVoice={handleJoinVoice}
                        onDelete={handleDeleteChannel}
                        onContextMenu={handleChannelContextMenu}
                        onVoiceUserContextMenu={handleVoiceUserContextMenu}
                      />
                    ))}
                  </SortableContext>
                </SortableCategoryHeader>
              );
            })}
          </SortableContext>

          <DragOverlay dropAnimation={null}>
            {dragOverlayContent}
          </DragOverlay>
        </DndContext>

        {/* Secure channels — invite-only, E2E-encrypted. Only ever present in
            the list because this user is a member. Not draggable, not
            categorizable, no permission overrides. */}
        {(secureChannels.length > 0 || canCreateSecure) && (
          <div className="mt-2" data-testid="secure-channels-section">
            <div className="group mb-0.5 flex items-center gap-1 px-1.5">
              <span className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-vox-text-muted">
                <Lock size={10} />
                {t('secureChannel.sectionTitle')}
              </span>
              {canCreateSecure && (
                <button
                  onClick={() => setShowSecureCreate(true)}
                  className="ml-auto flex h-5 w-5 items-center justify-center rounded text-vox-text-muted opacity-0 transition-opacity hover:text-vox-text-primary group-hover:opacity-100"
                  title={t('secureChannel.createTitle')}
                  aria-label={t('secureChannel.createTitle')}
                  data-testid="secure-channel-create-open"
                >
                  <Plus size={13} />
                </button>
              )}
            </div>
            {secureChannels.map((ch) => {
              // Secure VOICE channel: joins E2E voice instead of opening chat.
              // Hard-gated on encoded-transform support — no plaintext fallback.
              if (ch.type === 'voice') {
                const occupants = channelUsers.get(ch.id) || [];
                const voiceSupported = secureVoiceSupported;
                return (
                  <div key={ch.id} className="mb-0.5">
                    <button
                      onClick={() => voiceSupported && handleJoinVoice(ch.id)}
                      onContextMenu={(e) => { e.preventDefault(); handleChannelContextMenu(e, ch); }}
                      disabled={!voiceSupported}
                      className={clsx(
                        'group flex w-full items-center gap-1.5 rounded-md px-1.5 py-[5px] text-left text-[14px] transition-colors',
                        !voiceSupported
                          ? 'cursor-not-allowed text-vox-text-muted/50'
                          : voiceChannelId === ch.id
                            ? 'bg-vox-bg-active text-vox-voice-connected'
                            : 'text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-secondary'
                      )}
                      title={voiceSupported ? undefined : t('secureVoice.unsupported')}
                      data-testid={`secure-voice-channel-${ch.name}`}
                    >
                      <Lock size={13} className="shrink-0 text-vox-accent-primary/80" />
                      <Volume2 size={15} className={clsx('shrink-0', voiceChannelId === ch.id ? 'text-vox-voice-connected' : 'opacity-60')} />
                      <span className="truncate">{ch.name}</span>
                      {occupants.length > 0 && (
                        <span className="ml-auto text-[11px] text-vox-text-muted">{occupants.length}</span>
                      )}
                    </button>
                    {occupants.length > 0 && (
                      <VoiceUserList voiceUsers={occupants} currentUserId={user?.id} onContextMenu={handleVoiceUserContextMenu} />
                    )}
                  </div>
                );
              }
              const unread = activeChannelId !== ch.id ? (unreadCounts[ch.id] || 0) : 0;
              return (
                <button
                  key={ch.id}
                  onClick={() => handleSelectTextChannel(ch.id)}
                  onContextMenu={(e) => { e.preventDefault(); handleChannelContextMenu(e, ch); }}
                  className={clsx(
                    'group flex w-full items-center gap-1.5 rounded-md px-1.5 py-[5px] text-left text-[14px] transition-colors',
                    activeChannelId === ch.id
                      ? 'bg-vox-bg-active text-vox-text-primary'
                      : 'text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-secondary'
                  )}
                  data-testid={`secure-channel-${ch.name}`}
                >
                  <Lock size={13} className="shrink-0 text-vox-accent-primary/80" />
                  <span className="truncate">{ch.name}</span>
                  {unread > 0 && (
                    <span className="ml-auto rounded-full bg-vox-accent-danger px-1.5 text-[11px] font-semibold text-white">
                      {unread > 99 ? '99+' : unread}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Create Channel Inline */}
        {showCreateChannel && (
          <div className="mt-2 rounded-lg border border-vox-border bg-vox-bg-floating p-3">
            <input
              type="text"
              className="input mb-2 text-sm"
              placeholder={t('channel.newChannelPlaceholder', { type: newChannelType === 'text' ? t('channel.text').toLowerCase() : t('channel.voiceType').toLowerCase() })}
              value={newChannelName}
              onChange={(e) => setNewChannelName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateChannel()}
              autoFocus
            />
            <div className="flex gap-2 mb-2">
              <button
                onClick={() => setNewChannelType('text')}
                className={clsx('flex-1 py-1 text-xs rounded', newChannelType === 'text' ? 'btn-primary' : 'btn-ghost')}
              >
                {t('channel.text')}
              </button>
              <button
                onClick={() => setNewChannelType('voice')}
                className={clsx('flex-1 py-1 text-xs rounded', newChannelType === 'voice' ? 'btn-primary' : 'btn-ghost')}
              >
                {t('channel.voiceType')}
              </button>
            </div>
            <div className="flex gap-2">
              <button onClick={handleCreateChannel} className="btn-primary flex-1 py-1 text-xs">
                {t('channel.create')}
              </button>
              <button onClick={() => setShowCreateChannel(false)} className="btn-ghost flex-1 py-1 text-xs">
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}

        {/* Create Category Inline */}
        {showCreateCategory && (
          <div className="mt-2 rounded-lg border border-vox-border bg-vox-bg-floating p-3">
            <input
              type="text"
              className="input mb-2 text-sm"
              placeholder={t('channel.newCategoryName')}
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateCategory()}
              autoFocus
            />
            <div className="flex gap-2">
              <button onClick={handleCreateCategory} className="btn-primary flex-1 py-1 text-xs">
                {t('channel.create')}
              </button>
              <button onClick={() => setShowCreateCategory(false)} className="btn-ghost flex-1 py-1 text-xs">
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}

        {/* Admin: Create Category button */}
        {isAdmin && !showCreateCategory && (
          <button
            onClick={() => setShowCreateCategory(true)}
            className="mt-2 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-vox-text-muted hover:text-vox-text-secondary hover:bg-vox-bg-hover transition-colors"
          >
            <FolderPlus size={14} />
            <span>{t('channel.createCategory')}</span>
          </button>
        )}
      </div>

      {/* Voice panels (below the channel list; the shared UserCard rendered by
          MainLayout sits directly beneath this component) */}
      <VoicePanel />
      <DMVoicePanel />

      {showInviteModal && activeServerId && (
        <InviteModal serverId={activeServerId} onClose={() => setShowInviteModal(false)} />
      )}
      {showServerSettings && activeServerId && (
        <ServerSettingsModal serverId={activeServerId} onClose={() => setShowServerSettings(false)} />
      )}

      {/* Channel right-click context menu */}
      {channelContextMenu && channelContextMenu.channel.secure && createPortal(
        <div
          ref={ctxRef}
          className="fixed z-[9999] min-w-44 rounded-lg border border-vox-border bg-vox-bg-floating p-1.5 shadow-xl animate-fade-in"
          style={{ left: channelContextMenu.position.x, top: channelContextMenu.position.y }}
        >
          {/* Members: every channel member can view; the creator manages */}
          <button
            onClick={() => {
              setSecureMembersChannel({ id: channelContextMenu.channel.id, name: channelContextMenu.channel.name });
              setChannelContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
            data-testid="secure-channel-members"
          >
            <Users size={16} className="text-vox-accent-primary" />
            {t('secureChannel.members')}
          </button>
          <button
            onClick={() => {
              void handleCopySecureChannelId(channelContextMenu.channel.id);
              setChannelContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
            title={t('secureChannel.copyIdHint')}
            data-testid="secure-channel-copy-id"
          >
            <Copy size={16} className="text-vox-text-muted" />
            {t('secureChannel.copyId')}
          </button>
          {channelContextMenu.channel.createdById === user?.id ? (
            <button
              onClick={() => {
                handleDeleteChannel(channelContextMenu.channel.id);
                setChannelContextMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-vox-accent-danger hover:bg-vox-accent-danger/10 transition-colors"
              data-testid="secure-channel-delete"
            >
              <Trash2 size={16} />
              {t('channel.deleteChannel')}
            </button>
          ) : (
            <button
              onClick={() => {
                handleLeaveSecureChannel(channelContextMenu.channel.id);
                setChannelContextMenu(null);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-vox-accent-danger hover:bg-vox-accent-danger/10 transition-colors"
              data-testid="secure-channel-leave"
            >
              <LogOut size={16} />
              {t('secureChannel.leave')}
            </button>
          )}
        </div>,
        document.body
      )}
      {channelContextMenu && !channelContextMenu.channel.secure && isAdmin && createPortal(
        <div
          ref={ctxRef}
          className="fixed z-[9999] min-w-44 rounded-lg border border-vox-border bg-vox-bg-floating p-1.5 shadow-xl animate-fade-in"
          style={{ left: channelContextMenu.position.x, top: channelContextMenu.position.y }}
        >
          <button
            onClick={() => {
              setPermissionsEditorChannel({ id: channelContextMenu.channel.id, name: channelContextMenu.channel.name, type: channelContextMenu.channel.type as 'text' | 'voice' });
              setChannelContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
          >
            <Shield size={16} className="text-vox-accent-primary" />
            {t('channel.editPermissions')}
          </button>
          <button
            onClick={() => {
              handleDeleteChannel(channelContextMenu.channel.id);
              setChannelContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-vox-accent-danger hover:bg-vox-accent-danger/10 transition-colors"
          >
            <Trash2 size={16} />
            {t('channel.deleteChannel')}
          </button>
        </div>,
        document.body
      )}

      {/* Secure channel modals */}
      {showSecureCreate && activeServerId && (
        <SecureChannelCreateModal serverId={activeServerId} onClose={() => setShowSecureCreate(false)} />
      )}
      {secureMembersChannel && activeServerId && (
        <SecureChannelMembersModal
          serverId={activeServerId}
          channelId={secureMembersChannel.id}
          channelName={secureMembersChannel.name}
          onClose={() => setSecureMembersChannel(null)}
        />
      )}

      {/* Channel permissions editor */}
      {permissionsEditorChannel && activeServerId && (
        <ChannelPermissionsEditor
          serverId={activeServerId}
          channelId={permissionsEditorChannel.id}
          channelName={permissionsEditorChannel.name}
          channelType={permissionsEditorChannel.type}
          onClose={() => setPermissionsEditorChannel(null)}
        />
      )}

      {/* Voice user right-click menu */}
      {voiceUserCtx && members.find((m) => m.userId === voiceUserCtx.userId) && (
        <MemberContextMenu
          member={members.find((m) => m.userId === voiceUserCtx.userId)!}
          position={voiceUserCtx.position}
          onClose={() => setVoiceUserCtx(null)}
        />
      )}
    </div>
  );
}
