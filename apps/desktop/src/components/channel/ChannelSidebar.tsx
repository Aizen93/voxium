import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { useServerStore } from '../../stores/serverStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useChatStore } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';
import { Hash, Volume2, Plus, ChevronRight, Mic, MicOff, Headphones, HeadphoneOff, UserPlus, Trash2, FolderPlus, GripVertical, Monitor, Shield } from 'lucide-react';
import { InviteModal } from '../server/InviteModal';
import { ServerSettingsModal } from '../server/ServerSettingsModal';
import { ChannelPermissionsEditor } from '../server/ChannelPermissionsEditor';
import { VoicePanel } from '../voice/VoicePanel';
import { MemberContextMenu } from '../server/MemberContextMenu';
import { DMVoicePanel } from '../voice/DMVoicePanel';
import { Avatar } from '../common/Avatar';
import { UserHoverTarget } from '../common/UserHoverTarget';
import { toast } from '../../stores/toastStore';
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
import type { Channel, Category } from '@voxium/shared';

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

  return (
    <div ref={setNodeRef} style={style}>
      <div
        onContextMenu={(e) => { if (onContextMenu) { e.preventDefault(); e.stopPropagation(); onContextMenu(e, channel); } }}
        className={clsx(
          'group flex w-full items-center gap-1 rounded-md px-1 py-1.5 text-sm transition-colors',
          isText
            ? isActive
              ? 'bg-vox-bg-active text-vox-text-primary font-medium'
              : unread > 0
                ? 'text-vox-text-primary font-semibold hover:bg-vox-bg-hover'
                : 'text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-secondary'
            : isVoiceActive
              ? 'bg-vox-bg-active text-vox-voice-connected font-medium'
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
          className="flex min-w-0 flex-1 items-center gap-1.5"
        >
          {isText
            ? <Hash size={16} className="shrink-0 opacity-60" />
            : <Volume2 size={16} className="shrink-0 opacity-60" />
          }
          <span className="truncate">{channel.name}</span>
        </button>
        {isText && unread > 0 && (
          <span className="bg-vox-accent-primary text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 shrink-0">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
        {isAdmin && (
          <button
            onClick={() => onDelete(channel.id)}
            className="shrink-0 opacity-0 group-hover:opacity-100 text-vox-text-muted hover:text-vox-accent-danger transition-all"
            title="Delete channel"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>

      {/* Voice users */}
      {!isText && voiceUsers.length > 0 && (
        <VoiceUserList voiceUsers={voiceUsers} currentUserId={currentUserId} onContextMenu={onVoiceUserContextMenu || (() => {})} />
      )}
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
  const members = useServerStore((s) => s.members);

  return (
    <div className="ml-4 mt-0.5 space-y-0.5">
      {voiceUsers.map((vu) => {
        const member = members.find((m) => m.userId === vu.id);
        const name = member?.nickname || vu.displayName;
        const roleColor = member?.roles?.length
          ? [...member.roles].sort((a, b) => b.position - a.position)[0]?.color
          : null;

        return (
          <UserHoverTarget key={vu.id} userId={vu.id}>
            <div
              className="flex items-center gap-1.5 rounded px-2 py-1 hover:bg-vox-bg-hover/50 cursor-default"
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
                  !roleColor && 'text-vox-text-secondary'
                )}
                style={roleColor ? { color: roleColor } : undefined}
              >
                {name}
                {vu.id === currentUserId && ' (you)'}
              </span>
              <div className="flex items-center gap-0.5 shrink-0">
                {vu.screenSharing && <Monitor size={10} className="text-vox-voice-connected" />}
                {vu.serverMuted && <span title="Server muted"><MicOff size={10} className="text-vox-accent-danger" /></span>}
                {vu.selfMute && !vu.serverMuted && <MicOff size={10} className="text-vox-voice-muted" />}
                {vu.serverDeafened && <span title="Server deafened"><HeadphoneOff size={10} className="text-vox-accent-danger" /></span>}
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
          className="flex min-w-0 flex-1 items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-vox-text-muted hover:text-vox-text-secondary"
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
              title="Create channel"
            >
              <Plus size={14} />
            </button>
            <button
              onClick={() => onDelete(category.id)}
              className="text-vox-text-muted hover:text-vox-accent-danger transition-colors"
              title="Delete category"
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
        ? <Hash size={16} className="shrink-0 opacity-60" />
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
  const { channels, categories, activeChannelId, setActiveChannel, activeServerId, servers, createChannel, deleteChannel, createCategory, deleteCategory, members, unreadCounts, reorderCategories, reorderChannels } = useServerStore();
  const { joinChannel, activeChannelId: voiceChannelId, channelUsers, selfMute, selfDeaf, toggleMute, toggleDeaf } = useVoiceStore();
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
  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameInput, setNicknameInput] = useState('');
  const ctxRef = useRef<HTMLDivElement>(null);

  const activeServer = servers.find((s) => s.id === activeServerId);
  const currentMember = members.find((m) => m.userId === user?.id);
  const isAdmin = currentMember?.role === 'owner' || currentMember?.role === 'admin';

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
    if (!isAdmin) return;
    setChannelContextMenu({ channel, position: { x: e.clientX, y: e.clientY } });
  }, [isAdmin]);

  // Sort channels within each group by position
  const channelsByCategory = useMemo(() => {
    const map = new Map<string | null, Channel[]>();
    for (const ch of channels) {
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
      toast.success('Channel created');
      setNewChannelName('');
      setShowCreateChannel(false);
    } catch (err) {
      toast.error(axios.isAxiosError(err) ? err.response?.data?.error || 'Failed to create channel' : 'Failed to create channel');
    }
  };

  const handleDeleteChannel = async (channelId: string) => {
    if (!activeServerId) return;
    try {
      await deleteChannel(activeServerId, channelId);
      toast.success('Channel deleted');
    } catch {
      toast.error('Failed to delete channel');
    }
  };

  const handleCreateCategory = async () => {
    if (!activeServerId || !newCategoryName.trim()) return;
    try {
      await createCategory(activeServerId, newCategoryName.trim());
      toast.success('Category created');
      setNewCategoryName('');
      setShowCreateCategory(false);
    } catch {
      toast.error('Failed to create category');
    }
  };

  const handleDeleteCategory = async (categoryId: string) => {
    if (!activeServerId) return;
    try {
      await deleteCategory(activeServerId, categoryId);
      toast.success('Category deleted');
    } catch {
      toast.error('Failed to delete category');
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

  return (
    <div className="flex h-full w-60 flex-col bg-vox-channel">
      {/* Server name header */}
      <div className="flex h-12 items-center justify-between border-b border-vox-border px-4 shadow-sm">
        <h2 className="truncate text-sm font-semibold text-vox-text-primary">
          {activeServer?.name || 'Server'}
        </h2>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowInviteModal(true)}
            className="text-vox-text-muted hover:text-vox-text-primary transition-colors"
            title="Invite People"
          >
            <UserPlus size={16} />
          </button>
          {isAdmin && (
            <button
              onClick={() => setShowServerSettings(true)}
              className="text-vox-text-muted hover:text-vox-text-primary transition-colors"
              title="Server Settings"
            >
              <ChevronRight size={16} className="rotate-90" />
            </button>
          )}
        </div>
      </div>

      {/* Channels list */}
      <div className="flex-1 overflow-y-auto px-2 py-3">
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

        {/* Create Channel Inline */}
        {showCreateChannel && (
          <div className="mt-2 rounded-lg border border-vox-border bg-vox-bg-floating p-3">
            <input
              type="text"
              className="input mb-2 text-sm"
              placeholder={`New ${newChannelType} channel`}
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
                Text
              </button>
              <button
                onClick={() => setNewChannelType('voice')}
                className={clsx('flex-1 py-1 text-xs rounded', newChannelType === 'voice' ? 'btn-primary' : 'btn-ghost')}
              >
                Voice
              </button>
            </div>
            <div className="flex gap-2">
              <button onClick={handleCreateChannel} className="btn-primary flex-1 py-1 text-xs">
                Create
              </button>
              <button onClick={() => setShowCreateChannel(false)} className="btn-ghost flex-1 py-1 text-xs">
                Cancel
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
              placeholder="New category name"
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateCategory()}
              autoFocus
            />
            <div className="flex gap-2">
              <button onClick={handleCreateCategory} className="btn-primary flex-1 py-1 text-xs">
                Create
              </button>
              <button onClick={() => setShowCreateCategory(false)} className="btn-ghost flex-1 py-1 text-xs">
                Cancel
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
            <span>Create Category</span>
          </button>
        )}
      </div>

      {/* Voice panel (between channel list and user area) */}
      <VoicePanel />
      <DMVoicePanel />

      {/* User area at bottom */}
      <div className="flex items-center gap-2 border-t border-vox-border bg-vox-sidebar px-2 py-2">
        <Avatar avatarUrl={user?.avatarUrl} displayName={user?.displayName} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-vox-text-primary">{user?.displayName || 'User'}</p>
          {activeServerId && !editingNickname && (
            <button
              onClick={() => { setEditingNickname(true); setNicknameInput(currentMember?.nickname || ''); }}
              className="truncate text-[10px] text-vox-text-muted hover:text-vox-text-secondary transition-colors"
            >
              {currentMember?.nickname ? currentMember.nickname : 'Set nickname'}
            </button>
          )}
          {activeServerId && editingNickname && (
            <input
              type="text"
              value={nicknameInput}
              onChange={(e) => setNicknameInput(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  try {
                    await useServerStore.getState().setNickname(activeServerId, nicknameInput.trim() || null);
                    toast.success(nicknameInput.trim() ? 'Nickname set' : 'Nickname cleared');
                  } catch { toast.error('Failed to set nickname'); }
                  setEditingNickname(false);
                } else if (e.key === 'Escape') {
                  setEditingNickname(false);
                }
              }}
              onBlur={async () => {
                try {
                  await useServerStore.getState().setNickname(activeServerId, nicknameInput.trim() || null);
                } catch { /* ignore on blur */ }
                setEditingNickname(false);
              }}
              placeholder="Nickname"
              className="w-full rounded border border-vox-border bg-vox-bg-secondary px-1 py-0.5 text-[10px] text-vox-text-primary focus:outline-none focus:border-vox-accent-primary"
              autoFocus
            />
          )}
          {!activeServerId && (
            <p className="truncate text-[10px] text-vox-text-muted">Online</p>
          )}
        </div>
        <button
          onClick={toggleMute}
          className={clsx(
            'rounded p-1 transition-colors',
            selfMute
              ? 'text-vox-accent-danger hover:bg-vox-accent-danger/20'
              : 'text-vox-text-muted hover:text-vox-text-primary hover:bg-vox-bg-hover'
          )}
          title={selfMute ? 'Unmute' : 'Mute'}
        >
          {selfMute ? <MicOff size={14} /> : <Mic size={14} />}
        </button>
        <button
          onClick={toggleDeaf}
          className={clsx(
            'rounded p-1 transition-colors',
            selfDeaf
              ? 'text-vox-accent-danger hover:bg-vox-accent-danger/20'
              : 'text-vox-text-muted hover:text-vox-text-primary hover:bg-vox-bg-hover'
          )}
          title={selfDeaf ? 'Undeafen' : 'Deafen'}
        >
          {selfDeaf ? <HeadphoneOff size={14} /> : <Headphones size={14} />}
        </button>
      </div>

      {showInviteModal && activeServerId && (
        <InviteModal serverId={activeServerId} onClose={() => setShowInviteModal(false)} />
      )}
      {showServerSettings && activeServerId && (
        <ServerSettingsModal serverId={activeServerId} onClose={() => setShowServerSettings(false)} />
      )}

      {/* Channel right-click context menu */}
      {channelContextMenu && isAdmin && createPortal(
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
            Edit Permissions
          </button>
          <button
            onClick={() => {
              handleDeleteChannel(channelContextMenu.channel.id);
              setChannelContextMenu(null);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-vox-accent-danger hover:bg-vox-accent-danger/10 transition-colors"
          >
            <Trash2 size={16} />
            Delete Channel
          </button>
        </div>,
        document.body
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
