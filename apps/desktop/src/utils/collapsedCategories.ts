const COLLAPSED_KEY = 'voxium_collapsed_categories';

/** The categories the person folded, read back from this device. */
export function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch (err) {
    // Unreadable storage (private mode, a corrupt entry): everything starts
    // expanded. The error's message would quote the stored text: name only.
    console.warn('[ChannelSidebar] Could not read the collapsed categories (the stored text is not logged):', err instanceof Error ? err.name : 'Error');
  }
  return new Set();
}

export function saveCollapsed(collapsed: Set<string>): void {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
}
