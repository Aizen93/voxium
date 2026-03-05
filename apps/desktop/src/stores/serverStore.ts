import { create } from 'zustand';
import { api } from '../services/api';
import { processImage } from '../utils/imageProcessing';
import type { Server, Channel, Category, ServerMember, PublicUser, UserStatus, UnreadCount, MemberRole } from '@voxium/shared';

interface ServerState {
  servers: Server[];
  activeServerId: string | null;
  channels: Channel[];
  categories: Category[];
  activeChannelId: string | null;
  members: ServerMember[];
  isLoading: boolean;
  unreadCounts: Record<string, number>;
  serverUnreadCounts: Record<string, number>;

  fetchServers: () => Promise<void>;
  setActiveServer: (serverId: string) => Promise<void>;
  setActiveChannel: (channelId: string) => void;
  createServer: (name: string) => Promise<Server>;
  createChannel: (serverId: string, name: string, type: 'text' | 'voice', categoryId?: string) => Promise<Channel>;
  deleteChannel: (serverId: string, channelId: string) => Promise<void>;
  createInvite: (serverId: string) => Promise<string>;
  joinServer: (inviteCode: string) => Promise<void>;
  leaveServer: (serverId: string) => Promise<void>;
  updateMemberStatus: (userId: string, status: UserStatus) => void;
  addMember: (serverId: string, user: PublicUser) => void;
  removeMember: (serverId: string, userId: string) => void;
  addChannel: (channel: Channel) => void;
  removeChannel: (channelId: string, serverId: string) => void;
  updateChannelData: (channel: Channel) => void;
  addCategory: (category: Category) => void;
  updateCategory: (category: Category) => void;
  removeCategory: (categoryId: string, serverId: string) => void;
  createCategory: (serverId: string, name: string) => Promise<Category>;
  deleteCategory: (serverId: string, categoryId: string) => Promise<void>;
  renameCategory: (serverId: string, categoryId: string, name: string) => Promise<void>;
  fetchMembers: (serverId: string) => Promise<void>;
  incrementUnread: (channelId: string, serverId: string) => void;
  clearUnread: (channelId: string) => void;
  initUnreadCounts: (unreads: UnreadCount[]) => void;
  markChannelRead: (channelId: string) => void;
  uploadServerIcon: (serverId: string, file: File) => Promise<void>;
  updateServer: (serverId: string, fields: { name?: string }) => Promise<void>;
  updateServerData: (server: Server) => void;
  updateMemberAvatar: (userId: string, avatarUrl: string | null) => void;
  updateMemberProfile: (userId: string, fields: { displayName: string; avatarUrl: string | null }) => void;
  reorderCategories: (serverId: string, order: { id: string; position: number }[]) => Promise<void>;
  reorderChannels: (serverId: string, order: { id: string; position: number; categoryId: string | null }[]) => Promise<void>;
  updateMemberRole: (serverId: string, memberId: string, role: MemberRole) => Promise<void>;
  kickMember: (serverId: string, memberId: string) => Promise<void>;
  transferOwnership: (serverId: string, targetUserId: string) => Promise<void>;
  deleteServer: (serverId: string) => Promise<void>;
  toggleInvitesLock: (serverId: string, locked: boolean) => Promise<void>;
  handleMemberRoleUpdated: (serverId: string, userId: string, role: MemberRole) => void;
  handleMemberKicked: (serverId: string) => void;
  handleServerDeleted: (serverId: string) => void;
}

export const useServerStore = create<ServerState>((set, get) => ({
  servers: [],
  activeServerId: null,
  channels: [],
  categories: [],
  activeChannelId: null,
  members: [],
  isLoading: false,
  unreadCounts: {},
  serverUnreadCounts: {},

  fetchServers: async () => {
    try {
      const { data } = await api.get('/servers');
      set({ servers: data.data });
    } catch (err) {
      console.error('Failed to fetch servers:', err);
    }
  },

  setActiveServer: async (serverId: string) => {
    set({ activeServerId: serverId, isLoading: true });
    try {
      const { data } = await api.get(`/servers/${serverId}`);
      const channels = data.data.channels || [];
      const categories = data.data.categories || [];
      const firstTextChannel = channels.find((c: Channel) => c.type === 'text');

      set({
        channels,
        categories,
        activeChannelId: firstTextChannel?.id || null,
        isLoading: false,
      });

      // Fetch members in the background
      get().fetchMembers(serverId);
    } catch (err) {
      console.error('Failed to fetch server:', err);
      set({ isLoading: false });
    }
  },

  setActiveChannel: (channelId: string) => {
    set({ activeChannelId: channelId });
    get().clearUnread(channelId);
    get().markChannelRead(channelId);
  },

  createServer: async (name: string) => {
    const { data } = await api.post('/servers', { name });
    const server = data.data;
    set((state) => ({ servers: [...state.servers, server] }));
    return server;
  },

  createChannel: async (serverId: string, name: string, type: 'text' | 'voice', categoryId?: string) => {
    const { data } = await api.post(`/servers/${serverId}/channels`, { name, type, categoryId });
    return data.data;
  },

  deleteChannel: async (serverId: string, channelId: string) => {
    await api.delete(`/servers/${serverId}/channels/${channelId}`);
  },

  createInvite: async (serverId: string) => {
    const { data } = await api.post(`/invites/servers/${serverId}`);
    return data.data.code;
  },

  joinServer: async (inviteCode: string) => {
    const { data } = await api.post(`/invites/${inviteCode}/join`);
    const server = data.data;
    set((state) => ({ servers: [...state.servers, server] }));
  },

  leaveServer: async (serverId: string) => {
    await api.post(`/servers/${serverId}/leave`);
    set((state) => ({
      servers: state.servers.filter((s) => s.id !== serverId),
      activeServerId: state.activeServerId === serverId ? null : state.activeServerId,
    }));
  },

  updateMemberStatus: (userId: string, status: UserStatus) => {
    set((state) => ({
      members: state.members.map((m) =>
        m.userId === userId ? { ...m, user: { ...m.user, status } } : m
      ),
    }));
  },

  addMember: (serverId: string, user: PublicUser) => {
    if (get().activeServerId !== serverId) return;
    set((state) => {
      if (state.members.some((m) => m.userId === user.id)) return state;
      const newMember: ServerMember = {
        userId: user.id,
        serverId,
        role: 'member',
        joinedAt: new Date().toISOString(),
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
          bio: user.bio ?? null,
          status: user.status || 'online',
          role: user.role || 'user',
          createdAt: user.createdAt,
        },
      };
      return { members: [...state.members, newMember] };
    });
  },

  removeMember: (serverId: string, userId: string) => {
    if (get().activeServerId !== serverId) return;
    set((state) => ({
      members: state.members.filter((m) => m.userId !== userId),
    }));
  },

  addChannel: (channel: Channel) => {
    if (get().activeServerId !== channel.serverId) return;
    set((state) => {
      if (state.channels.some((c) => c.id === channel.id)) return state;
      return { channels: [...state.channels, channel] };
    });
  },

  removeChannel: (channelId: string, serverId: string) => {
    if (get().activeServerId !== serverId) return;
    set((state) => ({
      channels: state.channels.filter((c) => c.id !== channelId),
      activeChannelId: state.activeChannelId === channelId ? null : state.activeChannelId,
    }));
  },

  updateChannelData: (channel: Channel) => {
    if (get().activeServerId !== channel.serverId) return;
    set((state) => ({
      channels: state.channels.map((c) => (c.id === channel.id ? channel : c)),
    }));
  },

  addCategory: (category: Category) => {
    if (get().activeServerId !== category.serverId) return;
    set((state) => {
      if (state.categories.some((c) => c.id === category.id)) return state;
      return { categories: [...state.categories, category] };
    });
  },

  updateCategory: (category: Category) => {
    if (get().activeServerId !== category.serverId) return;
    set((state) => ({
      categories: state.categories.map((c) => (c.id === category.id ? category : c)),
    }));
  },

  removeCategory: (categoryId: string, serverId: string) => {
    if (get().activeServerId !== serverId) return;
    set((state) => ({
      categories: state.categories.filter((c) => c.id !== categoryId),
    }));
  },

  createCategory: async (serverId: string, name: string) => {
    const { data } = await api.post(`/servers/${serverId}/categories`, { name });
    return data.data;
  },

  deleteCategory: async (serverId: string, categoryId: string) => {
    await api.delete(`/servers/${serverId}/categories/${categoryId}`);
  },

  renameCategory: async (serverId: string, categoryId: string, name: string) => {
    await api.patch(`/servers/${serverId}/categories/${categoryId}`, { name });
  },

  fetchMembers: async (serverId: string) => {
    try {
      const { data } = await api.get(`/servers/${serverId}/members`);
      set({ members: data.data });
    } catch (err) {
      console.error('Failed to fetch members:', err);
    }
  },

  incrementUnread: (channelId: string, serverId: string) => {
    set((state) => ({
      unreadCounts: {
        ...state.unreadCounts,
        [channelId]: (state.unreadCounts[channelId] || 0) + 1,
      },
      serverUnreadCounts: {
        ...state.serverUnreadCounts,
        [serverId]: (state.serverUnreadCounts[serverId] || 0) + 1,
      },
    }));
  },

  clearUnread: (channelId: string) => {
    const count = get().unreadCounts[channelId];
    if (!count) return;
    // Find which server this channel belongs to
    const channel = get().channels.find((c) => c.id === channelId);
    set((state) => {
      const { [channelId]: _, ...restUnread } = state.unreadCounts;
      const newServerUnread = { ...state.serverUnreadCounts };
      const sid = channel?.serverId || state.activeServerId;
      if (sid && newServerUnread[sid]) {
        newServerUnread[sid] = Math.max(0, newServerUnread[sid] - count);
        if (newServerUnread[sid] === 0) delete newServerUnread[sid];
      }
      return { unreadCounts: restUnread, serverUnreadCounts: newServerUnread };
    });
  },

  initUnreadCounts: (unreads: UnreadCount[]) => {
    const unreadCounts: Record<string, number> = {};
    const serverUnreadCounts: Record<string, number> = {};
    for (const u of unreads) {
      unreadCounts[u.channelId] = u.count;
      serverUnreadCounts[u.serverId] = (serverUnreadCounts[u.serverId] || 0) + u.count;
    }
    set({ unreadCounts, serverUnreadCounts });
  },

  markChannelRead: (channelId: string) => {
    // Find the serverId for this channel
    const channel = get().channels.find((c) => c.id === channelId);
    const serverId = channel?.serverId || get().activeServerId;
    if (!serverId) return;
    // Fire-and-forget
    api.post(`/servers/${serverId}/channels/${channelId}/read`).catch(() => {});
  },

  uploadServerIcon: async (serverId: string, file: File) => {
    // 1. Get presigned PUT URL
    const { data: presignData } = await api.post(`/uploads/presign/server-icon/${serverId}`);
    const { uploadUrl, key } = presignData.data;

    // 2. Client-side resize + WebP conversion
    const blob = await processImage(file);

    // 3. Direct upload to S3
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      body: blob,
      headers: { 'Content-Type': 'image/webp' },
    });
    if (!uploadRes.ok) {
      throw new Error(`S3 upload failed: ${uploadRes.status}`);
    }

    // 4. Confirm in DB (triggers old icon cleanup + socket broadcast)
    await api.patch(`/servers/${serverId}`, { iconUrl: key });
    // Local state updated via server:updated socket event
  },

  updateServer: async (serverId: string, fields) => {
    await api.patch(`/servers/${serverId}`, fields);
    // Local state updated via server:updated socket event
  },

  updateServerData: (server: Server) => {
    set((state) => ({
      servers: state.servers.map((s) => (s.id === server.id ? server : s)),
    }));
  },

  updateMemberAvatar: (userId: string, avatarUrl: string | null) => {
    set((state) => ({
      members: state.members.map((m) =>
        m.userId === userId ? { ...m, user: { ...m.user, avatarUrl } } : m
      ),
    }));
  },

  updateMemberProfile: (userId: string, fields: { displayName: string; avatarUrl: string | null }) => {
    set((state) => ({
      members: state.members.map((m) =>
        m.userId === userId ? { ...m, user: { ...m.user, ...fields } } : m
      ),
    }));
  },

  reorderCategories: async (serverId: string, order: { id: string; position: number }[]) => {
    const prev = get().categories;
    // Optimistic update
    set((state) => ({
      categories: state.categories.map((c) => {
        const o = order.find((o) => o.id === c.id);
        return o ? { ...c, position: o.position } : c;
      }),
    }));
    try {
      await api.put(`/servers/${serverId}/categories/reorder`, { order });
    } catch {
      // Revert on failure
      set({ categories: prev });
    }
  },

  reorderChannels: async (serverId: string, order: { id: string; position: number; categoryId: string | null }[]) => {
    const prev = get().channels;
    // Optimistic update
    set((state) => ({
      channels: state.channels.map((c) => {
        const o = order.find((o) => o.id === c.id);
        return o ? { ...c, position: o.position, categoryId: o.categoryId } : c;
      }),
    }));
    try {
      await api.put(`/servers/${serverId}/channels/reorder`, { order });
    } catch {
      // Revert on failure
      set({ channels: prev });
    }
  },

  updateMemberRole: async (serverId: string, memberId: string, role: MemberRole) => {
    await api.patch(`/servers/${serverId}/members/${memberId}/role`, { role });
  },

  kickMember: async (serverId: string, memberId: string) => {
    await api.post(`/servers/${serverId}/members/${memberId}/kick`);
  },

  transferOwnership: async (serverId: string, targetUserId: string) => {
    await api.post(`/servers/${serverId}/transfer-ownership`, { targetUserId });
  },

  deleteServer: async (serverId: string) => {
    await api.delete(`/servers/${serverId}`);
    // No local state update — socket event is source of truth
  },

  toggleInvitesLock: async (serverId: string, locked: boolean) => {
    await api.patch(`/servers/${serverId}/invites-lock`, { locked });
    // Local state updated via server:updated socket event
  },

  handleMemberRoleUpdated: (serverId: string, userId: string, role: MemberRole) => {
    if (get().activeServerId !== serverId) return;
    set((state) => ({
      members: state.members.map((m) =>
        m.userId === userId ? { ...m, role } : m
      ),
    }));
  },

  handleMemberKicked: (serverId: string) => {
    set((state) => ({
      servers: state.servers.filter((s) => s.id !== serverId),
      activeServerId: state.activeServerId === serverId ? null : state.activeServerId,
      channels: state.activeServerId === serverId ? [] : state.channels,
      categories: state.activeServerId === serverId ? [] : state.categories,
      members: state.activeServerId === serverId ? [] : state.members,
      activeChannelId: state.activeServerId === serverId ? null : state.activeChannelId,
    }));
  },

  handleServerDeleted: (serverId: string) => {
    set((state) => {
      const isActive = state.activeServerId === serverId;

      // Clean up server-level unread count
      const { [serverId]: _, ...restServerUnread } = state.serverUnreadCounts;

      // Clean up channel-level unread counts if this was the active server
      let newUnreadCounts = state.unreadCounts;
      if (isActive && state.channels.length > 0) {
        newUnreadCounts = { ...state.unreadCounts };
        for (const ch of state.channels) {
          delete newUnreadCounts[ch.id];
        }
      }

      return {
        servers: state.servers.filter((s) => s.id !== serverId),
        activeServerId: isActive ? null : state.activeServerId,
        channels: isActive ? [] : state.channels,
        categories: isActive ? [] : state.categories,
        members: isActive ? [] : state.members,
        activeChannelId: isActive ? null : state.activeChannelId,
        unreadCounts: newUnreadCounts,
        serverUnreadCounts: restServerUnread,
      };
    });
  },
}));
