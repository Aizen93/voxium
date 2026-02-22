import { useState } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { Plus, LogOut, MessageCircle } from 'lucide-react';
import { clsx } from 'clsx';
import { CreateServerModal } from './CreateServerModal';

export function ServerSidebar() {
  const { servers, activeServerId, setActiveServer } = useServerStore();
  const { logout, user } = useAuthStore();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);

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
          onClick={() => useServerStore.setState({ activeServerId: null })}
        >
          <MessageCircle size={24} />
        </button>

        {/* Separator */}
        <div className="mx-auto h-0.5 w-8 rounded-full bg-vox-border" />

        {/* Server List */}
        <div className="flex flex-1 flex-col items-center gap-2 overflow-y-auto scrollbar-none">
          {servers.map((server) => (
            <button
              key={server.id}
              className={clsx(
                'group relative flex h-12 w-12 items-center justify-center rounded-2xl transition-all duration-200',
                activeServerId === server.id
                  ? 'rounded-xl bg-vox-accent-primary text-white'
                  : 'bg-vox-bg-secondary text-vox-text-secondary hover:rounded-xl hover:bg-vox-accent-primary hover:text-white'
              )}
              onClick={() => setActiveServer(server.id)}
              onMouseEnter={(e) => {
                setHoveredId(server.id);
                const rect = e.currentTarget.getBoundingClientRect();
                setTooltipPos({ top: rect.top + rect.height / 2, left: rect.right + 8 });
              }}
              onMouseLeave={() => { setHoveredId(null); setTooltipPos(null); }}
            >
              {server.iconUrl ? (
                <img src={server.iconUrl} alt={server.name} className="h-full w-full rounded-inherit object-cover" />
              ) : (
                <span className="text-sm font-semibold">
                  {server.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
                </span>
              )}

              {/* Active indicator */}
              {activeServerId === server.id && (
                <div className="absolute -left-1 top-1/2 h-10 w-1 -translate-y-1/2 rounded-r-full bg-white" />
              )}

              {/* Hover indicator */}
              {hoveredId === server.id && activeServerId !== server.id && (
                <div className="absolute -left-1 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-white transition-all" />
              )}

            </button>
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
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-vox-accent-primary text-xs font-bold text-white">
            {user?.displayName?.[0]?.toUpperCase() || '?'}
          </div>
          <button
            className="flex h-8 w-8 items-center justify-center rounded-lg text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-accent-danger transition-colors"
            onClick={logout}
            title="Logout"
          >
            <LogOut size={16} />
          </button>
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
