import { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AdminConfirmModal } from '../../components/AdminConfirmModal';
import { mount, click, keyDown, type, deferred, getByRole, queryByRole, bodyText, flush, type Mounted } from '../helpers/dom';

/**
 * The shared confirmation dialog behind every destructive action of the
 * dashboard: a modal dialog labelled by its title, two buttons, a close icon,
 * a busy state while the confirm handler runs. Escape and the backdrop cancel
 * (not while busy), focus starts on Cancel and returns to the opener.
 */

let view: Mounted;
const onConfirm = vi.fn();
const onCancel = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  onConfirm.mockResolvedValue(undefined);
  view = mount();
});
afterEach(() => view.unmount());

// A pointer press and release: where it went down and where it came up decide whether it was a click
async function press(down: Element, up: Element = down): Promise<void> {
  await act(async () => {
    down.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    up.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    // the browser fires the click on the nearest common ancestor of both targets
    const common = down === up ? up : down.contains(up) ? down : up.contains(down) ? up : up.parentElement!;
    common.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('AdminConfirmModal', () => {
  it('shows the title and the message, and "Confirm" as the default confirm label', async () => {
    await view.render(<AdminConfirmModal title="Delete thing" message="Are you sure?" onConfirm={onConfirm} onCancel={onCancel} />);
    expect(getByRole('heading', 'Delete thing')).toBeTruthy();
    expect(bodyText()).toContain('Are you sure?');
    expect(getByRole('button', 'Confirm')).toBeTruthy();
    expect(getByRole('button', 'Cancel')).toBeTruthy();
  });

  it('uses the confirm label it is given', async () => {
    await view.render(<AdminConfirmModal title="t" message="m" confirmLabel="Unban" onConfirm={onConfirm} onCancel={onCancel} />);
    expect(getByRole('button', 'Unban')).toBeTruthy();
    expect(queryByRole('button', 'Confirm')).toBeNull();
  });

  it('calls the confirm handler exactly once when Confirm is pressed, and never the cancel handler', async () => {
    await view.render(<AdminConfirmModal title="t" message="m" onConfirm={onConfirm} onCancel={onCancel} />);
    await click(getByRole('button', 'Confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('calls the cancel handler exactly once when Cancel is pressed, and never the confirm handler', async () => {
    await view.render(<AdminConfirmModal title="t" message="m" onConfirm={onConfirm} onCancel={onCancel} />);
    await click(getByRole('button', 'Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('is a modal dialog labelled by its title', async () => {
    await view.render(<AdminConfirmModal title="Delete thing" message="m" onConfirm={onConfirm} onCancel={onCancel} />);
    const dialog = getByRole('dialog', 'Delete thing');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('the close icon in the header, named "Close", cancels', async () => {
    await view.render(<AdminConfirmModal title="t" message="m" onConfirm={onConfirm} onCancel={onCancel} />);
    await click(getByRole('button', 'Close'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Escape cancels once, and never confirms', async () => {
    await view.render(<AdminConfirmModal title="t" message="m" onConfirm={onConfirm} onCancel={onCancel} />);
    await keyDown(document.body, 'Escape');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('other keys do nothing', async () => {
    await view.render(<AdminConfirmModal title="t" message="m" onConfirm={onConfirm} onCancel={onCancel} />);
    await keyDown(document.body, 'Enter');
    await keyDown(document.body, 'a');
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('a click on the backdrop cancels; a click inside the card does not', async () => {
    await view.render(<AdminConfirmModal title="t" message="m" onConfirm={onConfirm} onCancel={onCancel} />);
    const dialog = getByRole('dialog', 't');
    await press(dialog);
    await press(getByRole('heading', 't'));
    expect(onCancel).not.toHaveBeenCalled();
    await press(dialog.parentElement!);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('a press that starts inside the card and is released on the backdrop (a text selection) does not cancel', async () => {
    await view.render(<AdminConfirmModal title="t" message="m" onConfirm={onConfirm} onCancel={onCancel} />);
    const dialog = getByRole('dialog', 't');
    await press(getByRole('heading', 't'), dialog.parentElement!);
    expect(onCancel).not.toHaveBeenCalled();
    // the mark is spent: a click with no press of its own does not cancel either
    await click(dialog.parentElement!);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('a press that starts on the backdrop and is released inside the card does not cancel', async () => {
    await view.render(<AdminConfirmModal title="t" message="m" onConfirm={onConfirm} onCancel={onCancel} />);
    const dialog = getByRole('dialog', 't');
    await press(dialog.parentElement!, getByRole('heading', 't'));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Escape stops at the dialog: a listener above it never sees the key it handled', async () => {
    const above = vi.fn();
    window.addEventListener('keydown', above);
    try {
      await view.render(<AdminConfirmModal title="t" message="m" onConfirm={onConfirm} onCancel={onCancel} />);
      await keyDown(document.body, 'Escape');
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(above).not.toHaveBeenCalled();
      await keyDown(document.body, 'a');
      expect(above).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', above);
    }
  });

  describe('dismissible={false}', () => {
    it('ignores Escape and the backdrop, and lets the key through', async () => {
      const above = vi.fn();
      window.addEventListener('keydown', above);
      try {
        await view.render(<AdminConfirmModal title="t" message="m" dismissible={false} onConfirm={onConfirm} onCancel={onCancel} />);
        await keyDown(document.body, 'Escape');
        await press(getByRole('dialog', 't').parentElement!);
        expect(onCancel).not.toHaveBeenCalled();
        expect(above).toHaveBeenCalledTimes(1);
      } finally {
        window.removeEventListener('keydown', above);
      }
    });

    it('is still cancelled by the Cancel button and the close X', async () => {
      await view.render(<AdminConfirmModal title="t" message="m" dismissible={false} onConfirm={onConfirm} onCancel={onCancel} />);
      await click(getByRole('button', 'Cancel'));
      expect(onCancel).toHaveBeenCalledTimes(1);
      await click(getByRole('button', 'Close'));
      expect(onCancel).toHaveBeenCalledTimes(2);
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('still confirms', async () => {
      await view.render(<AdminConfirmModal title="t" message="m" dismissible={false} onConfirm={onConfirm} onCancel={onCancel} />);
      await click(getByRole('button', 'Confirm'));
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  });

  it('Escape and the backdrop are ignored while the confirm action is in flight, and work again after', async () => {
    const pending = deferred();
    onConfirm.mockReturnValue(pending.promise);
    await view.render(<AdminConfirmModal title="t" message="m" onConfirm={onConfirm} onCancel={onCancel} />);
    await click(getByRole('button', 'Confirm'));
    await keyDown(document.body, 'Escape');
    await press(getByRole('dialog', 't').parentElement!);
    expect(onCancel).not.toHaveBeenCalled();

    pending.resolve();
    await flush();
    await keyDown(document.body, 'Escape');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('puts focus on Cancel when it opens and gives it back to the opener when it closes', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    await view.render(<AdminConfirmModal title="t" message="m" onConfirm={onConfirm} onCancel={onCancel} />);
    expect(document.activeElement).toBe(getByRole('button', 'Cancel'));
    await view.render(<></>);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('a rejecting confirm handler leaves no unhandled rejection, logs its message once and keeps the dialog usable', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const failure = Object.assign(new Error('boom'), { response: { data: { secret: 'body' } } });
      onConfirm.mockRejectedValueOnce(failure);
      await view.render(<AdminConfirmModal title="t" message="m" onConfirm={onConfirm} onCancel={onCancel} />);
      await click(getByRole('button', 'Confirm'));
      await flush();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]).toEqual(['Confirm action failed:', 'boom']);
      const again = getByRole('button', 'Confirm') as HTMLButtonElement;
      expect(again.disabled).toBe(false);
      await click(again);
      expect(onConfirm).toHaveBeenCalledTimes(2);
    } finally {
      process.off('unhandledRejection', unhandled);
      log.mockRestore();
    }
  });

  it('shows "Processing..." and disables Confirm while the handler runs, so a second press does nothing', async () => {
    const pending = deferred();
    onConfirm.mockReturnValue(pending.promise);
    await view.render(<AdminConfirmModal title="t" message="m" onConfirm={onConfirm} onCancel={onCancel} />);
    await click(getByRole('button', 'Confirm'));
    const busy = getByRole('button', 'Processing...') as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    await click(busy);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    pending.resolve();
    await flush();
    const idle = getByRole('button', 'Confirm') as HTMLButtonElement;
    expect(idle.disabled).toBe(false);
  });

  it('draws the danger colour by default and the primary colour for danger={false} or variant="primary"', async () => {
    await view.render(<AdminConfirmModal title="t" message="m" onConfirm={onConfirm} onCancel={onCancel} />);
    expect(getByRole('button', 'Confirm').className).toContain('bg-vox-accent-danger');
    await view.render(<AdminConfirmModal title="t" message="m" danger={false} onConfirm={onConfirm} onCancel={onCancel} />);
    expect(getByRole('button', 'Confirm').className).toContain('bg-vox-accent-primary');
    await view.render(<AdminConfirmModal title="t" message="m" variant="primary" onConfirm={onConfirm} onCancel={onCancel} />);
    expect(getByRole('button', 'Confirm').className).toContain('bg-vox-accent-primary');
    await view.render(<AdminConfirmModal title="t" message="m" danger={false} variant="danger" onConfirm={onConfirm} onCancel={onCancel} />);
    expect(getByRole('button', 'Confirm').className).toContain('bg-vox-accent-danger');
  });

  it('renders a title and a message containing markup as text, never as elements', async () => {
    const markup = '<img src=x onerror="alert(1)"><b>bold</b>';
    await view.render(<AdminConfirmModal title={markup} message={markup} onConfirm={onConfirm} onCancel={onCancel} />);
    expect(document.body.querySelector('img')).toBeNull();
    expect(document.body.querySelector('b')).toBeNull();
    expect(getByRole('heading').textContent).toBe(markup);
    expect(bodyText()).toContain(markup);
  });
});

describe('AdminConfirmModal — requireTypedText', () => {
  const render = (text: string | undefined = 'alice') =>
    view.render(<AdminConfirmModal title="Delete User" message="m" confirmLabel="Delete" dismissible={false} requireTypedText={text} onConfirm={onConfirm} onCancel={onCancel} />);
  const input = () => getByRole('textbox', /Type alice to confirm/) as HTMLInputElement;
  const confirm = () => getByRole('button', 'Delete') as HTMLButtonElement;

  it('shows no input and keeps the button enabled when the prop is not given', async () => {
    await view.render(<AdminConfirmModal title="t" message="m" onConfirm={onConfirm} onCancel={onCancel} />);
    expect(queryByRole('textbox')).toBeNull();
    expect((getByRole('button', 'Confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  it('starts disabled, with a labelled input showing the name in a code element', async () => {
    await render();
    expect(confirm().disabled).toBe(true);
    expect(input().value).toBe('');
    expect(input().getAttribute('autocomplete')).toBe('off');
    expect(input().getAttribute('spellcheck')).toBe('false');
    expect(document.querySelector('label code')?.textContent).toBe('alice');
    expect(document.activeElement).toBe(getByRole('button', 'Cancel'));
  });

  it('a wrong name and a name differing only by case keep it disabled; the right name, trimmed, enables it', async () => {
    await render();
    await type(input(), 'alicia');
    expect(confirm().disabled).toBe(true);
    await type(input(), 'Alice');
    expect(confirm().disabled).toBe(true);
    expect(bodyText()).toContain('The name is case-sensitive.');
    await click(confirm());
    expect(onConfirm).not.toHaveBeenCalled();
    await type(input(), '  alice  ');
    expect(confirm().disabled).toBe(false);
    await click(confirm());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('Enter confirms only while the name matches', async () => {
    await render();
    await type(input(), 'ali');
    await keyDown(input(), 'Enter');
    expect(onConfirm).not.toHaveBeenCalled();
    await type(input(), 'alice');
    await keyDown(input(), 'Enter');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('Escape and a backdrop click leave it open; Cancel and the close icon cancel', async () => {
    await render();
    await type(input(), 'ali');
    await keyDown(document.body, 'Escape');
    await press(document.querySelector('.fixed')!);
    expect(onCancel).not.toHaveBeenCalled();
    expect(input().value).toBe('ali');
    await click(getByRole('button', 'Cancel'));
    await click(getByRole('button', 'Close'));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('a new dialog starts with an empty input', async () => {
    await render();
    await type(input(), 'alice');
    view.unmount();
    view = mount();
    await render();
    expect(input().value).toBe('');
    expect(confirm().disabled).toBe(true);
  });

  it('disables the input while the confirm action is in flight, and keeps the value when it fails', async () => {
    const pending = deferred();
    onConfirm.mockReturnValue(pending.promise);
    await render();
    await type(input(), 'alice');
    await click(confirm());
    expect(input().disabled).toBe(true);
    pending.reject(new Error('boom'));
    await flush();
    expect(input().disabled).toBe(false);
    expect(input().value).toBe('alice');
  });

  it('an empty name can never be confirmed and says why', async () => {
    await render('');
    expect(queryByRole('textbox')).toBeNull();
    expect(bodyText()).toContain('no username to type');
    expect(confirm().disabled).toBe(true);
  });
});
