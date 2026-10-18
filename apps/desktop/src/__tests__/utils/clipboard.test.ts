import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { copyToClipboard } from '../../utils/clipboard';

/**
 * The fallback path (no async clipboard: the Tauri webview, plain
 * http://localhost) copies through an off-screen textarea holding the text —
 * a webhook token, a recovery key. However the copy ends, the textarea goes.
 */

const textareas = () => document.body.querySelectorAll('textarea');

let execCommand: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;
const originalExec = document.execCommand;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

beforeEach(() => {
  // force the fallback: no async clipboard API
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  execCommand = vi.fn();
  document.execCommand = execCommand as unknown as typeof document.execCommand;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  document.execCommand = originalExec;
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
  warn.mockRestore();
  document.body.innerHTML = '';
});

describe('copyToClipboard — the execCommand fallback', () => {
  it('copies the text and removes the textarea', async () => {
    let seen: string | undefined;
    execCommand.mockImplementation(() => { seen = textareas()[0]?.value; return true; });

    await expect(copyToClipboard('vxwh_secret')).resolves.toBeUndefined();

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(seen).toBe('vxwh_secret');
    expect(textareas()).toHaveLength(0);
  });

  it('a refused copy (false) rejects with "copy rejected" and leaves no textarea', async () => {
    execCommand.mockReturnValue(false);

    await expect(copyToClipboard('vxwh_secret')).rejects.toThrow('copy rejected');

    expect(textareas()).toHaveLength(0);
  });

  it('a THROWING execCommand still removes the textarea, and fails the same way — the caller sees "copy rejected"', async () => {
    execCommand.mockImplementation(() => { throw new Error('blocked by the webview'); });

    await expect(copyToClipboard('vxwh_secret')).rejects.toThrow('copy rejected');

    expect(textareas()).toHaveLength(0);
    expect(document.body.innerHTML).not.toContain('vxwh_secret');
    // the cause is logged (message only), not swallowed
    expect(warn).toHaveBeenCalledWith('[Clipboard] execCommand copy threw:', 'blocked by the webview');
  });
});
