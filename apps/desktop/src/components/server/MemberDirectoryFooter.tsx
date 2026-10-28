import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { MemberDirectory } from '../../hooks/useMemberDirectory';

/**
 * The end of a member picker's list: how many of the directory are shown,
 * and the next page, loaded as the end scrolls into view (an observer on a
 * sentinel) or on the button, which stays for keyboards, for tests and for
 * the environments without an observer. Nothing while the directory has not
 * answered (the caller is showing its own rows then).
 */
export function MemberDirectoryFooter({ directory, shown }: { directory: MemberDirectory; shown: number }) {
  const { t } = useTranslation();
  const { rows, total, hasMore, loading, loadMore } = directory;
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loading, loadMore, shown]);

  if (!rows) return null;

  return (
    <div className="flex flex-col items-center gap-1.5 px-3 py-2" data-testid="member-directory-footer">
      {total !== null && (
        <span className="text-[11px] text-vox-text-muted" data-testid="member-directory-count">
          {t('secureChannel.directoryCount', { shown, total })}
        </span>
      )}
      {hasMore && (
        <>
          <div ref={sentinelRef} aria-hidden className="h-px w-full" />
          <button
            type="button"
            onClick={loadMore}
            disabled={loading}
            className="rounded-md border border-vox-border px-3 py-1 text-xs text-vox-text-secondary transition-colors hover:border-vox-border-strong hover:text-vox-text-primary disabled:opacity-60"
            data-testid="member-directory-more"
          >
            {loading ? t('common.loading') : t('secureChannel.loadMore')}
          </button>
        </>
      )}
    </div>
  );
}
