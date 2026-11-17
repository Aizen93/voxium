import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AdminConfirmModal } from '../../components/AdminConfirmModal';
import { mount, click, keyDown, deferred, getByRole, queryByRole, bodyText, flush, type Mounted } from '../helpers/dom';

/**
 * The shared confirmation dialog behind every destructive action of the
 * dashboard: two buttons, a close icon, a busy state while the confirm
 * handler runs. It has no Escape handler, no backdrop handler and no focus
 * management; those tests pin what it does today.
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

  it('the close icon in the header cancels (it has no accessible name)', async () => {
    await view.render(<AdminConfirmModal title="t" message="m" onConfirm={onConfirm} onCancel={onCancel} />);
    const close = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === '' && b.querySelector('svg'))!;
    expect(close).toBeTruthy();
    await click(close);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Escape does not close it today: no handler is registered', async () => {
    await view.render(<AdminConfirmModal title="t" message="m" onConfirm={onConfirm} onCancel={onCancel} />);
    await keyDown(document.body, 'Escape');
    await keyDown(getByRole('button', 'Confirm'), 'Escape');
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('a click on the backdrop does not close it today, and a click inside the card does not either', async () => {
    await view.render(<AdminConfirmModal title="t" message="m" onConfirm={onConfirm} onCancel={onCancel} />);
    const card = getByRole('heading', 't').parentElement!.parentElement!;
    const backdrop = card.parentElement!;
    await click(backdrop);
    await click(card);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
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

  it('lands focus nowhere in particular: it does not move focus to either button', async () => {
    await view.render(<AdminConfirmModal title="t" message="m" onConfirm={onConfirm} onCancel={onCancel} />);
    expect(document.activeElement).toBe(document.body);
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
