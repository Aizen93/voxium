/**
 * Device-level editor preferences that survive a restart: ink mode, and
 * (later) text size and recent colours. Not account data — a sharer's
 * tool habits are theirs on this machine, like mute state — so this stays
 * out of resetAccountStores.
 */

export type InkMode = 'persistent' | 'vanishing';

export interface AnnotationPrefs {
  inkMode: InkMode;
}

const STORAGE_KEY = 'vox:annotations:prefs';

export const DEFAULT_ANNOTATION_PREFS: AnnotationPrefs = { inkMode: 'persistent' };

export function loadAnnotationPrefs(): AnnotationPrefs {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return { ...DEFAULT_ANNOTATION_PREFS };
    const parsed = JSON.parse(raw) as Partial<AnnotationPrefs>;
    return {
      inkMode: parsed.inkMode === 'vanishing' ? 'vanishing' : 'persistent',
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
