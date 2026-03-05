import { create } from 'zustand';
import { api } from '../services/api';
import { getSocket, onSocketReconnect } from '../services/socket';
import type { AdminUser, AdminServer, BanRecord, IpBanRecord, AdminDashboardStats, AdminMetricsSnapshot, StorageStats, StorageFile, StorageTopUploader, AuditLogEntry, Announcement, Report, SupportTicket, SupportMessageData } from '@voxium/shared';

// Module-level refs for metrics subscription cleanup
let metricsHandler: ((data: AdminMetricsSnapshot) => void) | null = null;
let metricsReconnectUnsub: (() => void) | null = null;

// Module-level refs for reports subscription cleanup
let reportsHandler: ((data: { total: number }) => void) | null = null;
let reportsReconnectUnsub: (() => void) | null = null;

// Module-level refs for support subscription cleanup
let supportTicketHandler: ((data: { total: number }) => void) | null = null;
let supportMessageHandler: ((msg: SupportMessageData) => void) | null = null;
let supportStatusHandler: ((data: { ticketId: string; status: string; claimedById?: string; claimedByUsername?: string }) => void) | null = null;
let supportReconnectUnsub: (() => void) | null = null;

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

  // Announcements
  announcements: Announcement[];
  announcementsTotal: number;
  announcementsPage: number;
  announcementsFilter: string;

  // Reports
  reports: Report[];
  reportsTotal: number;
  reportsPage: number;
  reportsFilter: string;

  // Audit Logs
  auditLogs: AuditLogEntry[];
  auditLogsTotal: number;
  auditLogsPage: number;
  auditLogsFilter: string;
  auditLogsSearch: string;

  // Support
  supportTickets: SupportTicket[];
  supportTicketsTotal: number;
  supportTicketsPage: number;
  supportTicketsFilter: string;
  activeTicket: SupportTicket | null;
  activeTicketMessages: SupportMessageData[];

  // Rate Limits
  rateLimits: Array<{
    name: string;
    label: string;
    keyType: 'ip' | 'userId';
    keyPrefix: string;
    points: number;
    duration: number;
    blockDuration: number;
    isCustom: boolean;
  }>;

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

  fetchAnnouncements: (page?: number) => Promise<void>;
  setAnnouncementsFilter: (filter: string) => void;
  createAnnouncement: (data: { title: string; content: string; type: string; scope: string; serverIds?: string[]; expiresAt?: string; publish?: boolean }) => Promise<void>;
  publishAnnouncement: (id: string) => Promise<void>;
  deleteAnnouncement: (id: string) => Promise<void>;

  fetchReports: (page?: number) => Promise<void>;
  setReportsFilter: (filter: string) => void;
  resolveReport: (id: string, data: { resolution: string; action?: 'ban'; deleteMessage?: boolean }) => Promise<void>;
  dismissReport: (id: string) => Promise<void>;
  subscribeReports: () => void;
  unsubscribeReports: () => void;

  fetchAuditLogs: (page?: number) => Promise<void>;
  setAuditLogsFilter: (filter: string) => void;
  setAuditLogsSearch: (search: string) => void;

  fetchSupportTickets: (page?: number) => Promise<void>;
  setSupportTicketsFilter: (filter: string) => void;
  claimTicket: (id: string) => Promise<void>;
  fetchTicketMessages: (id: string) => Promise<void>;
  sendTicketMessage: (id: string, content: string) => Promise<void>;
  closeTicket: (id: string) => Promise<void>;
  setActiveTicket: (ticket: SupportTicket | null) => void;
  subscribeSupport: () => void;
  unsubscribeSupport: () => void;

  fetchRateLimits: () => Promise<void>;
  updateRateLimit: (name: string, updates: { points?: number; duration?: number; blockDuration?: number }) => Promise<void>;
  resetRateLimit: (name: string) => Promise<void>;
  clearUserRateLimits: (key: string) => Promise<number>;

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
  announcements: [],
  announcementsTotal: 0,
  announcementsPage: 1,
  announcementsFilter: 'all',
  reports: [],
  reportsTotal: 0,
  reportsPage: 1,
  reportsFilter: 'all',
  auditLogs: [],
  auditLogsTotal: 0,
  auditLogsPage: 1,
  auditLogsFilter: '',
  auditLogsSearch: '',
  supportTickets: [],
  supportTicketsTotal: 0,
  supportTicketsPage: 1,
  supportTicketsFilter: 'all',
  activeTicket: null,
  activeTicketMessages: [],
  rateLimits: [],
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
        params: { page: p, limit: 12, search: state.usersSearch, filter: state.usersFilter, sort: state.usersSort },
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
        params: { page: p, limit: 12, search: state.serversSearch },
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
      const { data } = await api.get('/admin/bans', { params: { page: p, limit: 12 } });
      set({ bans: data.data, bansTotal: data.total, bansPage: p });
    } catch {
      console.error('Failed to fetch bans');
    }
  },

  fetchIpBans: async (page?: number) => {
    try {
      const p = page ?? get().ipBansPage;
      const { data } = await api.get('/admin/ip-bans', { params: { page: p, limit: 12 } });
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

  fetchAnnouncements: async (page?: number) => {
    const state = get();
    const p = page ?? state.announcementsPage;
    set({ loading: true });
    try {
      const { data } = await api.get('/admin/announcements', {
        params: { page: p, limit: 12, filter: state.announcementsFilter },
      });
      set({ announcements: data.data, announcementsTotal: data.total, announcementsPage: p });
    } finally {
      set({ loading: false });
    }
  },

  setAnnouncementsFilter: (filter) => set({ announcementsFilter: filter }),

  createAnnouncement: async (body) => {
    await api.post('/admin/announcements', body);
    await get().fetchAnnouncements(1);
  },

  publishAnnouncement: async (id) => {
    await api.post(`/admin/announcements/${id}/publish`);
    await get().fetchAnnouncements();
  },

  deleteAnnouncement: async (id) => {
    await api.delete(`/admin/announcements/${id}`);
    await get().fetchAnnouncements();
  },

  fetchReports: async (page?: number) => {
    const state = get();
    const p = page ?? state.reportsPage;
    set({ loading: true });
    try {
      const { data } = await api.get('/admin/reports', {
        params: { page: p, limit: 12, filter: state.reportsFilter },
      });
      set({ reports: data.data, reportsTotal: data.total, reportsPage: p });
    } finally {
      set({ loading: false });
    }
  },

  setReportsFilter: (filter) => set({ reportsFilter: filter }),

  resolveReport: async (id, body) => {
    await api.post(`/admin/reports/${id}/resolve`, body);
    await get().fetchReports();
  },

  dismissReport: async (id) => {
    await api.post(`/admin/reports/${id}/dismiss`);
    await get().fetchReports();
  },

  subscribeReports: () => {
    const socket = getSocket();
    if (!socket) return;

    reportsHandler = () => {
      get().fetchReports();
      get().fetchStats();
    };

    socket.emit('admin:subscribe_reports' as any);
    socket.on('report:new' as any, reportsHandler);

    reportsReconnectUnsub = onSocketReconnect(() => {
      const s = getSocket();
      if (s && reportsHandler) {
        s.emit('admin:subscribe_reports' as any);
        s.off('report:new' as any, reportsHandler);
        s.on('report:new' as any, reportsHandler);
      }
    });
  },

  unsubscribeReports: () => {
    const socket = getSocket();
    if (socket) {
      socket.emit('admin:unsubscribe_reports' as any);
      if (reportsHandler) socket.off('report:new' as any, reportsHandler);
    }
    reportsHandler = null;
    if (reportsReconnectUnsub) {
      reportsReconnectUnsub();
      reportsReconnectUnsub = null;
    }
  },

  fetchAuditLogs: async (page?: number) => {
    const state = get();
    const p = page ?? state.auditLogsPage;
    set({ loading: true });
    try {
      const { data } = await api.get('/admin/audit-logs', {
        params: { page: p, limit: 12, action: state.auditLogsFilter || undefined, search: state.auditLogsSearch || undefined },
      });
      set({ auditLogs: data.data, auditLogsTotal: data.total, auditLogsPage: p });
    } finally {
      set({ loading: false });
    }
  },

  setAuditLogsFilter: (filter) => set({ auditLogsFilter: filter }),
  setAuditLogsSearch: (search) => set({ auditLogsSearch: search }),

  fetchSupportTickets: async (page?: number) => {
    const state = get();
    const p = page ?? state.supportTicketsPage;
    set({ loading: true });
    try {
      const { data } = await api.get('/admin/support/tickets', {
        params: { page: p, limit: 12, status: state.supportTicketsFilter === 'all' ? undefined : state.supportTicketsFilter },
      });
      set({ supportTickets: data.data, supportTicketsTotal: data.total, supportTicketsPage: p });
    } finally {
      set({ loading: false });
    }
  },

  setSupportTicketsFilter: (filter) => {
    set({ supportTicketsFilter: filter });
    get().fetchSupportTickets(1);
  },

  claimTicket: async (id) => {
    await api.post(`/admin/support/tickets/${id}/claim`);
    // Update activeTicket status immediately + refetch messages (includes system message)
    const activeTicket = get().activeTicket;
    if (activeTicket && activeTicket.id === id) {
      set({ activeTicket: { ...activeTicket, status: 'claimed' } });
      await get().fetchTicketMessages(id);
    }
    await get().fetchSupportTickets();
  },

  fetchTicketMessages: async (id) => {
    try {
      const { data } = await api.get(`/admin/support/tickets/${id}/messages`);
      set({ activeTicketMessages: data.data });
    } catch {
      console.error('Failed to fetch ticket messages');
    }
  },

  sendTicketMessage: async (id, content) => {
    const { data } = await api.post(`/admin/support/tickets/${id}/messages`, { content });
    // Append message from REST response immediately (dedup with socket events)
    const msg = data.data as SupportMessageData;
    const msgs = get().activeTicketMessages;
    if (!msgs.some((m) => m.id === msg.id)) {
      set({ activeTicketMessages: [...msgs, msg] });
    }
  },

  closeTicket: async (id) => {
    await api.post(`/admin/support/tickets/${id}/close`);
    // Update activeTicket status immediately + refetch messages (includes system message)
    const activeTicket = get().activeTicket;
    if (activeTicket && activeTicket.id === id) {
      set({ activeTicket: { ...activeTicket, status: 'closed' } });
      await get().fetchTicketMessages(id);
    }
    await get().fetchSupportTickets();
  },

  setActiveTicket: (ticket) => {
    set({ activeTicket: ticket, activeTicketMessages: [] });
    if (ticket) {
      get().fetchTicketMessages(ticket.id);
    }
  },

  subscribeSupport: () => {
    const socket = getSocket();
    if (!socket) return;

    supportTicketHandler = () => {
      get().fetchSupportTickets();
      get().fetchStats();
    };

    supportMessageHandler = (msg: SupportMessageData) => {
      const activeTicket = get().activeTicket;
      if (activeTicket && msg.ticketId === activeTicket.id) {
        const msgs = get().activeTicketMessages;
        if (!msgs.some((m) => m.id === msg.id)) {
          set({ activeTicketMessages: [...msgs, msg] });
        }
      }
    };

    supportStatusHandler = (data) => {
      const activeTicket = get().activeTicket;
      if (activeTicket && data.ticketId === activeTicket.id) {
        set({ activeTicket: { ...activeTicket, status: data.status as SupportTicket['status'], claimedById: data.claimedById ?? null, claimedByUsername: data.claimedByUsername ?? null } });
      }
      // Refresh list
      get().fetchSupportTickets();
    };

    socket.emit('admin:subscribe_support' as any);
    socket.on('support:ticket:new' as any, supportTicketHandler);
    socket.on('support:message:new' as any, supportMessageHandler);
    socket.on('support:status_change' as any, supportStatusHandler);

    supportReconnectUnsub = onSocketReconnect(() => {
      const s = getSocket();
      if (s) {
        s.emit('admin:subscribe_support' as any);
        if (supportTicketHandler) {
          s.off('support:ticket:new' as any, supportTicketHandler);
          s.on('support:ticket:new' as any, supportTicketHandler);
        }
        if (supportMessageHandler) {
          s.off('support:message:new' as any, supportMessageHandler);
          s.on('support:message:new' as any, supportMessageHandler);
        }
        if (supportStatusHandler) {
          s.off('support:status_change' as any, supportStatusHandler);
          s.on('support:status_change' as any, supportStatusHandler);
        }
      }
    });
  },

  unsubscribeSupport: () => {
    const socket = getSocket();
    if (socket) {
      socket.emit('admin:unsubscribe_support' as any);
      if (supportTicketHandler) socket.off('support:ticket:new' as any, supportTicketHandler);
      if (supportMessageHandler) socket.off('support:message:new' as any, supportMessageHandler);
      if (supportStatusHandler) socket.off('support:status_change' as any, supportStatusHandler);
    }
    supportTicketHandler = null;
    supportMessageHandler = null;
    supportStatusHandler = null;
    if (supportReconnectUnsub) {
      supportReconnectUnsub();
      supportReconnectUnsub = null;
    }
  },

  fetchRateLimits: async () => {
    try {
      const { data } = await api.get('/admin/rate-limits');
      set({ rateLimits: data.data });
    } catch {
      console.error('Failed to fetch rate limits');
    }
  },

  updateRateLimit: async (name, updates) => {
    await api.put(`/admin/rate-limits/${name}`, updates);
    await get().fetchRateLimits();
  },

  resetRateLimit: async (name) => {
    await api.post(`/admin/rate-limits/${name}/reset`);
    await get().fetchRateLimits();
  },

  clearUserRateLimits: async (key) => {
    const { data } = await api.post('/admin/rate-limits/clear-user', { key });
    return data.data.cleared as number;
  },

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
        params: { page: p, limit: 12, filter: state.storageFilter },
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
