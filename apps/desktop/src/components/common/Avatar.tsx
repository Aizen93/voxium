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
  className?: string;
}

export function Avatar({ avatarUrl, displayName, size = 'md', speaking, status, className }: AvatarProps) {
  const [imgError, setImgError] = useState(false);

  // Reset error state when avatarUrl changes (e.g. after a new upload)
  useEffect(() => {
    setImgError(false);
  }, [avatarUrl]);

  const sizeClass = SIZES[size];
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
        'rounded-full object-cover shrink-0',
        sizeClass,
        ringClass,
        className,
      )}
    />
  ) : (
    <div
      className={clsx(
        'flex items-center justify-center rounded-full bg-vox-accent-primary font-semibold text-white shrink-0',
        sizeClass,
        ringClass,
        className,
      )}
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
