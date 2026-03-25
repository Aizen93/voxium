import { useMemo } from 'react';
import { Info, AlertTriangle, Wrench, X } from 'lucide-react';
import { useAnnouncementStore } from '../../stores/announcementStore';
import { useServerStore } from '../../stores/serverStore';
import type { AnnouncementType } from '@voxium/shared';

const TYPE_CONFIG: Record<AnnouncementType, { icon: typeof Info; bg: string; text: string; border: string }> = {
  info: { icon: Info, bg: 'bg-vox-accent-primary/15', text: 'text-vox-accent-primary', border: 'border-vox-accent-primary/20' },
  warning: { icon: AlertTriangle, bg: 'bg-vox-accent-warning/15', text: 'text-vox-accent-warning', border: 'border-vox-accent-warning/20' },
  maintenance: { icon: Wrench, bg: 'bg-vox-accent-danger/15', text: 'text-vox-accent-danger', border: 'border-vox-accent-danger/20' },
};

export function AnnouncementBanner() {
  const announcements = useAnnouncementStore((s) => s.announcements);
  const dismissedIds = useAnnouncementStore((s) => s.dismissedIds);
  const dismiss = useAnnouncementStore((s) => s.dismissAnnouncement);
  const activeServerId = useServerStore((s) => s.activeServerId);

  const active = useMemo(() => {
    const now = new Date().toISOString();
    const dismissedSet = new Set(dismissedIds);
    return announcements.filter((a) => {
      if (dismissedSet.has(a.id)) return false;
      if (a.expiresAt && a.expiresAt <= now) return false;
      // Server-scoped: only show when viewing one of the targeted servers
      if (a.scope === 'servers') {
        if (!activeServerId || !a.serverIds.includes(activeServerId)) return false;
      }
      return true;
    });
  }, [announcements, dismissedIds, activeServerId]);

  if (active.length === 0) return null;

  const announcement = active[0];
  const config = TYPE_CONFIG[announcement.type as AnnouncementType] ?? TYPE_CONFIG.info;
  const Icon = config.icon;

  return (
    <div className={`relative flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-medium ${config.bg} ${config.text} border-b ${config.border}`}>
      <Icon size={14} className="shrink-0" />
      <span className="font-semibold">{announcement.title}</span>
      <span className="opacity-80 truncate">{announcement.content}</span>
      {active.length > 1 && (
        <span className="shrink-0 opacity-70">+{active.length - 1} more</span>
      )}
      <button
        onClick={() => dismiss(announcement.id)}
        className="absolute right-2 shrink-0 p-0.5 rounded hover:bg-white/10"
        aria-label="Dismiss announcement"
      >
        <X size={12} />
      </button>
    </div>
  );
}
