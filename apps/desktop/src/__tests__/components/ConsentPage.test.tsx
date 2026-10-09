import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The gate an EXISTING account sees when it predates consent-at-signup. Same
 * rules as the registration form: two separate boxes, unchecked, nothing
 * submits until both are ticked, and the only other way out is logging out.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

const acceptConsent = vi.fn();
const logout = vi.fn();
vi.mock('../../stores/authStore', () => {
  const state = () => ({ acceptConsent, logout });
  const useAuthStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) =>
    sel ? sel(state()) : state();
  useAuthStore.getState = state;
  return { useAuthStore };
});

import { ConsentPage } from '../../pages/ConsentPage';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  acceptConsent.mockReset().mockResolvedValue(undefined);
  logout.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(<ConsentPage />); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const byId = <T extends HTMLElement>(id: string) => container.querySelector(`#${id}`) as T;
const submit = () => container.querySelector('button[type="submit"]') as HTMLButtonElement;
const toggle = (el: HTMLInputElement) => act(() => { el.click(); });

describe('ConsentPage', () => {
  it('starts with both boxes unchecked and submit disabled', () => {
    expect(byId<HTMLInputElement>('consent-accept-terms').checked).toBe(false);
    expect(byId<HTMLInputElement>('consent-accept-privacy').checked).toBe(false);
    expect(submit().disabled).toBe(true);
  });

  it('submits both acceptances only once both are ticked', async () => {
    const form = container.querySelector('form')!;
    toggle(byId<HTMLInputElement>('consent-accept-terms'));
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(acceptConsent).not.toHaveBeenCalled();

    toggle(byId<HTMLInputElement>('consent-accept-privacy'));
    expect(submit().disabled).toBe(false);
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(acceptConsent).toHaveBeenCalledWith({ acceptTerms: true, acceptPrivacy: true });
  });

  it('shows the failure and lets the user retry when the server refuses', async () => {
    acceptConsent.mockRejectedValueOnce(new Error('network'));
    toggle(byId<HTMLInputElement>('consent-accept-terms'));
    toggle(byId<HTMLInputElement>('consent-accept-privacy'));
    const form = container.querySelector('form')!;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });

    // The error banner renders whatever getTranslatedError produced (the
    // server's message when it has one, the fallback key otherwise)
    expect(container.textContent).toContain('network');
    expect(submit().disabled).toBe(false);
  });

  it('offers logout as the only other way out', () => {
    const buttons = [...container.querySelectorAll('button')];
    const logoutBtn = buttons.find((b) => b.textContent?.includes('common.logout'))!;
    act(() => { logoutBtn.click(); });
    expect(logout).toHaveBeenCalled();
  });

  it('opens the documents in a modal without leaving the gate', () => {
    const links = [...container.querySelectorAll('fieldset button[type="button"]')] as HTMLButtonElement[];
    act(() => { links[1].click(); });
    expect(container.querySelector('[data-testid="legal-doc-privacy"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="consent-gate"]')).toBeTruthy();
  });
});
