import { useEffect, useState, useCallback } from 'react';
import { Search, Trash2, Settings2, RotateCcw, Save, X, Star, StarOff, Ban, ShieldOff } from 'lucide-react';
import { useAdminStore } from '../stores/adminStore';
import { AdminTable } from './AdminTable';
import { AdminConfirmModal } from './AdminConfirmModal';
import { DirectoryChips } from './DirectoryChips';
import { toast } from '../stores/toastStore';
import { apiErrorMessage } from '../utils/apiError';
import type { AdminServer, ResourceLimits, ServerResourceLimits } from '@voxium/shared';

const LIMIT_FIELDS: Array<{ key: keyof ResourceLimits; label: string; description: string; min: number; max: number }> = [
  { key: 'maxChannelsPerServer', label: 'Max Channels / Server', description: 'Maximum text + voice channels per server', min: 1, max: 500 },
  { key: 'maxVoiceUsersPerChannel', label: 'Max Voice Users / Channel', description: 'Maximum users in a single voice channel', min: 1, max: 500 },
  { key: 'maxCategoriesPerServer', label: 'Max Categories / Server', description: 'Maximum channel categories per server', min: 1, max: 200 },
  { key: 'maxMembersPerServer', label: 'Max Members / Server', description: 'Maximum members per server (0 = unlimited)', min: 0, max: 100000 },
];

// Directory curation (server discovery). Featured is a hand-picked row on the
// first page of Explore and never changes the ranked list; Block hides the
// server and the owner cannot relist until an admin unblocks (hiding alone
// invites a relist war). Unblock does not relist: the owner switches it back
// on. Every action is audited server-side.
type CurationAction = 'feature' | 'unfeature' | 'block' | 'unblock';
const CURATION: Record<CurationAction, {
  title: string; confirmLabel: string; variant: 'danger' | 'primary';
  patch: { featured?: boolean; blocked?: boolean }; done: string; message: (name: string) => string;
}> = {
  feature: {
    title: 'Feature in Explore', confirmLabel: 'Feature', variant: 'primary', patch: { featured: true }, done: 'Server featured',
    message: (n) => `Show "${n}" in the Featured row on the first page of Explore? Featured is hand-picked and never changes the ranked list.`,
  },
  unfeature: {
    title: 'Remove from Featured', confirmLabel: 'Unfeature', variant: 'primary', patch: { featured: false }, done: 'Server unfeatured',
    message: (n) => `Take "${n}" out of the Featured row? It stays listed.`,
  },
  block: {
    title: 'Block from directory', confirmLabel: 'Block', variant: 'danger', patch: { blocked: true }, done: 'Server blocked from the directory',
    message: (n) => `Hide "${n}" from Explore and stop its owner from relisting it until an admin unblocks it? Members, invites and the server itself are not affected.`,
  },
  unblock: {
    title: 'Unblock from directory', confirmLabel: 'Unblock', variant: 'primary', patch: { blocked: false }, done: 'Server unblocked. Its owner can relist it from Server settings.',
    message: (n) => `Lift the directory block on "${n}"? It does not relist by itself: the owner switches it back on from Server settings, Discovery tab.`,
  },
};

export function AdminServerList() {
  const {
    servers, serversTotal, serversPage, serversSearch, serversListedOnly, loading,
    fetchServers, setServersSearch, setServersListedOnly, setServerDiscovery, deleteServer,
    globalLimits, serverLimits, serverLimitsServerId,
    fetchGlobalLimits, updateGlobalLimits,
    fetchServerLimits, updateServerLimits, resetServerLimits,
  } = useAdminStore();
  const [searchInput, setSearchInput] = useState(serversSearch);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [editingServer, setEditingServer] = useState<{ id: string; name: string } | null>(null);
  const [showGlobalLimits, setShowGlobalLimits] = useState(false);
  const [curation, setCuration] = useState<{ server: AdminServer; action: CurationAction } | null>(null);

  useEffect(() => {
    fetchServers(1);
    fetchGlobalLimits();
  }, [fetchServers, fetchGlobalLimits]);

  const handleSearch = useCallback(() => {
    setServersSearch(searchInput);
    fetchServers(1);
  }, [searchInput, setServersSearch, fetchServers]);

  const openServerLimits = (server: { id: string; name: string }) => {
    setEditingServer(server);
    fetchServerLimits(server.id);
  };

  const columns = [
    { key: 'name', label: 'Name' },
    { key: 'owner', label: 'Owner' },
    { key: 'directory', label: 'Directory', width: '180px' },
    { key: 'members', label: 'Members', width: '80px' },
    { key: 'channels', label: 'Channels', width: '80px' },
    { key: 'messages', label: 'Messages', width: '100px' },
    { key: 'created', label: 'Created', width: '120px' },
    { key: 'actions', label: '', width: '150px' },
  ];

  const rows = servers.map((server) => ({
    name: <span className="text-vox-text-primary font-medium">{server.name}</span>,
    owner: server.ownerUsername,
    directory: <DirectoryChips server={server} />,
    members: server.memberCount,
    channels: server.channelCount,
    messages: server.messageCount.toLocaleString(),
    created: new Date(server.createdAt).toLocaleDateString(),
    actions: (
      <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
        {server.featuredAt ? (
          <button
            onClick={() => setCuration({ server, action: 'unfeature' })}
            className="p-1 rounded text-purple-400 hover:text-vox-text-primary"
            title="Remove from Featured"
            data-testid="server-unfeature"
          >
            <StarOff size={14} />
          </button>
        ) : (
          <button
            onClick={() => setCuration({ server, action: 'feature' })}
            disabled={!server.discoveryListed}
            className="p-1 rounded text-vox-text-muted hover:text-purple-400 disabled:opacity-30 disabled:cursor-not-allowed"
            title={server.discoveryListed ? 'Feature in Explore' : 'Only listed servers can be featured'}
            data-testid="server-feature"
          >
            <Star size={14} />
          </button>
        )}
        {server.discoveryBlockedAt ? (
          <button
            onClick={() => setCuration({ server, action: 'unblock' })}
            className="p-1 rounded text-orange-400 hover:text-vox-text-primary"
            title="Unblock from directory"
            data-testid="server-unblock"
          >
            <ShieldOff size={14} />
          </button>
        ) : (
          <button
            onClick={() => setCuration({ server, action: 'block' })}
            className="p-1 rounded text-vox-text-muted hover:text-orange-400"
            title="Block from directory"
            data-testid="server-block"
          >
            <Ban size={14} />
          </button>
        )}
        <button
          onClick={() => openServerLimits({ id: server.id, name: server.name })}
          className="p-1 rounded text-vox-text-muted hover:text-vox-accent-info"
          title="Configure limits"
        >
          <Settings2 size={14} />
        </button>
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

      {/* Global Limits Panel */}
      <div className="rounded-lg bg-vox-bg-secondary border border-vox-border">
        <button
          onClick={() => setShowGlobalLimits(!showGlobalLimits)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-vox-text-primary hover:bg-vox-bg-hover rounded-lg transition-colors"
        >
          <span className="flex items-center gap-2">
            <Settings2 size={14} className="text-vox-accent-info" />
            Global Resource Limits
          </span>
          <span className="text-xs text-vox-text-muted">{showGlobalLimits ? 'Hide' : 'Show'}</span>
        </button>
        {showGlobalLimits && globalLimits && (
          <div className="px-4 pb-4 border-t border-vox-border">
            <p className="text-xs text-vox-text-muted mt-3 mb-3">
              Default limits applied to all servers. Per-server overrides take priority.
            </p>
            <GlobalLimitsEditor limits={globalLimits} onSave={updateGlobalLimits} />
          </div>
        )}
      </div>

      {/* Search + Table */}
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
        <label className="flex items-center gap-2 px-3 text-xs text-vox-text-secondary whitespace-nowrap select-none" title="Only servers currently in Explore">
          <input
            type="checkbox"
            checked={serversListedOnly}
            onChange={(e) => { setServersListedOnly(e.target.checked); fetchServers(1); }}
            className="rounded"
            data-testid="servers-listed-only"
          />
          Listed only
        </label>
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

      {/* Server Limits Modal */}
      {editingServer && (
        <ServerLimitsModal
          serverName={editingServer.name}
          serverId={editingServer.id}
          serverLimits={serverLimitsServerId === editingServer.id ? serverLimits : null}
          globalLimits={globalLimits}
          onSave={(limits) => updateServerLimits(editingServer.id, limits)}
          onReset={() => resetServerLimits(editingServer.id)}
          onClose={() => setEditingServer(null)}
        />
      )}

      {curation && (
        <AdminConfirmModal
          title={CURATION[curation.action].title}
          message={CURATION[curation.action].message(curation.server.name)}
          confirmLabel={CURATION[curation.action].confirmLabel}
          variant={CURATION[curation.action].variant}
          onConfirm={async () => {
            const spec = CURATION[curation.action];
            try {
              await setServerDiscovery(curation.server.id, spec.patch);
              toast.success(spec.done);
              // "Listed only": a blocked server no longer belongs on the page
              if (serversListedOnly) await fetchServers();
            } catch (err) {
              // the server says why (e.g. "Only listed servers can be featured")
              toast.error(apiErrorMessage(err, 'Failed to update the directory state'));
            }
            setCuration(null);
          }}
          onCancel={() => setCuration(null)}
        />
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

// ─── Global Limits Editor ──────────────────────────────────────────────────

function GlobalLimitsEditor({ limits, onSave }: { limits: ResourceLimits; onSave: (l: Partial<ResourceLimits>) => Promise<void> }) {
  const [draft, setDraft] = useState<ResourceLimits>({ ...limits });
  const [saving, setSaving] = useState(false);

  useEffect(() => { setDraft({ ...limits }); }, [limits]);

  const hasChanges = LIMIT_FIELDS.some((f) => draft[f.key] !== limits[f.key]);

  const handleSave = async () => {
    setSaving(true);
    try { await onSave(draft); } catch { toast.error('Failed to save limits'); }
    setSaving(false);
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {LIMIT_FIELDS.map((field) => (
          <div key={field.key}>
            <label className="block text-xs font-medium text-vox-text-secondary mb-1">{field.label}</label>
            <input
              type="number"
              min={field.min}
              max={field.max}
              value={draft[field.key]}
              onChange={(e) => setDraft({ ...draft, [field.key]: Number(e.target.value) })}
              className="w-full rounded-md bg-vox-bg-hover border border-vox-border text-sm text-vox-text-primary px-3 py-1.5 focus:outline-none focus:border-vox-accent-primary"
            />
            <p className="text-[10px] text-vox-text-muted mt-0.5">{field.description}</p>
          </div>
        ))}
      </div>
      {hasChanges && (
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={() => setDraft({ ...limits })} className="px-3 py-1.5 text-xs rounded-md text-vox-text-muted hover:text-vox-text-primary hover:bg-vox-bg-hover transition-colors">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-vox-accent-primary text-white hover:bg-vox-accent-hover disabled:opacity-50 transition-colors"
          >
            <Save size={12} />
            Save Global Limits
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Server Limits Modal ───────────────────────────────────────────────────

function ServerLimitsModal({
  serverName,
  serverId: _serverId,
  serverLimits,
  globalLimits,
  onSave,
  onReset,
  onClose,
}: {
  serverName: string;
  serverId: string;
  serverLimits: ServerResourceLimits | null;
  globalLimits: ResourceLimits | null;
  onSave: (limits: Partial<ServerResourceLimits>) => Promise<void>;
  onReset: () => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (serverLimits) {
      const d: Record<string, string> = {};
      for (const f of LIMIT_FIELDS) {
        const v = serverLimits[f.key as keyof ServerResourceLimits];
        d[f.key] = v !== null && v !== undefined ? String(v) : '';
      }
      setDraft(d);
    }
  }, [serverLimits]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updates: Record<string, number | null> = {};
      for (const f of LIMIT_FIELDS) {
        const val = draft[f.key];
        updates[f.key] = val === '' ? null : Number(val);
      }
      await onSave(updates);
    } catch { toast.error('Failed to save server limits'); }
    setSaving(false);
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      await onReset();
      const d: Record<string, string> = {};
      for (const f of LIMIT_FIELDS) d[f.key] = '';
      setDraft(d);
    } catch { toast.error('Failed to reset limits'); }
    setSaving(false);
  };

  const hasOverrides = LIMIT_FIELDS.some((f) => draft[f.key] !== '');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-vox-bg-secondary border border-vox-border rounded-lg w-full max-w-lg mx-4 shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-vox-border">
          <div>
            <h3 className="text-sm font-semibold text-vox-text-primary">Server Limits</h3>
            <p className="text-xs text-vox-text-muted">{serverName}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-vox-bg-hover text-vox-text-muted hover:text-vox-text-primary">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className="text-xs text-vox-text-muted">
            Leave empty to use the global default. Set a value to override for this server only.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {LIMIT_FIELDS.map((field) => {
              const globalVal = globalLimits?.[field.key] ?? '-';
              return (
                <div key={field.key}>
                  <label className="block text-xs font-medium text-vox-text-secondary mb-1">
                    {field.label}
                    <span className="ml-2 text-[10px] text-vox-text-muted font-normal">Global: {globalVal}</span>
                  </label>
                  <input
                    type="number"
                    min={field.min}
                    max={field.max}
                    value={draft[field.key] ?? ''}
                    onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
                    placeholder={String(globalVal)}
                    className="w-full rounded-md bg-vox-bg-hover border border-vox-border text-sm text-vox-text-primary px-3 py-1.5 placeholder:text-vox-text-muted/50 focus:outline-none focus:border-vox-accent-primary"
                  />
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between px-5 py-3 border-t border-vox-border">
          <button
            onClick={handleReset}
            disabled={saving || !hasOverrides}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md text-vox-text-muted hover:text-vox-accent-warning hover:bg-vox-bg-hover disabled:opacity-30 transition-colors"
            title="Remove all overrides and use global defaults"
          >
            <RotateCcw size={12} />
            Reset to Global
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-xs rounded-md text-vox-text-muted hover:text-vox-text-primary hover:bg-vox-bg-hover transition-colors">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-vox-accent-primary text-white hover:bg-vox-accent-hover disabled:opacity-50 transition-colors"
            >
              <Save size={12} />
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
