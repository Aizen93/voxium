import { useEffect, useState, useMemo, useCallback } from 'react';
import { HardDrive, Image, Server, AlertTriangle, Trash2, RefreshCw, Users, Crown, Paperclip } from 'lucide-react';
import { useAdminStore } from '../stores/adminStore';
import { AdminStatCard } from './AdminStatCard';
import { AdminTable } from './AdminTable';
import { AdminConfirmModal } from './AdminConfirmModal';
import { toast } from '../stores/toastStore';
import type { StorageTopUploader } from '@voxium/shared';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

type FilterTab = 'all' | 'avatars' | 'server-icons' | 'attachments' | 'orphaned';

const FILTER_TABS: Array<{ id: FilterTab; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'avatars', label: 'Avatars' },
  { id: 'server-icons', label: 'Server Icons' },
  { id: 'attachments', label: 'Attachments' },
  { id: 'orphaned', label: 'Orphaned' },
];

export function AdminStorage() {
  const {
    storageStats, storageFiles, storageFilesTotal, storageFilesPage, storageFilter, topUploaders,
    fetchStorageStats, fetchStorageFiles, setStorageFilter, deleteStorageFile, cleanupOrphans, fetchTopUploaders,
  } = useAdminStore();

  const [deleteTarget, setDeleteTarget] = useState<{ key: string; linkedEntity: string | null; type: 'avatar' | 'server-icon' | 'attachment' } | null>(null);
  const [showCleanup, setShowCleanup] = useState(false);

  const loadInitial = useCallback(() => {
    fetchStorageStats();
    fetchStorageFiles(1);
    fetchTopUploaders();
  }, [fetchStorageStats, fetchStorageFiles, fetchTopUploaders]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  const handleFilterChange = (filter: FilterTab) => {
    setStorageFilter(filter);
    // fetchStorageFiles reads storageFilter from state, which was just set synchronously
    fetchStorageFiles(1);
  };

  const handleRefresh = () => {
    fetchStorageStats();
    fetchStorageFiles();
    fetchTopUploaders();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteStorageFile(deleteTarget.key);
      toast.success('File deleted');
    } catch {
      toast.error('Failed to delete file');
    }
    setDeleteTarget(null);
  };

  const handleCleanup = async () => {
    try {
      const result = await cleanupOrphans();
      toast.success(`Cleaned up ${result.deleted} of ${result.found} orphaned files`);
    } catch {
      toast.error('Failed to cleanup orphans');
    }
    setShowCleanup(false);
  };

  const columns = [
    { key: 'key', label: 'File Key', width: '30%' },
    { key: 'type', label: 'Type' },
    { key: 'size', label: 'Size' },
    { key: 'linkedTo', label: 'Linked To' },
    { key: 'status', label: 'Status' },
    { key: 'modified', label: 'Modified' },
    { key: 'actions', label: '', width: '50px' },
  ];

  const rows = storageFiles.map((f) => ({
    key: (
      <span className="font-mono text-xs text-vox-text-secondary truncate block max-w-[280px]" title={f.key}>
        {f.key}
      </span>
    ),
    type: (
      <span className={`text-xs px-2 py-0.5 rounded-full ${
        f.type === 'avatar'
          ? 'bg-blue-500/20 text-blue-400'
          : f.type === 'attachment'
          ? 'bg-emerald-500/20 text-emerald-400'
          : 'bg-purple-500/20 text-purple-400'
      }`}>
        {f.type === 'avatar' ? 'Avatar' : f.type === 'attachment' ? 'Attachment' : 'Server Icon'}
      </span>
    ),
    size: <span className="text-xs text-vox-text-secondary">{formatBytes(f.size)}</span>,
    linkedTo: f.linkedEntity ? (
      <span className="text-xs text-vox-text-primary">{f.linkedEntity}</span>
    ) : (
      <span className="text-xs text-vox-text-muted">—</span>
    ),
    status: (
      <span className={`text-xs px-2 py-0.5 rounded-full ${
        f.isExpired
          ? 'bg-red-500/20 text-red-400'
          : f.isOrphan
          ? 'bg-yellow-500/20 text-yellow-400'
          : 'bg-green-500/20 text-green-400'
      }`}>
        {f.isExpired ? 'Expired' : f.isOrphan ? 'Orphaned' : 'Active'}
      </span>
    ),
    modified: (
      <span className="text-xs text-vox-text-muted">
        {f.lastModified ? new Date(f.lastModified).toLocaleDateString() : '—'}
      </span>
    ),
    actions: (
      <button
        onClick={(e) => { e.stopPropagation(); setDeleteTarget({ key: f.key, linkedEntity: f.linkedEntity, type: f.type }); }}
        className="p-1 rounded text-vox-text-muted hover:text-vox-accent-danger transition-colors"
        title="Delete file"
      >
        <Trash2 size={14} />
      </button>
    ),
  }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-vox-text-primary">Storage</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-md bg-vox-bg-secondary text-vox-text-secondary hover:text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
          >
            <RefreshCw size={14} />
            Refresh
          </button>
          {storageStats && storageStats.orphanCount > 0 && (
            <button
              onClick={() => setShowCleanup(true)}
              className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-md bg-vox-accent-danger/20 text-vox-accent-danger hover:bg-vox-accent-danger/30 transition-colors"
            >
              <AlertTriangle size={14} />
              Cleanup {storageStats.orphanCount} Orphan{storageStats.orphanCount !== 1 ? 's' : ''}
            </button>
          )}
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <AdminStatCard
          label="Total Storage"
          value={storageStats ? formatBytes(storageStats.totalSize) : '—'}
          icon={HardDrive}
        />
        <AdminStatCard
          label={`Avatars (${storageStats?.avatarCount ?? 0})`}
          value={storageStats ? formatBytes(storageStats.avatarSize) : '—'}
          icon={Image}
          color="text-blue-400"
        />
        <AdminStatCard
          label={`Server Icons (${storageStats?.serverIconCount ?? 0})`}
          value={storageStats ? formatBytes(storageStats.serverIconSize) : '—'}
          icon={Server}
          color="text-purple-400"
        />
        <AdminStatCard
          label={`Attachments (${storageStats?.attachmentCount ?? 0})`}
          value={storageStats ? formatBytes(storageStats.attachmentSize) : '—'}
          icon={Paperclip}
          color="text-emerald-400"
        />
        <AdminStatCard
          label={`Orphaned (${storageStats?.orphanCount ?? 0})`}
          value={storageStats ? formatBytes(storageStats.orphanSize) : '—'}
          icon={AlertTriangle}
          color="text-yellow-400"
        />
      </div>

      {/* Top Uploaders */}
      {topUploaders.length > 0 && <TopUploaders uploaders={topUploaders} />}

      {/* Filter Tabs */}
      <div className="flex gap-1 bg-vox-bg-hover rounded-lg p-1">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => handleFilterChange(tab.id)}
            className={`flex-1 text-sm py-1.5 rounded-md transition-colors ${
              storageFilter === tab.id
                ? 'bg-vox-bg-secondary text-vox-text-primary'
                : 'text-vox-text-muted hover:text-vox-text-secondary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* File Table */}
      <AdminTable
        columns={columns}
        rows={rows}
        page={storageFilesPage}
        total={storageFilesTotal}
        onPageChange={(p) => fetchStorageFiles(p)}
      />

      {/* Delete Modal */}
      {deleteTarget && (
        <AdminConfirmModal
          title="Delete File"
          message={`Delete "${deleteTarget.key}"?${
            deleteTarget.type === 'attachment'
              ? ' This attachment will show as expired in the chat.'
              : deleteTarget.linkedEntity
              ? ` This file is currently linked to "${deleteTarget.linkedEntity}" — their avatar/icon will be removed.`
              : ' This is an orphaned file.'
          }`}
          confirmLabel="Delete"
          danger
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* Cleanup Modal */}
      {showCleanup && storageStats && (
        <AdminConfirmModal
          title="Cleanup Orphaned Files"
          message={`This will permanently delete ${storageStats.orphanCount} orphaned file${storageStats.orphanCount !== 1 ? 's' : ''} (${formatBytes(storageStats.orphanSize)}). These files are not referenced by any user avatar, server icon, or message attachment. This action is irreversible.`}
          confirmLabel="Delete All Orphans"
          danger
          onConfirm={handleCleanup}
          onCancel={() => setShowCleanup(false)}
        />
      )}
    </div>
  );
}

function TopUploaders({ uploaders }: { uploaders: StorageTopUploader[] }) {
  const topUsers = useMemo(() => uploaders.filter((u) => u.type === 'user').slice(0, 5), [uploaders]);
  const topServers = useMemo(() => uploaders.filter((u) => u.type === 'server').slice(0, 5), [uploaders]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <UploaderPanel title="Top Users" icon={Users} items={topUsers} color="text-blue-400" />
      <UploaderPanel title="Top Servers" icon={Crown} items={topServers} color="text-purple-400" />
    </div>
  );
}

function UploaderPanel({
  title,
  icon: Icon,
  items,
  color,
}: {
  title: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  items: StorageTopUploader[];
  color: string;
}) {
  const maxSize = items.length > 0 ? items[0].totalSize : 1;

  return (
    <div className="bg-vox-bg-secondary rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3">
        <Icon size={16} className={color} />
        <h3 className="text-sm font-semibold text-vox-text-primary">{title}</h3>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-vox-text-muted">No data</p>
      ) : (
        <div className="space-y-2">
          {items.map((item, i) => (
            <div key={item.entityId} className="flex items-center gap-3">
              <span className="text-xs text-vox-text-muted w-4 text-right">{i + 1}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-sm text-vox-text-primary truncate">{item.entityName}</span>
                  <span className="text-xs text-vox-text-muted ml-2 shrink-0">
                    {item.fileCount} file{item.fileCount !== 1 ? 's' : ''} &middot; {formatBytes(item.totalSize)}
                  </span>
                </div>
                <div className="w-full h-1.5 bg-vox-bg-hover rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${color === 'text-blue-400' ? 'bg-blue-500' : 'bg-purple-500'}`}
                    style={{ width: `${(item.totalSize / maxSize) * 100}%` }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
