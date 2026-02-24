import { create } from 'zustand';
import { api } from '../services/api';
import type { Server, Channel, ServerMember, User, UserStatus } from '@voxium/shared';

interface ServerState {
  servers: Server[];
  activeServerId: string | null;
  channels: Channel[];
  activeChannelId: string | null;
  members: ServerMember[];
  isLoading: boolean;
  unreadCounts: Record<string, number>;
  serverUnreadCounts: Record<string, number>;

  fetchServers: () => Promise<void>;
  setActiveServer: (serverId: string) => Promise<void>;
  setActiveChannel: (channelId: string) => void;
  createServer: (name: string) => Promise<Server>;
  createChannel: (serverId: string, name: string, type: 'text' | 'voice') => Promise<Channel>;
  deleteChannel: (serverId: string, channelId: string) => Promise<void>;
  createInvite: (serverId: string) => Promise<string>;
  joinServer: (inviteCode: string) => Promise<void>;
  leaveServer: (serverId: string) => Promise<void>;
  updateMemberStatus: (userId: string, status: UserStatus) => void;
  addMember: (serverId: string, user: User) => void;
  removeMember: (serverId: string, userId: string) => void;
  addChannel: (channel: Channel) => void;
  removeChannel: (channelId: string, serverId: string) => void;
  fetchMembers: (serverId: string) => Promise<void>;
  incrementUnread: (channelId: string, serverId: string) => void;
  clearUnread: (channelId: string) => void;
}

export const useServerStore = create<ServerState>((set, get) => ({
  servers: [],
  activeServerId: null,
  channels: [],
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
      const firstTextChannel = channels.find((c: Channel) => c.type === 'text');

      set({
        channels,
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
  },

  createServer: async (name: string) => {
    const { data } = await api.post('/servers', { name });
    const server = data.data;
    set((state) => ({ servers: [...state.servers, server] }));
    return server;
  },

  createChannel: async (serverId: string, name: string, type: 'text' | 'voice') => {
    const { data } = await api.post(`/servers/${serverId}/channels`, { name, type });
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

  addMember: (serverId: string, user: User) => {
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
          email: user.email,
          avatarUrl: user.avatarUrl,
          status: user.status || 'online',
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
}));
