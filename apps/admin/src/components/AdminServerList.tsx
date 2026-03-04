import { useEffect, useState, useCallback } from 'react';
import { Search, Trash2 } from 'lucide-react';
import { useAdminStore } from '../stores/adminStore';
import { AdminTable } from './AdminTable';
import { AdminConfirmModal } from './AdminConfirmModal';
import { toast } from '../stores/toastStore';

export function AdminServerList() {
  const { servers, serversTotal, serversPage, serversSearch, loading, fetchServers, setServersSearch, deleteServer } = useAdminStore();
  const [searchInput, setSearchInput] = useState(serversSearch);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    fetchServers(1);
  }, [fetchServers]);

  const handleSearch = useCallback(() => {
    setServersSearch(searchInput);
    fetchServers(1);
  }, [searchInput, setServersSearch, fetchServers]);

  const columns = [
    { key: 'name', label: 'Name' },
    { key: 'owner', label: 'Owner' },
    { key: 'members', label: 'Members', width: '80px' },
    { key: 'channels', label: 'Channels', width: '80px' },
    { key: 'messages', label: 'Messages', width: '100px' },
    { key: 'created', label: 'Created', width: '120px' },
    { key: 'actions', label: '', width: '60px' },
  ];

  const rows = servers.map((server) => ({
    name: <span className="text-vox-text-primary font-medium">{server.name}</span>,
    owner: server.ownerUsername,
    members: server.memberCount,
    channels: server.channelCount,
    messages: server.messageCount.toLocaleString(),
    created: new Date(server.createdAt).toLocaleDateString(),
    actions: (
      <div onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => setDeleteTarget({ id: server.id, name: server.name })}
          className="p-1 rounded text-vox-text-muted hover:text-vox-accent-danger"
          title="Delete server"
        >
          <Trash2 size={14} />
        </button>
      </div>
    ),
  }));

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-vox-text-primary">Servers</h2>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-vox-text-muted" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Search servers..."
            className="w-full rounded-md bg-vox-bg-hover border border-vox-border text-sm text-vox-text-primary pl-9 pr-3 py-2 placeholder:text-vox-text-muted focus:outline-none focus:border-vox-accent-primary"
          />
        </div>
        <button onClick={handleSearch} className="px-4 py-2 text-sm rounded-md bg-vox-accent-primary text-white hover:bg-vox-accent-hover transition-colors">
          Search
        </button>
      </div>

      <div className="rounded-lg bg-vox-bg-secondary border border-vox-border overflow-hidden">
        <AdminTable columns={columns} rows={rows} page={serversPage} total={serversTotal} onPageChange={(p) => fetchServers(p)} />
      </div>

      {loading && (
        <div className="flex justify-center py-4">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-vox-accent-primary border-t-transparent" />
        </div>
      )}

      {deleteTarget && (
        <AdminConfirmModal
          title="Delete Server"
          message={`Permanently delete "${deleteTarget.name}"? All channels, messages, and members will be removed. This cannot be undone.`}
          confirmLabel="Delete Server"
          onConfirm={async () => {
            try {
              await deleteServer(deleteTarget.id);
              toast.success('Server deleted');
            } catch { toast.error('Failed to delete server'); }
            setDeleteTarget(null);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
