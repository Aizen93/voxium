/**
 * Device-level editor preferences that survive a restart: ink mode, text
 * size, recently used colours. Not account data — a sharer's tool habits are
 * theirs on this machine, like mute state — so this stays out of
 * resetAccountStores.
 */

export type InkMode = 'persistent' | 'vanishing';

export interface AnnotationPrefs {
  inkMode: InkMode;
  /** Caption / badge size as a fraction of the frame height. */
  textSize: number;
  /** Most recent first, '#rrggbb', at most RECENT_COLORS_MAX. */
  recentColors: string[];
  /** Skip the pre-share mask check ("don't show this again"). The monitor
   *  nudge still shows as a toast — a whole screen is never quietly shared. */
  skipPreflight: boolean;
  /** Floating reaction emoji over the share — per-viewer hide (item 12). */
  showReactions: boolean;
}

const STORAGE_KEY = 'vox:annotations:prefs';

export const RECENT_COLORS_MAX = 6;
export const TEXT_SIZE_MIN = 0.012;
export const TEXT_SIZE_MAX = 0.2;
export const DEFAULT_TEXT_SIZE = 0.045;

export const DEFAULT_ANNOTATION_PREFS: AnnotationPrefs = { inkMode: 'persistent', textSize: DEFAULT_TEXT_SIZE, recentColors: [], skipPreflight: false, showReactions: true };

const HEX6_RE = /^#[0-9a-f]{6}$/;

/**
 * The wire takes '#rrggbb' only (the server's COLOR_RE). A native colour
 * picker yields that already; paste and older prefs may carry '#rgb' or an
 * alpha channel — widen the short form, drop the alpha, lowercase.
 */
export function normalizeHexColor(input: string): string | null {
  const v = input.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  if (/^#[0-9a-f]{8}$/.test(v)) return v.slice(0, 7);
  return HEX6_RE.test(v) ? v : null;
}

export function clampTextSize(size: number): number {
  return Math.min(TEXT_SIZE_MAX, Math.max(TEXT_SIZE_MIN, size));
}

export function loadAnnotationPrefs(): AnnotationPrefs {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return { ...DEFAULT_ANNOTATION_PREFS };
    const parsed = JSON.parse(raw) as Partial<AnnotationPrefs>;
    const recent = Array.isArray(parsed.recentColors)
      ? parsed.recentColors.map((c) => (typeof c === 'string' ? normalizeHexColor(c) : null)).filter((c): c is string => c !== null)
      : [];
    return {
      inkMode: parsed.inkMode === 'vanishing' ? 'vanishing' : 'persistent',
      textSize: typeof parsed.textSize === 'number' && Number.isFinite(parsed.textSize) ? clampTextSize(parsed.textSize) : DEFAULT_TEXT_SIZE,
      recentColors: [...new Set(recent)].slice(0, RECENT_COLORS_MAX),
      skipPreflight: parsed.skipPreflight === true,
      showReactions: parsed.showReactions !== false,
    };
  } catch (err) {
    console.warn('[Annotations] Could not read editor preferences:', err instanceof Error ? err.message : err);
    return { ...DEFAULT_ANNOTATION_PREFS };
  }
}

export function saveAnnotationPrefs(prefs: AnnotationPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch (err) {
    console.warn('[Annotations] Could not save editor preferences:', err instanceof Error ? err.message : err);
  }
}

/** `color` moved to the front, de-duplicated, capped. */
export function pushRecentColor(recent: readonly string[], color: string): string[] {
  return [color, ...recent.filter((c) => c !== color)].slice(0, RECENT_COLORS_MAX);
}
