/**
 * Clipboard write that still works where the async API is not available: the
 * Tauri webview and plain `http://localhost` both fall out of
 * `window.isSecureContext` and would otherwise silently do nothing.
 *
 * Throws instead of reporting its own failure, so each caller can name what
 * did not get copied. The strings this handles — a recovery key that is shown
 * once, a linking code the user is about to carry to another device, a secure
 * channel's id on its way to an admin — are ones where "copy quietly did
 * nothing" is the worst outcome.
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (err) {
      // A refusal of the async API (a webview permission policy, a document
      // without focus) is not the end: the textarea route below may still work
      console.warn('[Clipboard] writeText was refused, trying the fallback:', err instanceof Error ? err.message : err);
    }
  }
  copyThroughTextarea(text);
}

/** The execCommand route. Throws `copy rejected` when it does not copy. */
function copyThroughTextarea(text: string): void {
  // The copy-once panel (and every other caller) is a dialog with a focus
  // trap: focus goes back where it was, or the trap loses it to <body>
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement('textarea');
  field.value = text;
  field.style.position = 'fixed';
  field.style.left = '-9999px';
  document.body.appendChild(field);
  let ok = false;
  try {
    field.focus();
    field.select();
    // execCommand can throw (a webview that blocks it) as well as answer false;
    // both are the same failure to the caller
    ok = document.execCommand('copy');
  } catch (err) {
    console.warn('[Clipboard] execCommand copy threw:', err instanceof Error ? err.message : err);
  } finally {
    // Never leave the text (a webhook token, a recovery key) in the DOM
    field.remove();
    if (previousFocus && previousFocus.isConnected) {
      try {
        previousFocus.focus({ preventScroll: true });
      } catch (err) {
        console.warn('[Clipboard] Could not restore focus:', err instanceof Error ? err.message : err);
      }
    }
  }
  if (!ok) throw new Error('copy rejected');
}
