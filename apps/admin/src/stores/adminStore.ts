import { create } from 'zustand';
import { api } from '../services/api';
import { getSocket, onSocketReconnect } from '../services/socket';
import type { AdminUser, AdminServer, BanRecord, IpBanRecord, AdminDashboardStats, AdminMetricsSnapshot, StorageStats, StorageFile, StorageTopUploader, AuditLogEntry } from '@voxium/shared';

// Module-level refs for metrics subscription cleanup
let metricsHandler: ((data: AdminMetricsSnapshot) => void) | null = null;
let metricsReconnectUnsub: (() => void) | null = null;

export interface OwnedServerInfo {
  id: string;
  name: string;
  iconUrl: string | null;
  memberCount: number;
  members: Array<{ userId: string; username: string; displayName: string; role: string }>;
}

export interface ServerAction {
  serverId: string;
  action: 'transfer' | 'delete';
  newOwnerId?: string;
}

interface AdminState {
  // Dashboard
  stats: AdminDashboardStats | null;
  liveMetrics: AdminMetricsSnapshot | null;
  signupData: Array<{ day: string; count: number }>;
  messagesData: Array<{ hour: string; count: number }>;

  // Users
  users: AdminUser[];
  usersTotal: number;
  usersPage: number;
  usersSearch: string;
  usersFilter: string;
  usersSort: string;
  selectedUser: (AdminUser & { ipRecords?: Array<{ ip: string; lastSeenAt: string }>; _count?: Record<string, number> }) | null;

  // Servers
  servers: AdminServer[];
  serversTotal: number;
  serversPage: number;
  serversSearch: string;

  // Bans
  bans: BanRecord[];
  bansTotal: number;
  bansPage: number;
  ipBans: IpBanRecord[];
  ipBansTotal: number;
  ipBansPage: number;

  // Storage
  storageStats: StorageStats | null;
  storageFiles: StorageFile[];
  storageFilesTotal: number;
  storageFilesPage: number;
  storageFilter: string;
  topUploaders: StorageTopUploader[];

  // Audit Logs
  auditLogs: AuditLogEntry[];
  auditLogsTotal: number;
  auditLogsPage: number;
  auditLogsFilter: string;
  auditLogsSearch: string;

  // Loading
  loading: boolean;

  // Actions
  fetchStats: () => Promise<void>;
  fetchSignups: (days?: number) => Promise<void>;
  fetchMessagesPerHour: (hours?: number) => Promise<void>;
  subscribeMetrics: () => void;
  unsubscribeMetrics: () => void;

  fetchUsers: (page?: number) => Promise<void>;
  setUsersSearch: (search: string) => void;
  setUsersFilter: (filter: string) => void;
  setUsersSort: (sort: string) => void;
  fetchUserDetail: (userId: string) => Promise<void>;
  clearSelectedUser: () => void;
  banUser: (userId: string, reason?: string, banIps?: boolean) => Promise<void>;
  unbanUser: (userId: string) => Promise<void>;
  deleteUser: (userId: string) => Promise<void>;
  fetchUserOwnedServers: (userId: string) => Promise<OwnedServerInfo[]>;
  deleteUserWithTransfers: (userId: string, serverActions: ServerAction[]) => Promise<void>;
  updateUserRole: (userId: string, role: 'user' | 'admin') => Promise<void>;

  fetchServers: (page?: number) => Promise<void>;
  setServersSearch: (search: string) => void;
  deleteServer: (serverId: string) => Promise<void>;

  fetchBans: (page?: number) => Promise<void>;
  fetchIpBans: (page?: number) => Promise<void>;
  addIpBan: (ip: string, reason?: string) => Promise<void>;
  removeIpBan: (id: string) => Promise<void>;

  fetchAuditLogs: (page?: number) => Promise<void>;
  setAuditLogsFilter: (filter: string) => void;
  setAuditLogsSearch: (search: string) => void;

  fetchStorageStats: () => Promise<void>;
  fetchTopUploaders: () => Promise<void>;
  fetchStorageFiles: (page?: number) => Promise<void>;
  setStorageFilter: (filter: string) => void;
  deleteStorageFile: (key: string) => Promise<void>;
  cleanupOrphans: () => Promise<{ found: number; deleted: number }>;

  // Export
  exportUsers: () => Promise<AdminUser[]>;
  exportServers: () => Promise<AdminServer[]>;
  exportBans: () => Promise<BanRecord[]>;
  exportIpBans: () => Promise<IpBanRecord[]>;
}

export const useAdminStore = create<AdminState>((set, get) => ({
  stats: null,
  liveMetrics: null,
  signupData: [],
  messagesData: [],
  users: [],
  usersTotal: 0,
  usersPage: 1,
  usersSearch: '',
  usersFilter: 'all',
  usersSort: 'newest',
  selectedUser: null,
  servers: [],
  serversTotal: 0,
  serversPage: 1,
  serversSearch: '',
  bans: [],
  bansTotal: 0,
  bansPage: 1,
  ipBans: [],
  ipBansTotal: 0,
  ipBansPage: 1,
  storageStats: null,
  storageFiles: [],
  storageFilesTotal: 0,
  storageFilesPage: 1,
  storageFilter: 'all',
  topUploaders: [],
  auditLogs: [],
  auditLogsTotal: 0,
  auditLogsPage: 1,
  auditLogsFilter: '',
  auditLogsSearch: '',
  loading: false,

  fetchStats: async () => {
    try {
      const { data } = await api.get('/admin/stats');
      set({ stats: data.data });
    } catch {
      console.error('Failed to fetch admin stats');
    }
  },

  fetchSignups: async (days = 30) => {
    try {
      const { data } = await api.get(`/admin/signups?days=${days}`);
      set({ signupData: data.data });
    } catch {
      console.error('Failed to fetch signup data');
    }
  },

  fetchMessagesPerHour: async (hours = 24) => {
    try {
      const { data } = await api.get(`/admin/messages-per-hour?hours=${hours}`);
      set({ messagesData: data.data });
    } catch {
      console.error('Failed to fetch messages data');
    }
  },

  subscribeMetrics: () => {
    const socket = getSocket();
    if (!socket) return;

    metricsHandler = (data: AdminMetricsSnapshot) => {
      set({ liveMetrics: data });
    };

    socket.emit('admin:subscribe_metrics');
    socket.on('admin:metrics', metricsHandler);

    metricsReconnectUnsub = onSocketReconnect(() => {
      const s = getSocket();
      if (s && metricsHandler) {
        s.emit('admin:subscribe_metrics');
        s.off('admin:metrics', metricsHandler);
        s.on('admin:metrics', metricsHandler);
      }
    });
  },

  unsubscribeMetrics: () => {
    const socket = getSocket();
    if (socket) {
      socket.emit('admin:unsubscribe_metrics');
      if (metricsHandler) socket.off('admin:metrics', metricsHandler);
    }
    metricsHandler = null;
    if (metricsReconnectUnsub) {
      metricsReconnectUnsub();
      metricsReconnectUnsub = null;
    }
  },

  fetchUsers: async (page?: number) => {
    const state = get();
    const p = page ?? state.usersPage;
    set({ loading: true });
    try {
      const { data } = await api.get('/admin/users', {
        params: { page: p, limit: 20, search: state.usersSearch, filter: state.usersFilter, sort: state.usersSort },
      });
      set({ users: data.data, usersTotal: data.total, usersPage: p });
    } finally {
      set({ loading: false });
    }
  },

  setUsersSearch: (search) => set({ usersSearch: search }),
  setUsersFilter: (filter) => set({ usersFilter: filter }),
  setUsersSort: (sort) => set({ usersSort: sort }),

  fetchUserDetail: async (userId) => {
    try {
      const { data } = await api.get(`/admin/users/${userId}`);
      set({ selectedUser: data.data });
    } catch {
      console.error('Failed to fetch user detail');
    }
  },

  clearSelectedUser: () => set({ selectedUser: null }),

  banUser: async (userId, reason, banIps) => {
    await api.post(`/admin/users/${userId}/ban`, { reason, banIps });
    // Refresh lists
    await get().fetchUsers();
  },

  unbanUser: async (userId) => {
    await api.post(`/admin/users/${userId}/unban`);
    await get().fetchUsers();
  },

  deleteUser: async (userId) => {
    await api.delete(`/admin/users/${userId}`);
    await get().fetchUsers();
  },

  fetchUserOwnedServers: async (userId) => {
    const { data } = await api.get(`/admin/users/${userId}/owned-servers`);
    return data.data as OwnedServerInfo[];
  },

  deleteUserWithTransfers: async (userId, serverActions) => {
    await api.delete(`/admin/users/${userId}`, { data: { serverActions } });
    await get().fetchUsers();
  },

  updateUserRole: async (userId, role) => {
    await api.patch(`/admin/users/${userId}/role`, { role });
  },

  fetchServers: async (page?: number) => {
    const state = get();
    const p = page ?? state.serversPage;
    set({ loading: true });
    try {
      const { data } = await api.get('/admin/servers', {
        params: { page: p, limit: 20, search: state.serversSearch },
      });
      set({ servers: data.data, serversTotal: data.total, serversPage: p });
    } finally {
      set({ loading: false });
    }
  },

  setServersSearch: (search) => set({ serversSearch: search }),

  deleteServer: async (serverId) => {
    await api.delete(`/admin/servers/${serverId}`);
    await get().fetchServers();
  },

  fetchBans: async (page?: number) => {
    try {
      const p = page ?? get().bansPage;
      const { data } = await api.get('/admin/bans', { params: { page: p, limit: 20 } });
      set({ bans: data.data, bansTotal: data.total, bansPage: p });
    } catch {
      console.error('Failed to fetch bans');
    }
  },

  fetchIpBans: async (page?: number) => {
    try {
      const p = page ?? get().ipBansPage;
      const { data } = await api.get('/admin/ip-bans', { params: { page: p, limit: 20 } });
      set({ ipBans: data.data, ipBansTotal: data.total, ipBansPage: p });
    } catch {
      console.error('Failed to fetch IP bans');
    }
  },

  addIpBan: async (ip, reason) => {
    await api.post('/admin/ip-bans', { ip, reason });
    await get().fetchIpBans();
  },

  removeIpBan: async (id) => {
    await api.delete(`/admin/ip-bans/${id}`);
    await get().fetchIpBans();
  },

  fetchAuditLogs: async (page?: number) => {
    const state = get();
    const p = page ?? state.auditLogsPage;
    set({ loading: true });
    try {
      const { data } = await api.get('/admin/audit-logs', {
        params: { page: p, limit: 20, action: state.auditLogsFilter || undefined, search: state.auditLogsSearch || undefined },
      });
      set({ auditLogs: data.data, auditLogsTotal: data.total, auditLogsPage: p });
    } finally {
      set({ loading: false });
    }
  },

  setAuditLogsFilter: (filter) => set({ auditLogsFilter: filter }),
  setAuditLogsSearch: (search) => set({ auditLogsSearch: search }),

  fetchStorageStats: async () => {
    try {
      const { data } = await api.get('/admin/storage/stats');
      set({ storageStats: data.data });
    } catch {
      console.error('Failed to fetch storage stats');
    }
  },

  fetchTopUploaders: async () => {
    try {
      const { data } = await api.get('/admin/storage/top-uploaders');
      set({ topUploaders: data.data });
    } catch {
      console.error('Failed to fetch top uploaders');
    }
  },

  fetchStorageFiles: async (page?: number) => {
    const state = get();
    const p = page ?? state.storageFilesPage;
    set({ loading: true });
    try {
      const { data } = await api.get('/admin/storage/files', {
        params: { page: p, limit: 20, filter: state.storageFilter },
      });
      set({ storageFiles: data.data, storageFilesTotal: data.total, storageFilesPage: p });
    } finally {
      set({ loading: false });
    }
  },

  setStorageFilter: (filter) => set({ storageFilter: filter }),

  deleteStorageFile: async (key) => {
    await api.delete(`/admin/storage/files/${key}`);
    await Promise.all([get().fetchStorageStats(), get().fetchStorageFiles()]);
  },

  cleanupOrphans: async () => {
    const { data } = await api.post('/admin/storage/cleanup-orphans');
    await Promise.all([get().fetchStorageStats(), get().fetchStorageFiles()]);
    return data.data;
  },

  exportUsers: async () => {
    const { data } = await api.get('/admin/export/users');
    return data.data;
  },

  exportServers: async () => {
    const { data } = await api.get('/admin/export/servers');
    return data.data;
  },

  exportBans: async () => {
    const { data } = await api.get('/admin/export/bans');
    return data.data;
  },

  exportIpBans: async () => {
    const { data } = await api.get('/admin/export/ip-bans');
    return data.data;
  },
}));
