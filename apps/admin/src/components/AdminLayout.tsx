import { useState } from 'react';
import { LayoutDashboard, Users, Server, ShieldBan, HardDrive, LogOut } from 'lucide-react';
import { clsx } from 'clsx';
import { useAuthStore } from '../stores/authStore';
import { useAdminStore } from '../stores/adminStore';
import { AdminDashboard } from './AdminDashboard';
import { AdminUserList } from './AdminUserList';
import { AdminUserDetail } from './AdminUserDetail';
import { AdminServerList } from './AdminServerList';
import { AdminBanList } from './AdminBanList';
import { AdminStorage } from './AdminStorage';

type AdminView = 'dashboard' | 'users' | 'servers' | 'bans' | 'storage';

const NAV_ITEMS: Array<{ id: AdminView; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'users', label: 'Users', icon: Users },
  { id: 'servers', label: 'Servers', icon: Server },
  { id: 'bans', label: 'Bans', icon: ShieldBan },
  { id: 'storage', label: 'Storage', icon: HardDrive },
];

export function AdminLayout() {
  const logout = useAuthStore((s) => s.logout);
  const [view, setView] = useState<AdminView>('dashboard');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const handleSelectUser = (userId: string) => {
    setSelectedUserId(userId);
  };

  const renderContent = () => {
    if (view === 'users' && selectedUserId) {
      return <AdminUserDetail userId={selectedUserId} onBack={() => { useAdminStore.getState().clearSelectedUser(); setSelectedUserId(null); }} />;
    }

    switch (view) {
      case 'dashboard':
        return <AdminDashboard />;
      case 'users':
        return <AdminUserList onSelectUser={handleSelectUser} />;
      case 'servers':
        return <AdminServerList />;
      case 'bans':
        return <AdminBanList />;
      case 'storage':
        return <AdminStorage />;
    }
  };

  return (
    <div className="flex h-full bg-vox-bg-primary">
      {/* Sidebar */}
      <div className="w-56 flex flex-col bg-vox-sidebar border-r border-vox-border">
        <div className="p-4 border-b border-vox-border">
          <h1 className="text-lg font-bold text-vox-text-primary">Admin Panel</h1>
          <p className="text-xs text-vox-text-muted">Super Admin Dashboard</p>
        </div>

        <nav className="flex-1 p-2 space-y-1">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              onClick={() => { setView(item.id); setSelectedUserId(null); }}
              className={clsx(
                'w-full flex items-center gap-3 px-3 py-2 text-sm rounded-md transition-colors',
                view === item.id
                  ? 'bg-vox-accent-primary/20 text-vox-accent-primary'
                  : 'text-vox-text-secondary hover:bg-vox-bg-hover hover:text-vox-text-primary'
              )}
            >
              <item.icon size={16} />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="p-2 border-t border-vox-border">
          <button
            onClick={logout}
            className="w-full flex items-center gap-3 px-3 py-2 text-sm rounded-md text-vox-text-secondary hover:bg-vox-bg-hover hover:text-vox-accent-danger transition-colors"
          >
            <LogOut size={16} />
            Logout
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {renderContent()}
      </div>
    </div>
  );
}
