import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getConnectionStatus, onConnectionStatusChange } from '../../services/socket';
import { WifiOff, Loader2 } from 'lucide-react';

export function ConnectionBanner() {
  const { t } = useTranslation();
  const [status, setStatus] = useState(getConnectionStatus);

  useEffect(() => {
    const unsub = onConnectionStatusChange(setStatus);
    // Re-sync after subscribing to catch any status change that fired
    // between the initial useState read and this effect running
    setStatus(getConnectionStatus());
    return unsub;
  }, []);

  if (status === 'connected') return null;

  return (
    <div className="flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-medium bg-vox-accent-warning/15 text-vox-accent-warning border-b border-vox-accent-warning/20">
      {status === 'connecting' ? (
        <>
          <Loader2 size={14} className="animate-spin" />
          <span>{t('connection.reconnecting')}</span>
        </>
      ) : (
        <>
          <WifiOff size={14} />
          <span>{t('connection.lost')}</span>
        </>
      )}
    </div>
  );
}
