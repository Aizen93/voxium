import { useState } from 'react';
import { clsx } from 'clsx';

/**
 * A server's icon, or a generated one when it has none.
 *
 * The generated fallback is not a flat grey chip: it is a gradient whose hue is
 * derived from the server id, constrained to the arc between the two logo stops
 * (violet 262° -> blue 217°). So a list of servers is scannable by colour —
 * which is what makes a dense rail usable at all — while every colour still
 * belongs to the brand. A free hue wheel would have given us lime and orange
 * chips next to a violet logo.
 */
export function hueFor(id: string): number {
  // FNV-1a: tiny, stable, and well spread for short strings. Same server always
  // gets the same colour, on every device and across reloads.
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const VIOLET = 262;
  const BLUE = 217;
  return BLUE + (Math.abs(h) % (VIOLET - BLUE + 1));
}

export function ServerIcon({
  id,
  name,
  iconUrl,
  size = 32,
  rounded = 'rounded-lg',
  className,
}: {
  id: string;
  name: string;
  iconUrl?: string | null;
  size?: number;
  rounded?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  if (iconUrl && !failed) {
    return (
      <img
        src={`${import.meta.env.VITE_API_URL || 'http://localhost:3001/api/v1'}/uploads/${iconUrl}`}
        alt={name}
        draggable={false}
        style={{ width: size, height: size }}
        className={clsx('shrink-0 object-cover', rounded, className)}
        onError={() => setFailed(true)}
      />
    );
  }

  const hue = hueFor(id);
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.36)),
        backgroundImage: `linear-gradient(135deg, hsl(${hue} 62% 46%), hsl(${hue - 18} 70% 38%))`,
      }}
      className={clsx(
        'flex shrink-0 select-none items-center justify-center font-semibold tracking-tight text-white',
        rounded,
        className
      )}
    >
      {initials || '?'}
    </span>
  );
}
