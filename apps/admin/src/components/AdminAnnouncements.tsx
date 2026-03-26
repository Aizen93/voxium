import { useEffect, useState } from 'react';
import axios from 'axios';
import { Megaphone, Plus, Send, Trash2, X } from 'lucide-react';
import { clsx } from 'clsx';
import { useAdminStore } from '../stores/adminStore';
import { AdminTable } from './AdminTable';
import { AdminConfirmModal } from './AdminConfirmModal';
import { toast } from '../stores/toastStore';
import type { Announcement } from '@voxium/shared';

type FilterTab = 'all' | 'active' | 'draft' | 'expired';

const FILTER_TABS: Array<{ id: FilterTab; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'draft', label: 'Draft' },
  { id: 'expired', label: 'Expired' },
];

function getStatus(a: Announcement): 'draft' | 'active' | 'expired' {
  if (!a.publishedAt) return 'draft';
  if (a.expiresAt && new Date(a.expiresAt) <= new Date()) return 'expired';
  return 'active';
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'active' ? 'bg-green-500/20 text-green-400' :
    status === 'draft' ? 'bg-gray-500/20 text-gray-400' :
    'bg-red-500/20 text-red-400';
  return <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${cls}`}>{status}</span>;
}

function TypeBadge({ type }: { type: string }) {
  const cls =
    type === 'warning' ? 'bg-yellow-500/20 text-yellow-400' :
    type === 'maintenance' ? 'bg-red-500/20 text-red-400' :
    'bg-blue-500/20 text-blue-400';
  return <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${cls}`}>{type}</span>;
}

export function AdminAnnouncements() {
  const {
    announcements, announcementsTotal, announcementsPage, announcementsFilter,
    fetchAnnouncements, setAnnouncementsFilter, createAnnouncement, publishAnnouncement, deleteAnnouncement,
    servers, fetchServers,
  } = useAdminStore();

  const [showCreate, setShowCreate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Announcement | null>(null);
  const [confirmPublish, setConfirmPublish] = useState<Announcement | null>(null);

  // Form state
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [type, setType] = useState('info');
  const [scope, setScope] = useState('global');
  const [selectedServerIds, setSelectedServerIds] = useState<string[]>([]);
  const [expiresAt, setExpiresAt] = useState('');
  const [publishImmediately, setPublishImmediately] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchAnnouncements(1);
  }, [fetchAnnouncements]);

  useEffect(() => {
    fetchAnnouncements(1);
  }, [announcementsFilter, fetchAnnouncements]);

  const handleTabChange = (tab: FilterTab) => {
    setAnnouncementsFilter(tab);
  };

  const resetForm = () => {
    setTitle('');
    setContent('');
    setType('info');
    setScope('global');
    setSelectedServerIds([]);
    setExpiresAt('');
    setPublishImmediately(false);
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      await createAnnouncement({
        title,
        content,
        type,
        scope,
        serverIds: scope === 'servers' ? selectedServerIds : undefined,
        expiresAt: expiresAt || undefined,
        publish: publishImmediately,
      });
      toast.success(publishImmediately ? 'Announcement created and published' : 'Announcement draft created');
      setShowCreate(false);
      resetForm();
    } catch (err: unknown) {
      const msg = (axios.isAxiosError(err) && (err.response?.data?.error || err.response?.data?.message)) || 'Failed to create announcement';
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  };

  const openCreateModal = () => {
    if (scope === 'servers' && servers.length === 0) {
      fetchServers(1);
    }
    setShowCreate(true);
  };

  const columns = [
    { key: 'title', label: 'Title' },
    { key: 'content', label: 'Content' },
    { key: 'type', label: 'Type', width: '100px' },
    { key: 'scope', label: 'Scope', width: '100px' },
    { key: 'status', label: 'Status', width: '100px' },
    { key: 'expiresAt', label: 'Expires', width: '160px' },
    { key: 'createdAt', label: 'Created', width: '160px' },
    { key: 'actions', label: '', width: '80px' },
  ];

  const rows = announcements.map((a) => {
    const status = getStatus(a);
    return {
      title: <span className="text-vox-text-primary font-medium">{a.title}</span>,
      content: <span className="text-vox-text-secondary text-xs line-clamp-2">{a.content}</span>,
      type: <TypeBadge type={a.type} />,
      scope: <span className="capitalize text-xs">{a.scope}</span>,
      status: <StatusBadge status={status} />,
      expiresAt: a.expiresAt ? new Date(a.expiresAt).toLocaleString() : <span className="text-vox-text-muted italic">Never</span>,
      createdAt: new Date(a.createdAt).toLocaleString(),
      actions: (
        <div className="flex items-center gap-1">
          {status === 'draft' && (
            <button
              onClick={(e) => { e.stopPropagation(); setConfirmPublish(a); }}
              className="p-1 rounded text-vox-text-muted hover:text-vox-accent-success"
              title="Publish"
            >
              <Send size={14} />
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); setConfirmDelete(a); }}
            className="p-1 rounded text-vox-text-muted hover:text-vox-accent-danger"
            title="Delete"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ),
    };
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Megaphone size={24} className="text-vox-accent-primary" />
          <h2 className="text-xl font-bold text-vox-text-primary">Announcements</h2>
        </div>
        <button
          onClick={openCreateModal}
          className="flex items-center gap-2 px-3 py-2 text-sm rounded-md bg-vox-accent-primary text-white hover:bg-vox-accent-hover transition-colors"
        >
          <Plus size={14} />
          Create Announcement
        </button>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 p-1 bg-vox-bg-secondary rounded-lg w-fit">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => handleTabChange(tab.id)}
            className={clsx(
              'px-4 py-1.5 text-sm rounded-md transition-colors',
              announcementsFilter === tab.id
                ? 'bg-vox-accent-primary/20 text-vox-accent-primary font-medium'
                : 'text-vox-text-secondary hover:text-vox-text-primary'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="bg-vox-bg-secondary rounded-lg border border-vox-border overflow-hidden">
        <AdminTable
          columns={columns}
          rows={rows}
          page={announcementsPage}
          total={announcementsTotal}
          onPageChange={(p) => fetchAnnouncements(p)}
        />
      </div>

      {/* Create modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-lg rounded-lg bg-vox-bg-secondary p-6 shadow-xl border border-vox-border">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-vox-text-primary">Create Announcement</h3>
              <button onClick={() => { setShowCreate(false); resetForm(); }} className="text-vox-text-muted hover:text-vox-text-primary">
                <X size={20} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-vox-text-muted mb-1">Title</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Announcement title..."
                  maxLength={200}
                  className="w-full px-3 py-2 text-sm rounded-md bg-vox-bg-primary border border-vox-border text-vox-text-primary placeholder:text-vox-text-muted focus:outline-none focus:ring-1 focus:ring-vox-accent-primary"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-vox-text-muted mb-1">Content</label>
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Announcement content..."
                  rows={4}
                  maxLength={2000}
                  className="w-full px-3 py-2 text-sm rounded-md bg-vox-bg-primary border border-vox-border text-vox-text-primary placeholder:text-vox-text-muted focus:outline-none focus:ring-1 focus:ring-vox-accent-primary resize-none"
                />
              </div>

              <div className="flex gap-4">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-vox-text-muted mb-1">Type</label>
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                    className="w-full px-3 py-2 text-sm rounded-md bg-vox-bg-primary border border-vox-border text-vox-text-primary focus:outline-none focus:ring-1 focus:ring-vox-accent-primary"
                  >
                    <option value="info">Info</option>
                    <option value="warning">Warning</option>
                    <option value="maintenance">Maintenance</option>
                  </select>
                </div>

                <div className="flex-1">
                  <label className="block text-xs font-medium text-vox-text-muted mb-1">Scope</label>
                  <select
                    value={scope}
                    onChange={(e) => {
                      setScope(e.target.value);
                      if (e.target.value === 'servers' && servers.length === 0) fetchServers(1);
                    }}
                    className="w-full px-3 py-2 text-sm rounded-md bg-vox-bg-primary border border-vox-border text-vox-text-primary focus:outline-none focus:ring-1 focus:ring-vox-accent-primary"
                  >
                    <option value="global">Global</option>
                    <option value="servers">Specific Servers</option>
                  </select>
                </div>
              </div>

              {scope === 'servers' && (
                <div>
                  <label className="block text-xs font-medium text-vox-text-muted mb-1">Servers</label>
                  <div className="max-h-32 overflow-y-auto rounded-md bg-vox-bg-primary border border-vox-border p-2 space-y-1">
                    {servers.map((s) => (
                      <label key={s.id} className="flex items-center gap-2 text-sm text-vox-text-secondary hover:text-vox-text-primary cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedServerIds.includes(s.id)}
                          onChange={(e) => {
                            if (e.target.checked) setSelectedServerIds([...selectedServerIds, s.id]);
                            else setSelectedServerIds(selectedServerIds.filter((id) => id !== s.id));
                          }}
                          className="rounded"
                        />
                        {s.name}
                      </label>
                    ))}
                    {servers.length === 0 && <span className="text-xs text-vox-text-muted">Loading servers...</span>}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-vox-text-muted mb-1">Expires At (optional)</label>
                <input
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-md bg-vox-bg-primary border border-vox-border text-vox-text-primary focus:outline-none focus:ring-1 focus:ring-vox-accent-primary"
                />
              </div>

              <label className="flex items-center gap-2 text-sm text-vox-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={publishImmediately}
                  onChange={(e) => setPublishImmediately(e.target.checked)}
                  className="rounded"
                />
                Publish immediately
              </label>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => { setShowCreate(false); resetForm(); }}
                className="px-4 py-2 text-sm rounded-md bg-vox-bg-hover text-vox-text-secondary hover:text-vox-text-primary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !title.trim() || !content.trim() || (scope === 'servers' && selectedServerIds.length === 0)}
                className="px-4 py-2 text-sm rounded-md bg-vox-accent-primary text-white hover:bg-vox-accent-hover transition-colors disabled:opacity-50"
              >
                {creating ? 'Creating...' : publishImmediately ? 'Create & Publish' : 'Save Draft'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Publish confirm */}
      {confirmPublish && (
        <AdminConfirmModal
          title="Publish Announcement"
          message={`Publish "${confirmPublish.title}"? This will broadcast it to ${confirmPublish.scope === 'global' ? 'all users' : 'selected servers'}.`}
          confirmLabel="Publish"
          danger={false}
          onConfirm={async () => {
            try {
              await publishAnnouncement(confirmPublish.id);
              toast.success('Announcement published');
            } catch {
              toast.error('Failed to publish');
            }
            setConfirmPublish(null);
          }}
          onCancel={() => setConfirmPublish(null)}
        />
      )}

      {/* Delete confirm */}
      {confirmDelete && (
        <AdminConfirmModal
          title="Delete Announcement"
          message={`Delete "${confirmDelete.title}"? This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={async () => {
            try {
              await deleteAnnouncement(confirmDelete.id);
              toast.success('Announcement deleted');
            } catch {
              toast.error('Failed to delete');
            }
            setConfirmDelete(null);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
