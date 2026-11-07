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

describe('copyToClipboard — focus comes back (the copy-once panel is a focus trap)', () => {
  it('the element focused before the copy is focused again after it, whether the copy worked or not', async () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    let focusedDuring: Element | null = null;
    execCommand.mockImplementation(() => { focusedDuring = document.activeElement; return true; });

    await copyToClipboard('vxwh_secret');
    // the textarea had focus while it copied, and the button has it back
    expect(focusedDuring).toBeInstanceOf(HTMLTextAreaElement);
    expect(document.activeElement).toBe(button);

    execCommand.mockReturnValue(false);
    await expect(copyToClipboard('vxwh_secret')).rejects.toThrow('copy rejected');
    expect(document.activeElement).toBe(button);

    execCommand.mockImplementation(() => { throw new Error('blocked'); });
    await expect(copyToClipboard('vxwh_secret')).rejects.toThrow('copy rejected');
    expect(document.activeElement).toBe(button);
  });

  it('nothing focused before: nothing to restore, and no throw', async () => {
    (document.activeElement as HTMLElement | null)?.blur();
    execCommand.mockReturnValue(true);
    await expect(copyToClipboard('x')).resolves.toBeUndefined();
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
  });

  it('an element removed during the copy is not focused again (it is gone)', async () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    execCommand.mockImplementation(() => { button.remove(); return true; });
    await expect(copyToClipboard('x')).resolves.toBeUndefined();
    expect(document.activeElement).not.toBe(button);
  });
});

describe('copyToClipboard — the async clipboard API', () => {
  let writeText: ReturnType<typeof vi.fn>;
  const originalSecure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');

  beforeEach(() => {
    writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  });

  afterEach(() => {
    if (originalSecure) Object.defineProperty(window, 'isSecureContext', originalSecure);
    else delete (window as { isSecureContext?: boolean }).isSecureContext;
  });

  it('when it works, it is the only route: no textarea, no execCommand', async () => {
    writeText.mockResolvedValue(undefined);
    let textareaSeen = false;
    const observer = new MutationObserver(() => { if (textareas().length) textareaSeen = true; });
    observer.observe(document.body, { childList: true });
    await expect(copyToClipboard('vxwh_secret')).resolves.toBeUndefined();
    observer.disconnect();
    expect(writeText).toHaveBeenCalledWith('vxwh_secret');
    expect(execCommand).not.toHaveBeenCalled();
    expect(textareaSeen).toBe(false);
  });

  it('when it REJECTS (a permission policy, an unfocused document), the textarea route still copies', async () => {
    writeText.mockRejectedValue(new Error('Document is not focused.'));
    let seen: string | undefined;
    execCommand.mockImplementation(() => { seen = textareas()[0]?.value; return true; });

    await expect(copyToClipboard('vxwh_secret')).resolves.toBeUndefined();

    expect(writeText).toHaveBeenCalledWith('vxwh_secret');
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(seen).toBe('vxwh_secret');
    expect(textareas()).toHaveLength(0);
    // the refusal is logged by its message, never with the text
    expect(warn).toHaveBeenCalledWith('[Clipboard] writeText was refused, trying the fallback:', 'Document is not focused.');
    for (const call of warn.mock.calls) expect(call.join(' ')).not.toContain('vxwh_secret');
  });

  it('when both routes fail, it rejects with "copy rejected" (the caller toasts) and leaves no textarea', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    execCommand.mockReturnValue(false);
    await expect(copyToClipboard('vxwh_secret')).rejects.toThrow('copy rejected');
    expect(textareas()).toHaveLength(0);
  });
});
