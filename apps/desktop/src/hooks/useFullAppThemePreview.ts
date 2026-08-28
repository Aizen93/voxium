import { useCallback, useEffect, useRef, useState } from 'react';
import type { ThemeColors, ThemePatterns } from '@voxium/shared';
import { applyCustomThemeColors, applyCustomPatterns } from '../services/themeEngine';
import { useSettingsStore } from '../stores/settingsStore';

const SETTINGS_MODAL_ID = 'vox-settings-modal';

/**
 * "Try this theme on the real app": paint a palette straight onto <html>, get
 * the settings modal out of the way, and be able to put everything back.
 *
 * Shared by the marketplace (previewing a published theme) and the theme
 * editor (previewing the palette being authored), so both restore the same
 * way — via `settingsStore.reapplyTheme()`, the single owner of what "the
 * theme the user actually chose" means.
 *
 * Restoring on unmount is not optional: without it, closing the modal mid
 * preview would leave someone else's colors painted on the app permanently
 * (the store still says the old theme, so nothing would ever re-apply it).
 */
export function useFullAppThemePreview() {
  const [preview, setPreview] = useState<{ key: string; name: string } | null>(null);
  const activeRef = useRef(false);

  const restore = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    useSettingsStore.getState().reapplyTheme();
    const settingsEl = document.getElementById(SETTINGS_MODAL_ID);
    if (settingsEl) settingsEl.style.display = '';
  }, []);

  const startPreview = useCallback(
    (key: string, name: string, colors: ThemeColors, patterns?: ThemePatterns) => {
      activeRef.current = true;
      // Hide the settings modal so the user sees the app, not the dialog.
      const settingsEl = document.getElementById(SETTINGS_MODAL_ID);
      if (settingsEl) settingsEl.style.display = 'none';
      applyCustomThemeColors(colors);
      applyCustomPatterns(patterns);
      setPreview({ key, name });
    },
    [],
  );

  const stopPreview = useCallback(() => {
    restore();
    setPreview(null);
  }, [restore]);

  /**
   * Installing/saving hands ownership of the theme back to the store, which
   * applies it itself — drop the preview WITHOUT restoring, or we would repaint
   * the app in the theme the user just replaced.
   */
  const adoptPreview = useCallback(() => {
    activeRef.current = false;
    const settingsEl = document.getElementById(SETTINGS_MODAL_ID);
    if (settingsEl) settingsEl.style.display = '';
    setPreview(null);
  }, []);

  useEffect(() => () => restore(), [restore]);

  return {
    previewKey: preview?.key ?? null,
    previewName: preview?.name ?? null,
    previewing: preview !== null,
    startPreview,
    stopPreview,
    adoptPreview,
  };
}
