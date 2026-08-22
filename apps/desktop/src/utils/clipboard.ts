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
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.style.position = 'fixed';
  field.style.left = '-9999px';
  document.body.appendChild(field);
  field.focus();
  field.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(field);
  if (!ok) throw new Error('copy rejected');
}
