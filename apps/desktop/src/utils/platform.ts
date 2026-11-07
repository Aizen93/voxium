/** True on macOS, where shortcuts are shown with ⌘ instead of Ctrl. */
export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');
}
