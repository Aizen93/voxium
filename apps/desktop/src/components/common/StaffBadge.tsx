import { Shield } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function StaffBadge() {
  const { t } = useTranslation();

  return (
    <span
      className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] font-semibold bg-vox-accent-primary/20 text-vox-accent-primary"
      title={t('badges.staff')}
    >
      <Shield size={10} />
      {t('badges.staff')}
    </span>
  );
}
