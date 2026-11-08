import { useTranslation } from 'react-i18next';

/**
 * The header line of the share stage. The sharer's own line is red with a
 * pulsing recording dot: on Windows the app hides WebView2's own share bar
 * (src-tauri/src/share_bar.rs), so this line is the one indicator that the
 * screen is leaving the machine. A viewer's line stays neutral.
 */
export function ShareStatusLabel({ isLocalSharing, sharerName }: { isLocalSharing: boolean; sharerName: string }) {
  const { t } = useTranslation();
  if (!isLocalSharing) {
    return <span className="text-sm text-vox-text-primary">{t('voice.userIsSharing', { name: sharerName })}</span>;
  }
  return (
    <span className="flex items-center gap-2 text-sm font-semibold text-vox-accent-danger" role="status" data-testid="sharing-indicator">
      <span aria-hidden="true" className="relative flex h-2.5 w-2.5" data-testid="sharing-indicator-dot">
        <span className="absolute inline-flex h-full w-full rounded-full bg-vox-accent-danger opacity-75 motion-safe:animate-ping" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-vox-accent-danger" />
      </span>
      {t('voice.youAreSharing')}
    </span>
  );
}
