import { Heart, Sparkles, Crown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SupporterTier } from '@voxium/shared';

interface Props {
  tier?: SupporterTier;
}

/**
 * Supporter badge with tier-based styling:
 * - null/undefined: Regular supporter (pink heart)
 * - 'first': First contributor/sponsor (animated golden sparkle)
 * - 'top': Biggest donator/sponsor (animated crown with glow)
 */
export function SupporterBadge({ tier }: Props) {
  if (tier === 'first') return <FirstSupporterBadge />;
  if (tier === 'top') return <TopSupporterBadge />;
  return <RegularSupporterBadge />;
}

function RegularSupporterBadge() {
  const { t } = useTranslation();

  return (
    <span
      className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] font-semibold bg-pink-500/20 text-pink-400"
      title={t('badges.supporter')}
    >
      <Heart size={10} />
      {t('badges.supporter')}
    </span>
  );
}

function FirstSupporterBadge() {
  const { t } = useTranslation();

  return (
    <>
      <style>{`
        @keyframes first-supporter-shimmer {
          0% { background-position: -200% center; }
          100% { background-position: 200% center; }
        }
        @keyframes first-supporter-sparkle {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.7; transform: scale(1.2); }
        }
        .first-supporter-badge {
          background: linear-gradient(90deg, #d97706, #fbbf24, #fde68a, #fbbf24, #d97706);
          background-size: 200% 100%;
          animation: first-supporter-shimmer 3s linear infinite;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        .first-supporter-icon {
          animation: first-supporter-sparkle 2s ease-in-out infinite;
          color: #fbbf24;
          filter: drop-shadow(0 0 3px rgba(251, 191, 36, 0.6));
        }
      `}</style>
      <span
        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/15 border border-amber-500/30"
        title={t('badges.firstSupporterTooltip')}
      >
        <Sparkles size={10} className="first-supporter-icon shrink-0" />
        <span className="first-supporter-badge">{t('badges.firstSupporter')}</span>
      </span>
    </>
  );
}

function TopSupporterBadge() {
  const { t } = useTranslation();

  return (
    <>
      <style>{`
        @keyframes top-supporter-glow {
          0%, 100% { filter: drop-shadow(0 0 4px rgba(168, 85, 247, 0.5)); }
          50% { filter: drop-shadow(0 0 8px rgba(168, 85, 247, 0.9)); }
        }
        @keyframes top-supporter-gradient {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        .top-supporter-badge {
          background: linear-gradient(270deg, #c084fc, #e879f9, #f0abfc, #e879f9, #c084fc);
          background-size: 300% 100%;
          animation: top-supporter-gradient 4s ease infinite;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        .top-supporter-icon {
          animation: top-supporter-glow 2s ease-in-out infinite;
          color: #c084fc;
        }
      `}</style>
      <span
        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-500/15 border border-purple-500/30"
        title={t('badges.topSupporterTooltip')}
      >
        <Crown size={10} className="top-supporter-icon shrink-0" />
        <span className="top-supporter-badge">{t('badges.topSupporter')}</span>
      </span>
    </>
  );
}
