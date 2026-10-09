import { useState, useEffect } from 'react';
import { clsx } from 'clsx';
import type { UserStatus } from '@voxium/shared';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001/api/v1';

const SIZES = {
  xs: 'h-5 w-5 text-[9px]',
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-20 w-20 text-2xl',
} as const;

// v2: squared avatars — radius ≈ one third of the box, per the redesign
const SHAPES: Record<keyof typeof SIZES, string> = {
  xs: 'rounded-[6px]',
  sm: 'rounded-[10px]',
  md: 'rounded-xl',
  lg: 'rounded-2xl',
};

/* Per-user identity colors for the initials fallback (dusty, low-chroma set
 * from the redesign). Deliberately NOT theme tokens: they are identity, not
 * chrome, and must not all collapse into the single accent. */
const IDENTITY_COLORS = [
  '#8d7ba8', '#7b93a8', '#a8917b', '#a87b7b', '#7ba88d', '#86a1b5', '#b59a86', '#9a8db5',
] as const;

function identityColor(name: string | undefined): string {
  if (!name) return IDENTITY_COLORS[0];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return IDENTITY_COLORS[Math.abs(hash) % IDENTITY_COLORS.length];
}

const STATUS_DOT_SIZES: Record<keyof typeof SIZES, string> = {
  xs: 'h-2 w-2 border',
  sm: 'h-2.5 w-2.5 border-[1.5px]',
  md: 'h-3 w-3 border-2',
  lg: 'h-5 w-5 border-2',
};

const STATUS_COLORS: Record<UserStatus, string> = {
  online: 'bg-green-500',
  idle: 'bg-amber-400',
  dnd: 'bg-red-500',
  offline: 'bg-gray-500',
};

interface AvatarProps {
  avatarUrl?: string | null;
  displayName?: string;
  size?: keyof typeof SIZES;
  speaking?: boolean;
  status?: UserStatus;
  /** 'square' is the app-wide v2 look; 'circle' for profile surfaces. */
  shape?: 'square' | 'circle';
  className?: string;
}

export function Avatar({ avatarUrl, displayName, size = 'md', speaking, status, shape = 'square', className }: AvatarProps) {
  const [imgError, setImgError] = useState(false);

  // Reset error state when avatarUrl changes (e.g. after a new upload)
  useEffect(() => {
    setImgError(false);
  }, [avatarUrl]);

  const sizeClass = clsx(SIZES[size], shape === 'circle' ? 'rounded-full' : SHAPES[size]);
  const initial = displayName?.[0]?.toUpperCase() || '?';

  const ringClass = speaking
    ? 'ring-2 ring-vox-voice-speaking'
    : '';

  const avatarContent = avatarUrl && !imgError ? (
    <img
      src={`${API_BASE}/uploads/${avatarUrl}`}
      alt={displayName || 'avatar'}
      onError={() => setImgError(true)}
      className={clsx(
        'object-cover shrink-0',
        sizeClass,
        ringClass,
        className,
      )}
    />
  ) : (
    <div
      className={clsx(
        'flex items-center justify-center font-bold text-vox-on-accent shrink-0',
        sizeClass,
        ringClass,
        className,
      )}
      style={{ backgroundColor: identityColor(displayName) }}
    >
      {initial}
    </div>
  );

  if (!status) return avatarContent;

  return (
    <div className="relative shrink-0">
      {avatarContent}
      <span
        className={clsx(
          'absolute bottom-0 right-0 rounded-full border-vox-channel',
          STATUS_DOT_SIZES[size],
          STATUS_COLORS[status],
        )}
      />
    </div>
  );
}
