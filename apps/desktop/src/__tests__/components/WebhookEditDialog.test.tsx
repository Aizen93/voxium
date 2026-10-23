import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LIMITS } from '@voxium/shared';
import type { Channel, Webhook, WebhookTarget } from '@voxium/shared';

/**
 * The edit dialog of a webhook (rename, move). It sends ONLY what changed:
 * a rename alone never re-asks the channel check, a move alone never rewrites
 * the name. The current channel stays on offer even when the targets list
 * lacks it (no SEND there any more, or still loading): keeping it is not a move.
 */

const t = (k: string, o?: Record<string, unknown>) => (o ? `${k}${JSON.stringify(o)}` : k);
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t, i18n: { language: 'en' } }) };
});

let channels: Channel[] = [];
vi.mock('../../stores/serverStore', () => {
  const state = () => ({ channels });
  const useServerStore = <T,>(sel: (s: ReturnType<typeof state>) => T) => sel(state());
  useServerStore.getState = state;
  return { useServerStore };
});

import { WebhookEditDialog, type WebhookEditPatch } from '../../components/server/WebhookEditDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const channel = (id: string, name: string, extra: Partial<Channel> = {}): Channel => ({
  id, name, type: 'text', serverId: 'srv-1', categoryId: null, position: 0, createdAt: '2026-01-01T00:00:00.000Z', ...extra,
});
const hook = (extra: Partial<Webhook> = {}): Webhook => ({
  id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'generic', enabled: true,
  createdBy: { id: 'u-1', username: 'alice', displayName: 'Alice' }, createdAt: '2026-10-01T00:00:00.000Z', lastUsedAt: null,
  adminDisabledAt: null, creatorRemovedAt: null, lastRotatedAt: null, lastRotatedBy: null, ...extra,
});
const target = (id: string, name: string, position = 0): WebhookTarget => ({ id, name, categoryId: null, position });
const TARGETS = [target('ch-1', 'general', 0), target('ch-2', 'deploys', 1), target('ch-3', 'ops', 2)];

interface DialogProps {
  webhook: Webhook;
  channels: WebhookTarget[] | null;
  busy: boolean;
  error: string | null;
}

let container: HTMLDivElement;
let root: Root;
let props: DialogProps;
const onSave = vi.fn<(patch: WebhookEditPatch) => void>();
const onClose = vi.fn();
const onDismissError = vi.fn();

const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const nameInput = () => q('[data-testid="webhook-edit-name"]') as HTMLInputElement;
const select = () => q('[data-testid="webhook-edit-channel"]') as HTMLSelectElement;
const save = () => q('[data-testid="webhook-edit-save"]') as HTMLButtonElement;
const options = () => [...select().options].map((o) => [o.value, o.textContent]);

async function render(next: Partial<DialogProps> = {}) {
  props = { ...props, ...next };
  await act(async () => {
    root.render(<WebhookEditDialog {...props} onSave={onSave} onClose={onClose} onDismissError={onDismissError} />);
  });
}
async function click(el: Element | null) {
  expect(el, 'element to click').not.toBeNull();
  await act(async () => { (el as HTMLElement).click(); });
}
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function pick(el: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function key(keyName: string) {
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true })); });
}
async function submitWithEnter() {
  // What Enter in a field does: submits the form (requestSubmit ignores a disabled Save, so the guard is the dialog's)
  await act(async () => { (q('[data-testid="webhook-edit-dialog"] form') as HTMLFormElement).requestSubmit(); });
}

beforeEach(() => {
  vi.clearAllMocks();
  channels = [channel('ch-1', 'general'), channel('ch-2', 'deploys'), channel('ch-3', 'ops'), channel('ch-x', 'elsewhere', { serverId: 'srv-2' })];
  props = { webhook: hook(), channels: TARGETS, busy: false, error: null };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('WebhookEditDialog — prefill', () => {
  it('opens on the webhook as it is: its name (focused), its channel selected and marked current, Save disabled', async () => {
    await render();
    expect(q('#webhook-edit-title')!.textContent).toBe('webhooks.edit.title');
    expect(q('[data-testid="webhook-edit-dialog"]')!.getAttribute('aria-labelledby')).toBe('webhook-edit-title');
    expect(nameInput().value).toBe('CI');
    expect(document.activeElement).toBe(nameInput());
    expect(select().value).toBe('ch-1');
    // listed once, in its place, with the "current" suffix
    expect(options()).toEqual([
      ['ch-1', 'webhooks.edit.current{"channel":"#general"}'],
      ['ch-2', '#deploys'],
      ['ch-3', '#ops'],
    ]);
    expect(select().options[0].getAttribute('data-current')).toBe('true');
    expect(select().options[1].hasAttribute('data-current')).toBe(false);
    expect(save().disabled).toBe(true);
    expect(save().textContent).toBe('common.save');
    expect(q('[data-testid="webhook-edit-move-note"]')!.textContent).toBe('webhooks.edit.moveNote');
    expect(q('[data-testid="webhook-edit-channels-loading"]')).toBeNull();
    expect(q('[data-testid="webhook-edit-pick-gone"]')).toBeNull();
    expect(q('[data-testid="webhook-edit-error"]')).toBeNull();
    // the shared name field: its label, the limit, the counter
    expect(q('label[for="webhook-edit-name"]')!.textContent).toBe('webhooks.edit.name');
    expect(nameInput().maxLength).toBe(LIMITS.WEBHOOK_NAME_MAX);
    expect(q('[data-testid="webhook-edit-dialog"]')!.textContent).toContain(`2/${LIMITS.WEBHOOK_NAME_MAX}`);
  });
});

describe('WebhookEditDialog — only what changed is sent', () => {
  it('a rename alone sends { name }, trimmed', async () => {
    await render();
    await type(nameInput(), '  Nightly build  ');
    expect(save().disabled).toBe(false);
    await click(save());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toStrictEqual({ name: 'Nightly build' });
  });

  it('a move alone sends { channelId }', async () => {
    await render();
    await pick(select(), 'ch-2');
    expect(save().disabled).toBe(false);
    await click(save());
    expect(onSave.mock.calls[0][0]).toStrictEqual({ channelId: 'ch-2' });
  });

  it('both changed: both are sent', async () => {
    await render();
    await type(nameInput(), 'Deploys');
    await pick(select(), 'ch-3');
    await click(save());
    expect(onSave.mock.calls[0][0]).toStrictEqual({ name: 'Deploys', channelId: 'ch-3' });
  });

  it('Enter submits the same patch', async () => {
    await render();
    await type(nameInput(), 'Nightly');
    await submitWithEnter();
    expect(onSave.mock.calls[0][0]).toStrictEqual({ name: 'Nightly' });
  });

  it('nothing changed: Save is disabled and Enter sends nothing (whitespace around the same name, a move back, a revert)', async () => {
    await render();
    await type(nameInput(), '  CI ');
    expect(save().disabled).toBe(true);
    await pick(select(), 'ch-2');
    expect(save().disabled).toBe(false);
    await pick(select(), 'ch-1');
    expect(save().disabled).toBe(true);
    await type(nameInput(), 'CIx');
    await type(nameInput(), 'CI');
    expect(save().disabled).toBe(true);
    await submitWithEnter();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('WebhookEditDialog — the name is validated before the request', () => {
  it('an empty name is refused with the translated message and never reaches onSave; typing clears the message', async () => {
    await render();
    await type(nameInput(), '   ');
    await click(save());
    expect(onSave).not.toHaveBeenCalled();
    const error = q('[data-testid="webhook-edit-name-error"]')!;
    expect(error.textContent).toMatch(/^serverErrors\.webhookNameEmpty\{/);
    expect(error.getAttribute('role')).toBe('alert');
    expect(nameInput().getAttribute('aria-invalid')).toBe('true');
    expect(nameInput().getAttribute('aria-describedby')).toBe('webhook-edit-name-error');
    await type(nameInput(), 'CI 2');
    expect(q('[data-testid="webhook-edit-name-error"]')!.textContent).toBe('');
    expect(nameInput().hasAttribute('aria-invalid')).toBe(false);
  });

  it('a name over the limit is refused with the limit in the message', async () => {
    await render();
    // the attribute stops typing past it; a programmatic value does not, the validator does
    expect(nameInput().maxLength).toBe(LIMITS.WEBHOOK_NAME_MAX);
    await type(nameInput(), 'x'.repeat(LIMITS.WEBHOOK_NAME_MAX + 1));
    await click(save());
    expect(onSave).not.toHaveBeenCalled();
    expect(q('[data-testid="webhook-edit-name-error"]')!.textContent).toContain(`serverErrors.webhookNameTooLong`);
    expect(q('[data-testid="webhook-edit-name-error"]')!.textContent).toContain(`"max":${LIMITS.WEBHOOK_NAME_MAX}`);
  });

  it('an unchanged name is not judged: a move alone goes through even under a name the current rule refuses', async () => {
    await render({ webhook: hook({ name: 'x'.repeat(LIMITS.WEBHOOK_NAME_MAX + 5) }) });
    await pick(select(), 'ch-2');
    await click(save());
    expect(onSave.mock.calls[0][0]).toStrictEqual({ channelId: 'ch-2' });
  });
});

describe('WebhookEditDialog — the channel list', () => {
  it('while the targets load: the current channel alone (named from the store), a status line, and a rename still works', async () => {
    await render({ channels: null });
    expect(options()).toEqual([['ch-1', 'webhooks.edit.current{"channel":"#general"}']]);
    expect(select().value).toBe('ch-1');
    const loading = q('[data-testid="webhook-edit-channels-loading"]')!;
    expect(loading.textContent).toBe('webhooks.edit.loadingChannels');
    expect(loading.getAttribute('role')).toBe('status');
    expect(save().disabled).toBe(true);
    await type(nameInput(), 'Nightly');
    await click(save());
    expect(onSave.mock.calls[0][0]).toStrictEqual({ name: 'Nightly' });

    // the answer arrives: the list fills in, the selection stays put
    await render({ channels: TARGETS });
    expect(q('[data-testid="webhook-edit-channels-loading"]')).toBeNull();
    expect(select().value).toBe('ch-1');
    expect(options()).toHaveLength(3);
  });

  it('the current channel absent from the targets is kept first, marked and dimmed; picking it back is no move', async () => {
    await render({ channels: [target('ch-2', 'deploys'), target('ch-3', 'ops')] });
    expect(options()).toEqual([
      ['ch-1', 'webhooks.edit.current{"channel":"#general"}'],
      ['ch-2', '#deploys'],
      ['ch-3', '#ops'],
    ]);
    const current = select().options[0];
    expect(current.getAttribute('data-current')).toBe('true');
    expect(current.className).toContain('text-vox-text-muted');
    expect(current.disabled).toBe(false);
    expect(select().value).toBe('ch-1');
    await pick(select(), 'ch-3');
    expect(save().disabled).toBe(false);
    await pick(select(), 'ch-1');
    expect(save().disabled).toBe(true);
    // a rename keeps it where it is
    await type(nameInput(), 'Nightly');
    await click(save());
    expect(onSave.mock.calls[0][0]).toStrictEqual({ name: 'Nightly' });
  });

  it('a current channel the store does not know (or knows on another server) reads "unknown channel", never its id', async () => {
    await render({ webhook: hook({ channelId: 'ch-x' }), channels: [target('ch-2', 'deploys')] });
    expect(options()[0]).toEqual(['ch-x', 'webhooks.edit.current{"channel":"webhooks.channelMissing"}']);
    await render({ webhook: hook({ channelId: 'ch-gone' }) });
    expect(options()[0]).toEqual(['ch-gone', 'webhooks.edit.current{"channel":"webhooks.channelMissing"}']);
    expect(select().value).toBe('ch-gone');
    expect(select().textContent).not.toContain('ch-gone');
  });

  it('the targets\' own name wins over the store\'s for the current channel', async () => {
    await render({ channels: [target('ch-1', 'general-renamed'), target('ch-2', 'deploys')] });
    expect(options()[0]).toEqual(['ch-1', 'webhooks.edit.current{"channel":"#general-renamed"}']);
  });

  it('a picked channel that leaves the list falls back to the current one (no move), never to another channel, and says so', async () => {
    await render();
    await pick(select(), 'ch-2');
    expect(save().disabled).toBe(false);
    // deleted, the list refetched without it
    await render({ channels: [target('ch-1', 'general'), target('ch-3', 'ops')] });
    expect(select().value).toBe('ch-1');
    expect(save().disabled).toBe(true);
    const note = q('[data-testid="webhook-edit-pick-gone"]')!;
    expect(note.textContent).toBe('webhooks.edit.pickGone');
    expect(note.getAttribute('role')).toBe('status');

    // a rename now is a rename only, and the note stays while the pick is gone
    await type(nameInput(), 'Nightly');
    expect(q('[data-testid="webhook-edit-pick-gone"]')).not.toBeNull();
    await click(save());
    expect(onSave.mock.calls[0][0]).toStrictEqual({ name: 'Nightly' });

    // another pick replaces the lost one
    await pick(select(), 'ch-3');
    expect(q('[data-testid="webhook-edit-pick-gone"]')).toBeNull();
  });

  it('no "gone" note while the list is loading, nor for an untouched channel', async () => {
    await render({ channels: null });
    expect(q('[data-testid="webhook-edit-pick-gone"]')).toBeNull();
    await render({ channels: [target('ch-2', 'deploys')] });
    expect(q('[data-testid="webhook-edit-pick-gone"]')).toBeNull();
  });
});

describe('WebhookEditDialog — the webhook changes under it', () => {
  it("an untouched field follows the list (a fellow moderator's rename or move is never sent back); a touched one keeps the draft", async () => {
    await render();
    await render({ webhook: hook({ name: 'CI v2', channelId: 'ch-2' }) });
    expect(nameInput().value).toBe('CI v2');
    expect(select().value).toBe('ch-2');
    expect(save().disabled).toBe(true);

    await type(nameInput(), 'Mine');
    await render({ webhook: hook({ name: 'CI v3', channelId: 'ch-2' }) });
    expect(nameInput().value).toBe('Mine');
    await click(save());
    expect(onSave.mock.calls[0][0]).toStrictEqual({ name: 'Mine' });
  });

  it('a field typed or picked back to the live value is untouched again: it follows a later rename or move, and Save stays disabled', async () => {
    await render();
    await type(nameInput(), 'CIx');
    await type(nameInput(), 'CI');
    await pick(select(), 'ch-2');
    await pick(select(), 'ch-1');
    expect(save().disabled).toBe(true);

    await render({ webhook: hook({ name: 'CI v2', channelId: 'ch-3' }) });
    expect(nameInput().value).toBe('CI v2');
    expect(select().value).toBe('ch-3');
    expect(save().disabled).toBe(true);
    await submitWithEnter();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('spaces around the name are kept as typed but change nothing, and yield to a later rename', async () => {
    await render();
    await type(nameInput(), 'CI ');
    // the raw value: the space is not swallowed under the cursor
    expect(nameInput().value).toBe('CI ');
    expect(save().disabled).toBe(true);

    await render({ webhook: hook({ name: 'CI v2' }) });
    expect(nameInput().value).toBe('CI v2');
    expect(save().disabled).toBe(true);
    // a move now carries no name
    await pick(select(), 'ch-2');
    await click(save());
    expect(onSave.mock.calls[0][0]).toStrictEqual({ channelId: 'ch-2' });
  });

  it('typing after a fellow moderator\'s rename is judged against that rename: typing the old name back is a change', async () => {
    await render();
    await type(nameInput(), 'CIx');
    await render({ webhook: hook({ name: 'CI v2' }) });
    expect(nameInput().value).toBe('CIx');
    await type(nameInput(), 'CI');
    expect(nameInput().value).toBe('CI');
    expect(save().disabled).toBe(false);
    await click(save());
    expect(onSave.mock.calls[0][0]).toStrictEqual({ name: 'CI' });
  });
});

describe('WebhookEditDialog — closing, busy, a refusal', () => {
  it('Escape closes it; Cancel and the X too', async () => {
    await render();
    await key('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    await click(q('[data-testid="webhook-edit-dialog"] button[aria-label="common.close"]'));
    expect(onClose).toHaveBeenCalledTimes(2);
    const cancel = [...document.body.querySelectorAll('[data-testid="webhook-edit-dialog"] button')].find((b) => b.textContent === 'common.cancel');
    await click(cancel ?? null);
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('busy: the buttons are disabled and Save says so; the fields are frozen without losing focus; neither Escape nor Enter does anything', async () => {
    await render();
    await type(nameInput(), 'Nightly');
    expect(document.activeElement).toBe(nameInput());
    await render({ busy: true });
    expect(save().disabled).toBe(true);
    expect(save().textContent).toBe('webhooks.edit.saving');
    for (const button of document.body.querySelectorAll<HTMLButtonElement>('[data-testid="webhook-edit-dialog"] button')) {
      expect(button.disabled, button.textContent ?? '').toBe(true);
    }
    // read-only, not disabled: the focus stays in the field (a disabled one drops it to <body>)
    expect(nameInput().readOnly).toBe(true);
    expect(nameInput().disabled).toBe(false);
    expect(document.activeElement).toBe(nameInput());
    // the select stays focusable; a change is ignored and the value snaps back
    expect(select().disabled).toBe(false);
    expect(select().getAttribute('aria-disabled')).toBe('true');
    await pick(select(), 'ch-3');
    expect(select().value).toBe('ch-1');
    await key('Escape');
    expect(onClose).not.toHaveBeenCalled();
    await submitWithEnter();
    expect(onSave).not.toHaveBeenCalled();

    await render({ busy: false });
    expect(save().disabled).toBe(false);
    expect(nameInput().readOnly).toBe(false);
    expect(select().hasAttribute('aria-disabled')).toBe(false);
    expect(nameInput().value).toBe('Nightly');
    await click(save());
    expect(onSave.mock.calls[0][0]).toStrictEqual({ name: 'Nightly' });
  });

  it('a refusal brings the focus back to the name field when it fell out of the form (Save was disabled under it), and leaves it alone otherwise', async () => {
    await render();
    await type(nameInput(), 'Nightly');
    await render({ busy: true });
    save().focus();
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    await render({ busy: false, error: 'serverErrors.webhookNotFound' });
    expect(document.activeElement).toBe(nameInput());

    // focus already inside the form: not moved
    select().focus();
    await render({ busy: true, error: null });
    await render({ busy: false, error: 'serverErrors.channelNotFound' });
    expect(document.activeElement).toBe(select());
  });

  it("the server's refusal shows inline as an alert; changing a field dismisses it", async () => {
    await render({ error: 'serverErrors.noPermissionSendMessages' });
    const error = q('[data-testid="webhook-edit-error"]')!;
    expect(error.textContent).toBe('serverErrors.noPermissionSendMessages');
    expect(error.getAttribute('role')).toBe('alert');
    await pick(select(), 'ch-3');
    expect(onDismissError).toHaveBeenCalledTimes(1);
    await type(nameInput(), 'Nightly');
    expect(onDismissError).toHaveBeenCalledTimes(2);

    // without an error on screen, typing asks nothing of the caller
    await render({ error: null });
    await type(nameInput(), 'Nightly 2');
    expect(onDismissError).toHaveBeenCalledTimes(2);
  });

  it('nothing token-shaped is ever rendered, even from a row that carries one', async () => {
    await render({ webhook: { ...hook(), token: 'tok-secret', secret: 'sec-secret' } as Webhook });
    expect(document.body.innerHTML).not.toContain('tok-secret');
    expect(document.body.innerHTML).not.toContain('sec-secret');
  });
});
