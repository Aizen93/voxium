import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { clsx } from 'clsx';
import { isMacPlatform } from '../../utils/platform';

/**
 * The message search as a field in a chat header: a button that looks like an
 * input and opens the SearchModal of the space or conversation it sits in.
 *
 * The search is scoped (one space, one conversation), so it lives where that
 * context is shown, in the header, not in the sidebar column where it read as
 * a search of everything. Ctrl/⌘K opens the same modal from anywhere.
 */
export function SearchField({
  onOpen,
  label,
  className,
}: {
  onOpen: () => void;
  /** The accessible name: what this search covers ("Search Messages (Ctrl+K)"). */
  label: string;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onOpen}
      title={label}
      aria-label={label}
      data-testid="search-field"
      className={clsx(
        'flex h-[32px] w-[220px] min-w-0 flex-none items-center gap-2 rounded-lg border border-vox-border bg-vox-bg-tertiary px-2.5 text-vox-text-muted transition-colors hover:border-vox-border-strong hover:text-vox-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vox-accent-primary',
        className
      )}
    >
      <Search size={14} className="shrink-0" />
      <span className="truncate text-[13px]">{t('search.placeholder')}</span>
      <kbd className="ml-auto shrink-0 rounded-sm bg-vox-bg-hover px-1.5 py-0.5 font-mono text-[10px] text-vox-text-muted/80">
        {isMacPlatform() ? '⌘K' : `${t('common.ctrlKey')} K`}
      </kbd>
    </button>
  );
}
