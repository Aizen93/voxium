import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';

interface ConnectionQualityProps {
  latency: number | null;
}

export function ConnectionQuality({ latency }: ConnectionQualityProps) {
  const { t } = useTranslation();
  let bars: number;
  let color: string;

  if (latency === null) {
    bars = 0;
    color = 'bg-vox-text-muted';
  } else if (latency < 100) {
    bars = 3;
    color = 'bg-vox-voice-connected';
  } else if (latency < 200) {
    bars = 2;
    color = 'bg-vox-accent-warning';
  } else {
    bars = 1;
    color = 'bg-vox-accent-danger';
  }

  return (
    <div className="flex items-end gap-[2px] h-3.5" title={latency !== null ? `${latency}ms` : t('voice.measuring')}>
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className={clsx(
            'w-[3px] rounded-sm transition-colors',
            i <= bars ? color : 'bg-vox-text-muted/30',
          )}
          style={{ height: `${4 + i * 3}px` }}
        />
      ))}
    </div>
  );
}
