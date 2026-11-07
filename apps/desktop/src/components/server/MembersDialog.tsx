import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Users } from 'lucide-react';
import { useServerStore } from '../../stores/serverStore';
import { MembersDirectory } from './MembersDirectory';

/**
 * The People panel's way to every member of a big server, for EVERY member:
 * the same server-paged directory as Server settings → Members, in a plain
 * dialog of its own. Server settings is the administration surface (its
 * moderation sections, the other tabs); a regular member must never be sent
 * there just to browse. Row actions inside the directory stay gated by the
 * viewer's role, exactly as in the settings tab.
 */
export function MembersDialog({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const memberCount = useServerStore((s) => s.people.memberCount);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label={t('people.directoryTitle')}
      onClick={onClose}
      data-testid="members-dialog"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-vox-border bg-vox-bg-secondary shadow-2xl animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-vox-border px-6 py-4">
          <h2 className="flex items-center gap-2 text-lg font-bold text-vox-text-primary">
            <Users size={18} className="text-vox-accent-primary" />
            {t('people.directoryTitle')}
            <span className="font-mono text-[12px] font-normal text-vox-text-muted">{memberCount}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-vox-text-muted hover:text-vox-text-primary transition-colors"
            aria-label={t('common.close')}
          >
            <X size={20} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          <MembersDirectory serverId={serverId} />
        </div>
      </div>
    </div>
  );
}
