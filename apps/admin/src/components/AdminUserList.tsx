import { useEffect, useState, useCallback } from 'react';
import { Search, Ban, Trash2 } from 'lucide-react';
import { useAdminStore } from '../stores/adminStore';
import { AdminTable } from './AdminTable';
import { AdminConfirmModal } from './AdminConfirmModal';
import { toast } from '../stores/toastStore';

interface ConfirmAction {
  type: 'ban' | 'delete';
  userId: string;
  username: string;
}

export function AdminUserList({ onSelectUser }: { onSelectUser: (userId: string) => void }) {
  const { users, usersTotal, usersPage, usersSearch, usersFilter, usersSort, loading, fetchUsers, setUsersSearch, setUsersFilter, setUsersSort, banUser, deleteUser } = useAdminStore();
  const [searchInput, setSearchInput] = useState(usersSearch);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  useEffect(() => {
    fetchUsers(1);
  }, [fetchUsers, usersFilter, usersSort]);

  const handleSearch = useCallback(() => {
    setUsersSearch(searchInput);
    fetchUsers(1);
  }, [searchInput, setUsersSearch, fetchUsers]);

  const columns = [
    { key: 'username', label: 'Username' },
    { key: 'email', label: 'Email' },
    { key: 'role', label: 'Role', width: '100px' },
    { key: 'status', label: 'Status', width: '100px' },
    { key: 'created', label: 'Joined', width: '120px' },
    { key: 'actions', label: '', width: '100px' },
  ];

  const rows = users.map((user) => ({
    username: (
      <div className="flex items-center gap-2">
        <span className="text-vox-text-primary font-medium">{user.username}</span>
        {user.bannedAt && <span className="text-[10px] px-1.5 py-0.5 rounded bg-vox-accent-danger/20 text-vox-accent-danger">BANNED</span>}
      </div>
    ),
    email: user.email,
    role: (
      <span className={`text-xs px-2 py-0.5 rounded ${
        user.role === 'superadmin' ? 'bg-yellow-500/20 text-yellow-400' :
        user.role === 'admin' ? 'bg-vox-accent-primary/20 text-vox-accent-primary' :
        'bg-vox-bg-hover text-vox-text-muted'
      }`}>
        {user.role}
      </span>
    ),
    status: (
      <span className={`h-2 w-2 rounded-full inline-block mr-1 ${user.status === 'online' ? 'bg-green-400' : 'bg-gray-500'}`} />
    ),
    created: new Date(user.createdAt).toLocaleDateString(),
    actions: (
      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        {!user.bannedAt && user.role !== 'superadmin' && (
          <button
            onClick={() => setConfirmAction({ type: 'ban', userId: user.id, username: user.username })}
            className="p-1 rounded text-vox-text-muted hover:text-vox-accent-warning"
            title="Ban user"
          >
            <Ban size={14} />
          </button>
        )}
        {user.role !== 'superadmin' && (
          <button
            onClick={() => setConfirmAction({ type: 'delete', userId: user.id, username: user.username })}
            className="p-1 rounded text-vox-text-muted hover:text-vox-accent-danger"
            title="Delete user"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    ),
  }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-vox-text-primary">Users</h2>
        <div className="flex items-center gap-2">
          <select
            value={usersFilter}
            onChange={(e) => setUsersFilter(e.target.value)}
            className="text-xs rounded-md bg-vox-bg-hover border border-vox-border text-vox-text-secondary px-2 py-1.5"
          >
            <option value="all">All</option>
            <option value="banned">Banned</option>
            <option value="admin">Admins</option>
            <option value="online">Online</option>
          </select>
          <select
            value={usersSort}
            onChange={(e) => setUsersSort(e.target.value)}
            className="text-xs rounded-md bg-vox-bg-hover border border-vox-border text-vox-text-secondary px-2 py-1.5"
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="username">Username</option>
          </select>
        </div>
      </div>

      {/* Search */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-vox-text-muted" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Search users by name, email..."
            className="w-full rounded-md bg-vox-bg-hover border border-vox-border text-sm text-vox-text-primary pl-9 pr-3 py-2 placeholder:text-vox-text-muted focus:outline-none focus:border-vox-accent-primary"
          />
        </div>
        <button
          onClick={handleSearch}
          className="px-4 py-2 text-sm rounded-md bg-vox-accent-primary text-white hover:bg-vox-accent-hover transition-colors"
        >
          Search
        </button>
      </div>

      {/* Table */}
      <div className="rounded-lg bg-vox-bg-secondary border border-vox-border overflow-hidden">
        <AdminTable
          columns={columns}
          rows={rows}
          page={usersPage}
          total={usersTotal}
          onPageChange={(p) => fetchUsers(p)}
          onRowClick={(i) => onSelectUser(users[i].id)}
        />
      </div>

      {loading && (
        <div className="flex justify-center py-4">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-vox-accent-primary border-t-transparent" />
        </div>
      )}

      {/* Confirm Modal */}
      {confirmAction && (
        <AdminConfirmModal
          title={confirmAction.type === 'ban' ? 'Ban User' : 'Delete User'}
          message={`Are you sure you want to ${confirmAction.type} "${confirmAction.username}"? ${confirmAction.type === 'delete' ? 'This action cannot be undone.' : 'They will be disconnected immediately.'}`}
          confirmLabel={confirmAction.type === 'ban' ? 'Ban' : 'Delete'}
          onConfirm={async () => {
            try {
              if (confirmAction.type === 'ban') await banUser(confirmAction.userId);
              else await deleteUser(confirmAction.userId);
              toast.success(`User ${confirmAction.type === 'ban' ? 'banned' : 'deleted'}`);
            } catch {
              toast.error(`Failed to ${confirmAction.type} user`);
            }
            setConfirmAction(null);
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </div>
  );
}
