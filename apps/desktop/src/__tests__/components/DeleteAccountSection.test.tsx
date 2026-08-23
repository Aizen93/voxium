import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import axios from 'axios';

/**
 * Self-service deletion is the one irreversible action in settings. Three
 * things must stand between the button and the call: the password, the TOTP
 * code when 2FA is on, and the typed confirmation word — and a 409 listing
 * owned servers must be shown as guidance, not as a generic failure.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string, o?: Record<string, string>) => (o?.word ? `${k}:${o.word}` : k) }) };
});

const deleteAccount = vi.fn();
const state = vi.hoisted(() => ({ user: { id: 'u-1', totpEnabled: false } as { id: string; totpEnabled: boolean } }));
vi.mock('../../stores/authStore', () => {
  const get = () => ({ user: state.user, deleteAccount });
  const useAuthStore = <T,>(sel?: (s: ReturnType<typeof get>) => T) => (sel ? sel(get()) : get());
  useAuthStore.getState = get;
  return { useAuthStore };
});

import { DeleteAccountSection } from '../../components/settings/DeleteAccountSection';

let container: HTMLDivElement;
let root: Root;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(<DeleteAccountSection />); });
}

beforeEach(() => {
  deleteAccount.mockReset().mockResolvedValue(undefined);
  state.user = { id: 'u-1', totpEnabled: false };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const byId = <T extends HTMLElement>(id: string) => container.querySelector(`#${id}`) as T;
const confirmBtn = () => container.querySelector('[data-testid="delete-account-confirm"]') as HTMLButtonElement;

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
function open() {
  act(() => { (container.querySelector('[data-testid="delete-account-open"]') as HTMLButtonElement).click(); });
}
async function submit() {
  await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}

describe('DeleteAccountSection', () => {
  it('is collapsed behind a button — no form, no call, until opened', () => {
    render();
    expect(container.querySelector('form')).toBeNull();
    open();
    expect(container.querySelector('form')).toBeTruthy();
    expect(confirmBtn().disabled).toBe(true);
  });

  it('requires the password AND the exact confirmation word', async () => {
    render();
    open();
    setInput(byId('delete-account-password'), 'hunter2');
    expect(confirmBtn().disabled).toBe(true);
    setInput(byId('delete-account-confirm'), 'delete');
    expect(confirmBtn().disabled).toBe(true); // wrong case
    await submit();
    expect(deleteAccount).not.toHaveBeenCalled();

    setInput(byId('delete-account-confirm'), 'settings.deleteAccount.confirmWord');
    expect(confirmBtn().disabled).toBe(false);
    await submit();
    expect(deleteAccount).toHaveBeenCalledWith('hunter2', undefined);
  });

  it('asks for the TOTP code when two-factor authentication is enabled, and sends it', async () => {
    state.user = { id: 'u-1', totpEnabled: true };
    render();
    open();
    setInput(byId('delete-account-password'), 'hunter2');
    setInput(byId('delete-account-confirm'), 'settings.deleteAccount.confirmWord');
    expect(byId('delete-account-totp')).toBeTruthy();
    expect(confirmBtn().disabled).toBe(true);

    setInput(byId('delete-account-totp'), '123456');
    expect(confirmBtn().disabled).toBe(false);
    await submit();
    expect(deleteAccount).toHaveBeenCalledWith('hunter2', '123456');
  });

  it('shows the servers the account still owns when the server answers 409', async () => {
    const err = new axios.AxiosError('conflict', '409', undefined, undefined, {
      status: 409, statusText: 'Conflict', headers: {}, config: { headers: new axios.AxiosHeaders() },
      data: { success: false, error: 'Transfer or delete', data: { ownedServers: [{ id: 's-1', name: 'My Guild' }] } },
    });
    deleteAccount.mockRejectedValueOnce(err);
    render();
    open();
    setInput(byId('delete-account-password'), 'hunter2');
    setInput(byId('delete-account-confirm'), 'settings.deleteAccount.confirmWord');
    await submit();

    const box = container.querySelector('[data-testid="delete-account-owned-servers"]');
    expect(box).toBeTruthy();
    expect(box!.textContent).toContain('My Guild');
    // and the form is still there to retry after the transfer
    expect(container.querySelector('form')).toBeTruthy();
    expect(confirmBtn().disabled).toBe(false);
  });

  it('surfaces any other failure and stays open', async () => {
    deleteAccount.mockRejectedValueOnce(new Error('Password is incorrect'));
    render();
    open();
    setInput(byId('delete-account-password'), 'wrong');
    setInput(byId('delete-account-confirm'), 'settings.deleteAccount.confirmWord');
    await submit();
    expect(container.textContent).toContain('Password is incorrect');
    expect(container.querySelector('form')).toBeTruthy();
  });
});
