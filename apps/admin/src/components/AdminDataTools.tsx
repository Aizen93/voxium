import { useState } from 'react';
import { Users, Server, ShieldBan, ShieldX, Download, Loader2 } from 'lucide-react';
import { useAdminStore } from '../stores/adminStore';
import { toast } from '../stores/toastStore';

// ─── CSV Utilities ──────────────────────────────────────────────────────────

interface CsvColumn {
  key: string;
  label: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function generateCSV(rows: any[], columns: CsvColumn[]): string {
  const escape = (val: unknown): string => {
    const str = val == null ? '' : String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const header = columns.map((c) => escape(c.label)).join(',');
  const body = rows.map((row) => columns.map((c) => escape(row[c.key])).join(',')).join('\r\n');
  return `${header}\r\n${body}`;
}

function downloadCSV(csv: string, type: string): void {
  const date = new Date().toISOString().slice(0, 10);
  const filename = `voxium_${type}_${date}.csv`;
  const bom = '\uFEFF';
  const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Export Card Definitions ────────────────────────────────────────────────

interface ExportCardDef {
  id: string;
  title: string;
  description: string;
  icon: typeof Users;
  columns: CsvColumn[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetch: () => Promise<any[]>;
}

const EXPORT_CARDS: ExportCardDef[] = [
  {
    id: 'users',
    title: 'Users',
    description: 'Export all user accounts',
    icon: Users,
    columns: [
      { key: 'id', label: 'ID' },
      { key: 'username', label: 'Username' },
      { key: 'displayName', label: 'Display Name' },
      { key: 'email', label: 'Email' },
      { key: 'role', label: 'Role' },
      { key: 'status', label: 'Status' },
      { key: 'bannedAt', label: 'Banned' },
      { key: 'banReason', label: 'Ban Reason' },
      { key: 'createdAt', label: 'Created At' },
    ],
    fetch: () => useAdminStore.getState().exportUsers(),
  },
  {
    id: 'servers',
    title: 'Servers',
    description: 'Export all servers',
    icon: Server,
    columns: [
      { key: 'id', label: 'ID' },
      { key: 'name', label: 'Name' },
      { key: 'ownerUsername', label: 'Owner' },
      { key: 'memberCount', label: 'Members' },
      { key: 'channelCount', label: 'Channels' },
      { key: 'messageCount', label: 'Messages' },
      { key: 'createdAt', label: 'Created At' },
    ],
    fetch: () => useAdminStore.getState().exportServers(),
  },
  {
    id: 'bans',
    title: 'Account Bans',
    description: 'Export banned users',
    icon: ShieldBan,
    columns: [
      { key: 'id', label: 'ID' },
      { key: 'username', label: 'Username' },
      { key: 'displayName', label: 'Display Name' },
      { key: 'email', label: 'Email' },
      { key: 'bannedAt', label: 'Banned At' },
      { key: 'banReason', label: 'Ban Reason' },
    ],
    fetch: () => useAdminStore.getState().exportBans(),
  },
  {
    id: 'ip-bans',
    title: 'IP Bans',
    description: 'Export IP bans',
    icon: ShieldX,
    columns: [
      { key: 'id', label: 'ID' },
      { key: 'ip', label: 'IP' },
      { key: 'reason', label: 'Reason' },
      { key: 'bannedByUsername', label: 'Banned By' },
      { key: 'createdAt', label: 'Created At' },
    ],
    fetch: () => useAdminStore.getState().exportIpBans(),
  },
];

// ─── Component ──────────────────────────────────────────────────────────────

export function AdminDataTools() {
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const handleExport = async (card: ExportCardDef) => {
    setLoadingId(card.id);
    try {
      const rows = await card.fetch();
      const csv = generateCSV(rows, card.columns);
      downloadCSV(csv, card.id);
      toast.success(`Exported ${rows.length} ${card.title.toLowerCase()}`);
    } catch {
      toast.error(`Failed to export ${card.title.toLowerCase()}`);
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div>
      <h2 className="text-2xl font-bold text-vox-text-primary mb-6">Data Tools</h2>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {EXPORT_CARDS.map((card) => {
          const Icon = card.icon;
          const isLoading = loadingId === card.id;

          return (
            <div
              key={card.id}
              className="bg-vox-bg-secondary border border-vox-border rounded-lg p-5 flex flex-col gap-3"
            >
              <div className="flex items-center gap-3">
                <div className="p-2 bg-vox-accent-primary/10 rounded-lg">
                  <Icon size={20} className="text-vox-accent-primary" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-vox-text-primary">{card.title}</h3>
                  <p className="text-xs text-vox-text-muted">{card.description}</p>
                </div>
              </div>

              <button
                onClick={() => handleExport(card)}
                disabled={isLoading}
                className="mt-auto flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-vox-accent-primary text-white hover:bg-vox-accent-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isLoading ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Download size={16} />
                )}
                {isLoading ? 'Exporting...' : 'Export CSV'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
