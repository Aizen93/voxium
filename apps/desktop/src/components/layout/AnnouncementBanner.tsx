import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Info, AlertTriangle, Wrench, X, FileText } from 'lucide-react';
import { useAnnouncementStore } from '../../stores/announcementStore';
import { useServerStore } from '../../stores/serverStore';
import { LegalDocModal, legalDocTitle, type LegalDoc } from '../legal/LegalDocModal';
import { isAnnouncementLegalDoc } from '@voxium/shared';
import type { Announcement, AnnouncementType } from '@voxium/shared';

const TYPE_CONFIG: Record<AnnouncementType, { icon: typeof Info; bg: string; text: string; border: string }> = {
  info: { icon: Info, bg: 'bg-vox-accent-primary/15', text: 'text-vox-accent-primary', border: 'border-vox-accent-primary/20' },
  warning: { icon: AlertTriangle, bg: 'bg-vox-accent-warning/15', text: 'text-vox-accent-warning', border: 'border-vox-accent-warning/20' },
  maintenance: { icon: Wrench, bg: 'bg-vox-accent-danger/15', text: 'text-vox-accent-danger', border: 'border-vox-accent-danger/20' },
};

/** setTimeout refuses delays above this (it fires at once). */
const MAX_TIMER_MS = 2_147_483_647;

/** The document an announcement names, or null: an older server sends none, a newer one may send a name this build does not know. */
function legalDocOf(announcement: Announcement): LegalDoc | null {
  return isAnnouncementLegalDoc(announcement.legalDoc) ? announcement.legalDoc : null;
}

interface DialogProps {
  announcement: Announcement;
  /** The element that opened the dialog: it gets the focus back on close. */
  opener: HTMLElement | null;
  onClose: () => void;
}

/**
 * An announcement in full. Plain text only: the title and the content are
 * rendered as text nodes (line breaks kept), never as markdown or markup and
 * never turned into links.
 */
function AnnouncementDialog({ announcement, opener, onClose }: DialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [openDoc, setOpenDoc] = useState<LegalDoc | null>(null);
  const docButtonRef = useRef<HTMLButtonElement>(null);
  const config = TYPE_CONFIG[announcement.type as AnnouncementType] ?? TYPE_CONFIG.info;
  const Icon = config.icon;
  const legalDoc = legalDocOf(announcement);

  // Focus moves in on open and goes back to the opener on close.
  useEffect(() => {
    closeRef.current?.focus();
    return () => { opener?.focus(); };
  }, [opener]);

  // While the document is open on top, its own Escape closes it and leaves this dialog alone.
  useEffect(() => {
    if (openDoc) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openDoc, onClose]);

  const closeDoc = () => {
    setOpenDoc(null);
    docButtonRef.current?.focus();
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 motion-safe:animate-fade-in"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="announcement-dialog"
      >
        <div className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-2xl border border-vox-border bg-vox-bg-secondary shadow-2xl motion-safe:animate-slide-up">
          <div className="flex items-start gap-3 border-b border-vox-border px-5 py-4">
            <Icon size={18} className={`mt-0.5 shrink-0 ${config.text}`} aria-hidden="true" />
            <h2 id={titleId} className="min-w-0 flex-1 break-words text-base font-semibold text-vox-text-primary">
              {announcement.title}
            </h2>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              className="shrink-0 text-vox-text-muted hover:text-vox-text-primary transition-colors"
              aria-label={t('common.close')}
            >
              <X size={20} />
            </button>
          </div>
          <div className="overflow-y-auto px-5 py-4">
            <p className="whitespace-pre-wrap break-words text-sm text-vox-text-primary" data-testid="announcement-content">
              {announcement.content}
            </p>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-vox-border px-5 py-3">
            {legalDoc ? (
              <button
                ref={docButtonRef}
                type="button"
                onClick={() => setOpenDoc(legalDoc)}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-vox-accent-primary hover:underline"
              >
                <FileText size={14} aria-hidden="true" />
                {t('notifications.announcementOpenDocument', { document: legalDocTitle(t, legalDoc) })}
              </button>
            ) : <span />}
            <button type="button" onClick={onClose} className="btn-primary px-4 py-2 text-sm">
              {t('common.close')}
            </button>
          </div>
        </div>
      </div>
      {openDoc && createPortal(<LegalDocModal doc={openDoc} onClose={closeDoc} />, document.body)}
    </>
  );
}

export function AnnouncementBanner() {
  const { t } = useTranslation();
  const announcements = useAnnouncementStore((s) => s.announcements);
  const dismissedIds = useAnnouncementStore((s) => s.dismissedIds);
  const dismiss = useAnnouncementStore((s) => s.dismissAnnouncement);
  const activeServerId = useServerStore((s) => s.activeServerId);
  // Bumped when the soonest expiry passes, so an announcement leaves on time.
  const [expiryTick, setExpiryTick] = useState(0);
  const [reading, setReading] = useState<{ id: string; opener: HTMLElement | null } | null>(null);
  const [lineDoc, setLineDoc] = useState<LegalDoc | null>(null);
  const lineDocButtonRef = useRef<HTMLButtonElement>(null);

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
    // expiryTick is not read: it only makes the filter run again once an expiry has passed.
  }, [announcements, dismissedIds, activeServerId, expiryTick]);

  useEffect(() => {
    const now = Date.now();
    let soonest = Infinity;
    for (const a of active) {
      if (!a.expiresAt) continue;
      const at = new Date(a.expiresAt).getTime();
      if (Number.isFinite(at) && at > now && at < soonest) soonest = at;
    }
    if (soonest === Infinity) return undefined;
    const timer = setTimeout(() => setExpiryTick((n) => n + 1), Math.min(soonest - now + 50, MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [active]);

  if (active.length === 0) return null;

  const announcement = active[0];
  const config = TYPE_CONFIG[announcement.type as AnnouncementType] ?? TYPE_CONFIG.info;
  const Icon = config.icon;
  const legalDoc = legalDocOf(announcement);
  // The dialog shows the announcement it was opened for, for as long as it is still active.
  const reader = reading ? active.find((a) => a.id === reading.id) : undefined;

  return (
    <div className={`relative flex items-center justify-center gap-2 px-3 py-1.5 pr-8 text-xs font-medium ${config.bg} ${config.text} border-b ${config.border}`}>
      <Icon size={14} className="shrink-0" />
      <span className="font-semibold">{announcement.title}</span>
      <span className="opacity-80 truncate">{announcement.content}</span>
      <button
        type="button"
        onClick={(e) => setReading({ id: announcement.id, opener: e.currentTarget })}
        className="shrink-0 rounded px-1.5 py-0.5 font-semibold underline underline-offset-2 hover:bg-white/10"
      >
        {t('notifications.announcementRead')}
      </button>
      {legalDoc && (
        <button
          ref={lineDocButtonRef}
          type="button"
          onClick={() => setLineDoc(legalDoc)}
          className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-semibold underline underline-offset-2 hover:bg-white/10"
        >
          <FileText size={12} aria-hidden="true" />
          {t('notifications.announcementOpenDocument', { document: legalDocTitle(t, legalDoc) })}
        </button>
      )}
      {active.length > 1 && (
        <span className="shrink-0 opacity-70">{t('notifications.announcementMore', { n: active.length - 1 })}</span>
      )}
      <button
        onClick={() => dismiss(announcement.id)}
        className="absolute right-2 shrink-0 p-0.5 rounded hover:bg-white/10"
        aria-label={t('notifications.dismissAnnouncement')}
      >
        <X size={12} />
      </button>
      {reader && reading && createPortal(
        <AnnouncementDialog announcement={reader} opener={reading.opener} onClose={() => setReading(null)} />,
        document.body,
      )}
      {lineDoc && createPortal(
        <LegalDocModal
          doc={lineDoc}
          onClose={() => { setLineDoc(null); lineDocButtonRef.current?.focus(); }}
        />,
        document.body,
      )}
    </div>
  );
}
