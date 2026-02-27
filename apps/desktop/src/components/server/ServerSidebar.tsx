import { useState } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { useDMStore } from '../../stores/dmStore';
import { Plus, LogOut, Settings } from 'lucide-react';
import { clsx } from 'clsx';
import { CreateServerModal } from './CreateServerModal';
import { Avatar } from '../common/Avatar';
import { useSettingsStore } from '../../stores/settingsStore';
import { APP_VERSION } from '@voxium/shared';

export function ServerSidebar() {
  const { servers, activeServerId, setActiveServer, serverUnreadCounts } = useServerStore();
  const { logout, user } = useAuthStore();
  const totalDMUnread = useDMStore((s) => Object.values(s.dmUnreadCounts).reduce((sum, c) => sum + c, 0));
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);
  const [iconErrors, setIconErrors] = useState<Set<string>>(new Set());

  return (
    <>
      <div className="flex h-full w-[72px] flex-col items-center bg-vox-sidebar py-3 gap-2">
        {/* Voxium Home Button */}
        <button
          className={clsx(
            'group relative flex h-12 w-12 items-center justify-center rounded-2xl transition-all duration-200',
            !activeServerId
              ? 'rounded-xl bg-vox-accent-primary text-white'
              : 'bg-vox-bg-secondary text-vox-text-secondary hover:rounded-xl hover:bg-vox-accent-primary hover:text-white'
          )}
          onClick={() => {
            useServerStore.setState({ activeServerId: null });
            useDMStore.getState().clearActiveConversation();
          }}
        >
          <img src="/logo.svg" alt="Voxium" className="h-7 w-7" />
          {activeServerId && totalDMUnread > 0 && (
            <span className="absolute -bottom-1 -right-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-vox-accent-primary px-1 text-[10px] font-bold text-white ring-2 ring-vox-sidebar">
              {totalDMUnread > 99 ? '99+' : totalDMUnread}
            </span>
          )}
        </button>

        {/* Server List */}
        <div className="flex flex-1 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden scrollbar-none">
          {servers.map((server) => (
            <div key={server.id} className="relative flex w-full items-center justify-center">
              <button
                className={clsx(
                  'group flex h-12 w-12 items-center justify-center rounded-2xl transition-all duration-200',
                  activeServerId === server.id
                    ? 'rounded-xl bg-vox-accent-primary text-white border-l-[3px] border-white'
                    : hoveredId === server.id
                      ? 'bg-vox-bg-secondary text-vox-text-secondary hover:rounded-xl hover:bg-vox-accent-primary hover:text-white border-l-[3px] border-white/50'
                      : (serverUnreadCounts[server.id] || 0) > 0
                        ? 'bg-vox-bg-secondary text-vox-text-secondary hover:rounded-xl hover:bg-vox-accent-primary hover:text-white border-l-[3px] border-orange-500'
                        : 'bg-vox-bg-secondary text-vox-text-secondary hover:rounded-xl hover:bg-vox-accent-primary hover:text-white border-l-[3px] border-transparent'
                )}
                onClick={() => {
                  useDMStore.getState().clearActiveConversation();
                  setActiveServer(server.id);
                }}
                onMouseEnter={(e) => {
                  setHoveredId(server.id);
                  const rect = e.currentTarget.getBoundingClientRect();
                  setTooltipPos({ top: rect.top + rect.height / 2, left: rect.right + 8 });
                }}
                onMouseLeave={() => { setHoveredId(null); setTooltipPos(null); }}
              >
                {server.iconUrl && !iconErrors.has(server.id) ? (
                  <img
                    src={`${import.meta.env.VITE_API_URL || 'http://localhost:3001/api/v1'}/uploads/${server.iconUrl}`}
                    alt={server.name}
                    className="h-full w-full rounded-[inherit] object-cover"
                    onError={() => setIconErrors((prev) => new Set(prev).add(server.id))}
                  />
                ) : (
                  <span className="text-sm font-semibold">
                    {server.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
                  </span>
                )}
              </button>
              {activeServerId !== server.id && (serverUnreadCounts[server.id] || 0) > 0 && (
                <span className="absolute -bottom-1 -right-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-orange-500 px-1 text-[10px] font-bold text-white ring-2 ring-vox-sidebar">
                  {serverUnreadCounts[server.id] > 99 ? '99+' : serverUnreadCounts[server.id]}
                </span>
              )}
            </div>
          ))}

          {/* Add Server Button */}
          <button
            className="flex h-12 w-12 items-center justify-center rounded-2xl bg-vox-bg-secondary text-vox-accent-success
                       hover:rounded-xl hover:bg-vox-accent-success hover:text-white transition-all duration-200"
            onClick={() => setShowCreateModal(true)}
          >
            <Plus size={24} />
          </button>
        </div>

        {/* User section at bottom */}
        <div className="flex flex-col items-center gap-2 pt-2 border-t border-vox-border">
          <Avatar avatarUrl={user?.avatarUrl} displayName={user?.displayName} size="md" />
          <button
            className="flex h-8 w-8 items-center justify-center rounded-lg text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary transition-colors"
            onClick={() => useSettingsStore.getState().openSettings()}
            title="Settings"
          >
            <Settings size={16} />
          </button>
          <button
            className="flex h-8 w-8 items-center justify-center rounded-lg text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-accent-danger transition-colors"
            onClick={logout}
            title="Logout"
          >
            <LogOut size={16} />
          </button>
          <span className="text-[9px] text-vox-text-muted select-none">v{APP_VERSION}</span>
        </div>
      </div>

      {/* Server name tooltip — fixed position so it's never clipped by overflow */}
      {hoveredId && tooltipPos && (
        <div
          className="fixed z-50 rounded-md bg-vox-bg-floating px-3 py-1.5 text-sm font-medium text-vox-text-primary shadow-lg border border-vox-border pointer-events-none whitespace-nowrap"
          style={{ top: tooltipPos.top, left: tooltipPos.left, transform: 'translateY(-50%)' }}
        >
          {servers.find((s) => s.id === hoveredId)?.name}
        </div>
      )}

      {showCreateModal && <CreateServerModal onClose={() => setShowCreateModal(false)} />}
    </>
  );
}
