import type { MaskRect } from '../stores/annotationStore';
import type { MaskStyle } from './maskStyles';

/**
 * Remembered mask layouts: sharing the same window twice should not mean
 * covering the same notification tray twice.
 *
 * DEVICE-LOCAL AND PER USER, NEVER NETWORKED. Entries live in localStorage
 * under `vox:maskLayouts:{userId}` — another account on this machine reads a
 * different key, and logout resets only the in-memory state (the file stays,
 * like trusted-device tokens, so the same user gets their layouts back).
 *
 * The layout KEY is `displaySurface:widthxheight` from the capture track's
 * settings — Chromium's track labels are not stable across sessions for
 * windows, so surface kind + resolution is the honest identity a source has.
 */

export interface MaskLayoutEntry {
  key: string;
  /** Optional user-given name (future picker). */
  name?: string;
  masks: MaskRect[];
  lastUsed: number;
}

export const MASK_LAYOUTS_MAX = 12;
/** Cover-image data URLs above this are dropped from the stored copy (the
 *  geometry and style are the value; a huge image is not worth the quota). */
export const MASK_LAYOUT_SRC_MAX = 100_000;

const STORAGE_PREFIX = 'vox:maskLayouts:';
const STYLES: ReadonlySet<string> = new Set(['cover', 'pixelate', 'blur'] as MaskStyle[]);

export function maskLayoutStorageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

export function sourceKeyFromSettings(settings: { displaySurface?: string; width?: number; height?: number }): string | null {
  const w = settings.width, h = settings.height;
  if (typeof w !== 'number' || typeof h !== 'number' || !(w > 0) || !(h > 0)) return null;
  const surface = typeof settings.displaySurface === 'string' && settings.displaySurface ? settings.displaySurface : 'unknown';
  return `${surface}:${Math.round(w)}x${Math.round(h)}`;
}

const inRange = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** One stored mask, or null if it cannot be trusted. */
function sanitizeMask(raw: unknown): MaskRect | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || m.id.length === 0 || m.id.length > 64) return null;
  if (!inRange(m.x, -0.1, 1.1) || !inRange(m.y, -0.1, 1.1) || !inRange(m.w, 0, 1.1) || !inRange(m.h, 0, 1.1)) return null;
  const mask: MaskRect = { id: m.id, x: m.x, y: m.y, w: m.w, h: m.h };
  if (typeof m.style === 'string' && STYLES.has(m.style) && m.style !== 'cover') mask.style = m.style as MaskStyle;
  if (typeof m.src === 'string' && m.src.startsWith('data:image/') && m.src.length <= MASK_LAYOUT_SRC_MAX) mask.src = m.src;
  return mask;
}

export function loadMaskLayouts(userId: string): MaskLayoutEntry[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(maskLayoutStorageKey(userId)) : null;
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const entries: MaskLayoutEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const e = item as Record<string, unknown>;
      if (typeof e.key !== 'string' || e.key.length === 0 || e.key.length > 128) continue;
      if (!Array.isArray(e.masks)) continue;
      const masks = e.masks.map(sanitizeMask).filter((m): m is MaskRect => m !== null);
      if (masks.length === 0) continue;
      entries.push({
        key: e.key,
        ...(typeof e.name === 'string' && e.name.length <= 64 ? { name: e.name } : {}),
        masks,
        lastUsed: typeof e.lastUsed === 'number' && Number.isFinite(e.lastUsed) ? e.lastUsed : 0,
      });
    }
    return entries.slice(0, MASK_LAYOUTS_MAX);
  } catch (err) {
    console.warn('[MaskLayouts] Could not read stored layouts:', err instanceof Error ? err.message : err);
    return [];
  }
}

export function saveMaskLayouts(userId: string, layouts: MaskLayoutEntry[]): void {
  try {
    localStorage.setItem(maskLayoutStorageKey(userId), JSON.stringify(layouts));
  } catch (err) {
    console.warn('[MaskLayouts] Could not save layouts:', err instanceof Error ? err.message : err);
  }
}

export function findMaskLayout(layouts: readonly MaskLayoutEntry[], key: string): MaskLayoutEntry | undefined {
  return layouts.find((e) => e.key === key);
}

/**
 * Replace (or create) the entry for `key`. Empty masks DELETE the entry —
 * "no masks for this window" is a memory too, and remembering a stale layout
 * the user deliberately cleared would re-cover the wrong things next time.
 * Least-recently-used entries fall off past the cap.
 */
export function upsertMaskLayout(layouts: readonly MaskLayoutEntry[], key: string, masks: readonly MaskRect[], now: number): MaskLayoutEntry[] {
  const rest = layouts.filter((e) => e.key !== key);
  if (masks.length === 0) return [...rest];
  const previous = findMaskLayout(layouts, key);
  const stored = masks.map((m) => sanitizeMask(m)).filter((m): m is MaskRect => m !== null);
  if (stored.length === 0) return [...rest];
  const next = [...rest, { ...(previous?.name ? { name: previous.name } : {}), key, masks: stored, lastUsed: now }];
  next.sort((a, b) => b.lastUsed - a.lastUsed);
  return next.slice(0, MASK_LAYOUTS_MAX);
}
