import { useEffect, useRef, useState } from 'react';
import { ShieldOff, Plus, Trash2 } from 'lucide-react';
import { useAdminStore } from '../stores/adminStore';
import { AdminTable } from './AdminTable';
import { AdminConfirmModal } from './AdminConfirmModal';
import { toast } from '../stores/toastStore';

export function AdminBanList() {
  const { bans, bansTotal, bansPage, ipBans, ipBansTotal, ipBansPage, fetchBans, fetchIpBans, unbanUser, addIpBan, removeIpBan } = useAdminStore();
  const [tab, setTab] = useState<'account' | 'ip'>('account');
  const [showAddIp, setShowAddIp] = useState(false);
  const [ipInput, setIpInput] = useState('');
  const [reasonInput, setReasonInput] = useState('');
  const [confirmUnban, setConfirmUnban] = useState<{ id: string; username: string } | null>(null);
  const [confirmRemoveIp, setConfirmRemoveIp] = useState<{ id: string; ip: string } | null>(null);

  const initialMount = useRef(true);

  useEffect(() => {
    fetchBans(1);
    fetchIpBans(1);
  }, [fetchBans, fetchIpBans]);

  useEffect(() => {
    if (initialMount.current) {
      initialMount.current = false;
      return;
    }
    if (tab === 'account') fetchBans();
    else fetchIpBans();
  }, [tab, fetchBans, fetchIpBans]);

  const accountColumns = [
    { key: 'username', label: 'Username' },
    { key: 'email', label: 'Email' },
    { key: 'bannedAt', label: 'Banned At', width: '160px' },
    { key: 'reason', label: 'Reason' },
    { key: 'actions', label: '', width: '60px' },
  ];

  const accountRows = bans.map((ban) => ({
    username: <span className="text-vox-text-primary font-medium">{ban.username}</span>,
    email: ban.email,
    bannedAt: new Date(ban.bannedAt).toLocaleString(),
    reason: ban.banReason || <span className="text-vox-text-muted italic">No reason</span>,
    actions: (
      <button
        onClick={(e) => { e.stopPropagation(); setConfirmUnban({ id: ban.id, username: ban.username }); }}
        className="p-1 rounded text-vox-text-muted hover:text-vox-accent-success"
        title="Unban"
      >
        <ShieldOff size={14} />
      </button>
    ),
  }));

  const ipColumns = [
    { key: 'ip', label: 'IP Address' },
    { key: 'reason', label: 'Reason' },
    { key: 'bannedBy', label: 'Banned By' },
    { key: 'createdAt', label: 'Created', width: '160px' },
    { key: 'actions', label: '', width: '60px' },
  ];

  const ipRows = ipBans.map((ban) => ({
    ip: <code className="text-vox-text-primary font-mono text-xs bg-vox-bg-hover px-2 py-0.5 rounded">{ban.ip}</code>,
    reason: ban.reason || <span className="text-vox-text-muted italic">No reason</span>,
    bannedBy: ban.bannedByUsername,
    createdAt: new Date(ban.createdAt).toLocaleString(),
    actions: (
      <button
        onClick={(e) => { e.stopPropagation(); setConfirmRemoveIp({ id: ban.id, ip: ban.ip }); }}
        className="p-1 rounded text-vox-text-muted hover:text-vox-accent-danger"
        title="Remove ban"
      >
        <Trash2 size={14} />
      </button>
    ),
  }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-vox-text-primary">Bans</h2>
        {tab === 'ip' && (
          <button
            onClick={() => setShowAddIp(true)}
            className="flex items-center gap-1 px-3 py-1.5 text-sm rounded-md bg-vox-accent-primary text-white hover:bg-vox-accent-hover"
          >
            <Plus size={14} /> Add IP Ban
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-vox-bg-hover rounded-lg p-1">
        <button
          onClick={() => setTab('account')}
          className={`flex-1 text-sm py-1.5 rounded-md transition-colors ${tab === 'account' ? 'bg-vox-bg-secondary text-vox-text-primary' : 'text-vox-text-muted hover:text-vox-text-secondary'}`}
        >
          Account Bans ({bansTotal})
        </button>
        <button
          onClick={() => setTab('ip')}
          className={`flex-1 text-sm py-1.5 rounded-md transition-colors ${tab === 'ip' ? 'bg-vox-bg-secondary text-vox-text-primary' : 'text-vox-text-muted hover:text-vox-text-secondary'}`}
        >
          IP Bans ({ipBansTotal})
        </button>
      </div>

      <div className="rounded-lg bg-vox-bg-secondary border border-vox-border overflow-hidden">
        {tab === 'account' ? (
          <AdminTable columns={accountColumns} rows={accountRows} page={bansPage} total={bansTotal} onPageChange={(p) => fetchBans(p)} />
        ) : (
          <AdminTable columns={ipColumns} rows={ipRows} page={ipBansPage} total={ipBansTotal} onPageChange={(p) => fetchIpBans(p)} />
        )}
      </div>

      {/* Add IP Ban Modal */}
      {showAddIp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md rounded-lg bg-vox-bg-secondary p-6 shadow-xl border border-vox-border">
            <h3 className="text-lg font-semibold text-vox-text-primary mb-4">Add IP Ban</h3>
            <div className="space-y-3">
              <input
                type="text"
                value={ipInput}
                onChange={(e) => setIpInput(e.target.value)}
                placeholder="IP Address"
                className="w-full rounded-md bg-vox-bg-hover border border-vox-border text-sm text-vox-text-primary px-3 py-2 placeholder:text-vox-text-muted focus:outline-none focus:border-vox-accent-primary"
              />
              <input
                type="text"
                value={reasonInput}
                onChange={(e) => setReasonInput(e.target.value)}
                placeholder="Reason (optional)"
                className="w-full rounded-md bg-vox-bg-hover border border-vox-border text-sm text-vox-text-primary px-3 py-2 placeholder:text-vox-text-muted focus:outline-none focus:border-vox-accent-primary"
              />
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => { setShowAddIp(false); setIpInput(''); setReasonInput(''); }} className="px-4 py-2 text-sm rounded-md bg-vox-bg-hover text-vox-text-secondary">
                Cancel
              </button>
              <button
                onClick={async () => {
                  const trimmed = ipInput.trim();
                  if (!trimmed) return;
                  // Validate IPv4: 4 octets 0-255
                  const ipv4Re = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
                  const v4Match = trimmed.match(ipv4Re);
                  const isValidV4 = v4Match && v4Match.slice(1).every((o) => parseInt(o) <= 255);
                  // Validate IPv6: use browser URL parser as reliable check
                  let isValidV6 = false;
                  if (!isValidV4) {
                    try {
                      const url = new URL(`http://[${trimmed}]`);
                      isValidV6 = url.hostname === `[${trimmed}]`;
                    } catch { /* invalid */ }
                  }
                  if (!isValidV4 && !isValidV6) {
                    toast.error('Invalid IP address format');
                    return;
                  }
                  try {
                    await addIpBan(trimmed, reasonInput || undefined);
                    toast.success('IP banned');
                    setShowAddIp(false);
                    setIpInput('');
                    setReasonInput('');
                  } catch { toast.error('Failed to add IP ban'); }
                }}
                className="px-4 py-2 text-sm rounded-md bg-vox-accent-danger text-white hover:bg-red-600"
              >
                Ban IP
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Unban */}
      {confirmUnban && (
        <AdminConfirmModal
          title="Unban User"
          message={`Remove account ban from "${confirmUnban.username}"?`}
          confirmLabel="Unban"
          danger={false}
          onConfirm={async () => {
            try {
              await unbanUser(confirmUnban.id);
              toast.success('User unbanned');
              fetchBans();
              fetchIpBans();
            } catch { toast.error('Failed to unban user'); }
            setConfirmUnban(null);
          }}
          onCancel={() => setConfirmUnban(null)}
        />
      )}

      {/* Confirm Remove IP Ban */}
      {confirmRemoveIp && (
        <AdminConfirmModal
          title="Remove IP Ban"
          message={`Remove IP ban for ${confirmRemoveIp.ip}?`}
          confirmLabel="Remove"
          onConfirm={async () => {
            try {
              await removeIpBan(confirmRemoveIp.id);
              toast.success('IP ban removed');
            } catch { toast.error('Failed to remove IP ban'); }
            setConfirmRemoveIp(null);
          }}
          onCancel={() => setConfirmRemoveIp(null)}
        />
      )}
    </div>
  );
}
