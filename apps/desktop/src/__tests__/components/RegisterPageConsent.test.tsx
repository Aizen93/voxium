import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

/**
 * Two things the registration form has to get right, neither visible from
 * the store's tests:
 *
 *  1. CONSENT (CNIL/GDPR). Two separate boxes, unchecked by default, one per
 *     document, and no submit until both are ticked. The documents open in a
 *     modal so the half-filled form is never navigated away from.
 *  2. AUTOFILL. Password managers hold the LOGIN identifier — the email — as
 *     the saved username, and pasted it into the first text field of this
 *     form (the handle), leaving the email field empty. The fields carry
 *     explicit autocomplete tokens so the browser knows which is which.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});

const register = vi.fn();
vi.mock('../../stores/authStore', () => {
  const state = () => ({
    register,
    cancelRegistration: vi.fn(),
    error: null,
    clearError: vi.fn(),
    isRegistering: false,
    powProgress: null,
  });
  const useAuthStore = <T,>(sel?: (s: ReturnType<typeof state>) => T) =>
    sel ? sel(state()) : state();
  useAuthStore.getState = state;
  return { useAuthStore };
});
vi.mock('../../components/auth/AuthBackground', () => ({ AuthBackground: () => null }));
vi.mock('../../components/auth/PeekingThief', () => ({ PeekingThief: () => null }));

import { RegisterPage } from '../../pages/RegisterPage';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  register.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<MemoryRouter><RegisterPage /></MemoryRouter>);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const byId = <T extends HTMLElement>(id: string) => container.querySelector(`#${id}`) as T;
const submit = () => container.querySelector('button[type="submit"]') as HTMLButtonElement;

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function toggle(el: HTMLInputElement) {
  act(() => { el.click(); });
}

describe('RegisterPage — consent', () => {
  it('renders two separate consent boxes, both UNCHECKED by default', () => {
    const terms = byId<HTMLInputElement>('register-accept-terms');
    const privacy = byId<HTMLInputElement>('register-accept-privacy');
    expect(terms?.type).toBe('checkbox');
    expect(privacy?.type).toBe('checkbox');
    expect(terms.checked).toBe(false);
    expect(privacy.checked).toBe(false);
    expect(terms).not.toBe(privacy);
  });

  it('keeps submit disabled until BOTH boxes are ticked', () => {
    expect(submit().disabled).toBe(true);
    toggle(byId<HTMLInputElement>('register-accept-terms'));
    expect(submit().disabled).toBe(true);
    toggle(byId<HTMLInputElement>('register-accept-privacy'));
    expect(submit().disabled).toBe(false);
    // ...and un-ticking one re-disables it
    toggle(byId<HTMLInputElement>('register-accept-terms'));
    expect(submit().disabled).toBe(true);
  });

  it('sends both flags with the registration, and never registers without them', () => {
    setInput(byId<HTMLInputElement>('register-username'), 'alice');
    setInput(byId<HTMLInputElement>('register-email'), 'a@example.com');
    setInput(byId<HTMLInputElement>('register-password'), 'password123');
    const form = container.querySelector('form')!;

    act(() => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(register).not.toHaveBeenCalled();

    toggle(byId<HTMLInputElement>('register-accept-terms'));
    toggle(byId<HTMLInputElement>('register-accept-privacy'));
    act(() => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(register).toHaveBeenCalledWith('alice', 'a@example.com', 'password123', { acceptTerms: true, acceptPrivacy: true });
  });

  it('opens each document in a modal — the form stays put', () => {
    const links = [...container.querySelectorAll('fieldset button[type="button"]')] as HTMLButtonElement[];
    expect(links).toHaveLength(2);

    act(() => { links[0].click(); });
    expect(container.querySelector('[data-testid="legal-doc-terms"]')).toBeTruthy();
    expect(container.textContent).toContain('Terms of Service');
    // Close on the modal's own button; the typed form is still there
    act(() => { (container.querySelector('[data-testid="legal-doc-terms"] .btn-primary') as HTMLButtonElement).click(); });
    expect(container.querySelector('[data-testid="legal-doc-terms"]')).toBeNull();

    act(() => { links[1].click(); });
    expect(container.querySelector('[data-testid="legal-doc-privacy"]')).toBeTruthy();
    expect(container.textContent).toContain('Privacy Policy');
    expect(container.querySelector('form')).toBeTruthy();
  });
});

describe('RegisterPage — autofill hygiene', () => {
  it('labels every field for the browser: the handle is a nickname, not the saved username', () => {
    // Password managers key saved credentials on the login identifier, which
    // here is the EMAIL. Any field marked (or heuristically read) as the
    // username gets that email pasted in — which is exactly what happened to
    // the handle field, leaving the email field blank.
    const username = byId<HTMLInputElement>('register-username');
    const email = byId<HTMLInputElement>('register-email');
    const password = byId<HTMLInputElement>('register-password');
    expect(username.getAttribute('autocomplete')).toBe('nickname');
    expect(email.getAttribute('autocomplete')).toBe('email');
    expect(password.getAttribute('autocomplete')).toBe('new-password');
    for (const el of [username, email, password]) {
      expect(el.getAttribute('name'), el.id).toBeTruthy();
      expect(container.querySelector(`label[for="${el.id}"]`), `label for ${el.id}`).toBeTruthy();
    }
  });
});
