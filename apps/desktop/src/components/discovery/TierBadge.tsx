import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { DISCOVERY_TIER_TOP_FRACTION } from '@voxium/shared';
import type { DiscoveryTier } from '@voxium/shared';

/**
 * The activity badge of a listed space: a heraldic crest in the metal of its
 * tier (Bronze … Diamond), a bolt for activity, and one to five stars for the
 * rank — the language of ranked ladders, because that is what it is: a rank
 * among listed spaces by the same score the Active sort uses, nothing else.
 * Pure SVG: gradients for the metal, a gloss, a rim, and a shine that sweeps
 * on hover (CSS, off under reduced motion).
 */

interface Palette {
  light: string; mid: string; dark: string;
  rimLight: string; rimDark: string;
  glow: string;
  stars: number;
}

const PALETTE: Record<DiscoveryTier, Palette> = {
  bronze:   { light: '#f6c08c', mid: '#c9722f', dark: '#6b3812', rimLight: '#ffe1c2', rimDark: '#3e1f08', glow: 'rgba(201, 114, 47, 0.45)', stars: 1 },
  silver:   { light: '#ffffff', mid: '#bcc4d0', dark: '#6b7482', rimLight: '#ffffff', rimDark: '#39404b', glow: 'rgba(188, 196, 208, 0.45)', stars: 2 },
  gold:     { light: '#fff3b0', mid: '#f3b940', dark: '#9a6a06', rimLight: '#fff9d6', rimDark: '#5a3c02', glow: 'rgba(243, 185, 64, 0.5)',  stars: 3 },
  platinum: { light: '#dafffb', mid: '#5fd0c8', dark: '#1d6f6b', rimLight: '#f0fffd', rimDark: '#0d3d3a', glow: 'rgba(95, 208, 200, 0.5)',  stars: 4 },
  diamond:  { light: '#eef1ff', mid: '#8b97ff', dark: '#3240c7', rimLight: '#ffffff', rimDark: '#1a2170', glow: 'rgba(139, 151, 255, 0.55)', stars: 5 },
};

// A heraldic shield (outer rim, inner body) in a 64 × 72 box
const OUTER = 'M32 2 L58 12 V34 C58 52 46 64 32 70 C18 64 6 52 6 34 V12 Z';
const INNER = 'M32 7 L53 15.5 V34 C53 49 43 59 32 64.5 C21 59 11 49 11 34 V15.5 Z';
// A bolt: activity
const BOLT = 'M35 11 L22 32 H31 L28 46 L42 24 H33 Z';
// A five-point star around the origin, radius 10
const STAR = 'M0 -10 L2.9 -3.1 L10 -3.1 L4.3 1.3 L6.2 8.1 L0 4 L-6.2 8.1 L-4.3 1.3 L-10 -3.1 L-2.9 -3.1 Z';

export function tierPercent(tier: DiscoveryTier): number {
  return Math.round(DISCOVERY_TIER_TOP_FRACTION[tier] * 100);
}

interface Props {
  tier: DiscoveryTier;
  /** Width in px; the crest is 9/8 as tall. */
  size?: number;
  className?: string;
}

export function TierBadge({ tier, size = 22, className = '' }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const p = PALETTE[tier];
  const label = t('discovery.tier.badgeLabel', { tier: t(`discovery.tier.${tier}`), percent: tierPercent(tier) });
  const g = (name: string) => `${id}-${name}`;
  const starsAt = Array.from({ length: p.stars }, (_, i) => 32 + (i - (p.stars - 1) / 2) * 9);

  return (
    <span
      className={`vox-tier-badge inline-flex shrink-0 align-middle ${className}`}
      title={label}
      style={{ filter: `drop-shadow(0 0 ${Math.max(2, Math.round(size / 6))}px ${p.glow})` }}
      data-testid="discovery-tier"
      data-tier={tier}
    >
      <svg width={size} height={Math.round(size * 1.125)} viewBox="0 0 64 72" role="img" aria-label={label}>
        <defs>
          <linearGradient id={g('body')} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={p.light} />
            <stop offset="0.55" stopColor={p.mid} />
            <stop offset="1" stopColor={p.dark} />
          </linearGradient>
          <linearGradient id={g('rim')} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={p.rimLight} />
            <stop offset="1" stopColor={p.rimDark} />
          </linearGradient>
          <linearGradient id={g('gloss')} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.6" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <clipPath id={g('clip')}>
            <path d={INNER} />
          </clipPath>
        </defs>
        <path d={OUTER} fill={`url(#${g('rim')})`} />
        <path d={INNER} fill={`url(#${g('body')})`} />
        <path d={INNER} fill="none" stroke={p.rimDark} strokeOpacity="0.35" strokeWidth="1" />
        <ellipse cx="30" cy="17" rx="20" ry="11" fill={`url(#${g('gloss')})`} clipPath={`url(#${g('clip')})`} />
        <path d={BOLT} fill="#ffffff" fillOpacity="0.95" stroke={p.rimDark} strokeOpacity="0.55" strokeWidth="1" strokeLinejoin="round" />
        {starsAt.map((x, i) => (
          <path
            key={i}
            d={STAR}
            transform={`translate(${x} 55) scale(0.42)`}
            fill={p.rimLight}
            stroke={p.rimDark}
            strokeOpacity="0.5"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        ))}
        <rect className="vox-tier-shine" x="-40" y="0" width="26" height="72" fill="#ffffff" fillOpacity="0.4" clipPath={`url(#${g('clip')})`} />
      </svg>
    </span>
  );
}
