import { useState, useEffect } from 'react';
import { clsx } from 'clsx';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001/api/v1';

const SIZES = {
  xs: 'h-5 w-5 text-[9px]',
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-20 w-20 text-2xl',
} as const;

interface AvatarProps {
  avatarUrl?: string | null;
  displayName?: string;
  size?: keyof typeof SIZES;
  speaking?: boolean;
  className?: string;
}

export function Avatar({ avatarUrl, displayName, size = 'md', speaking, className }: AvatarProps) {
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

  if (avatarUrl && !imgError) {
    const src = `${API_BASE}/uploads/${avatarUrl}`;
    return (
      <img
        src={src}
        alt={displayName || 'avatar'}
        onError={() => setImgError(true)}
        className={clsx(
          'rounded-full object-cover shrink-0',
          sizeClass,
          ringClass,
          className,
        )}
      />
    );
  }

  return (
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
}
