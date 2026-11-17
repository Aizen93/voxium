import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * A small harness for the component suites: it mounts into `document.body`
 * and finds elements by ARIA role and accessible name, the way a user (or a
 * screen reader) meets them. @testing-library is not a dependency of the
 * admin app, so the few queries the suites need live here.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROLE_SELECTORS: Record<string, string> = {
  button: 'button, [role="button"], input[type="button"], input[type="submit"]',
  textbox: 'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"]',
  combobox: 'select',
  checkbox: 'input[type="checkbox"], [role="checkbox"]',
  heading: 'h1, h2, h3, h4, h5, h6',
  row: 'tr',
  cell: 'td',
  option: 'option',
};

function normalise(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** The elements a <label> can label (HTML "labelable elements" that a screen reader announces by label). */
const LABELABLE = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'METER', 'PROGRESS', 'OUTPUT']);

/** Hidden from assistive technology: the `hidden` attribute or aria-hidden="true", on the element or an ancestor. */
function isHiddenFromAT(el: Element): boolean {
  return el.closest('[hidden], [aria-hidden="true"]') !== null;
}

/**
 * The accessible name of an element: a simplified reading of the accessible-name rules, covering
 * only what the app uses. The order is
 *   1. aria-labelledby (the text of the elements it names)
 *   2. aria-label
 *   3. <label for="id">
 *   4. a wrapping <label>, for form controls only (never a button or a link inside a label)
 *   5. the element's text content, for everything but form controls (a textarea's text is its
 *      value, a select's is its options: neither is a name)
 *   6. title
 *   7. placeholder, last
 */
export function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    if (normalise(text)) return normalise(text);
  }
  const aria = el.getAttribute('aria-label');
  if (aria) return normalise(aria);
  const isFormControl = LABELABLE.has(el.tagName);
  if (isFormControl) {
    if (el.id) {
      const label = document.querySelector(`label[for="${el.id}"]`);
      if (label) return normalise(label.textContent);
    }
    const wrapping = el.closest('label');
    if (wrapping) {
      // The label's own words: not the value of a textarea or the options of a select inside it
      const copy = wrapping.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('textarea, select').forEach((control) => control.remove());
      return normalise(copy.textContent);
    }
  } else {
    const text = normalise(el.textContent);
    if (text) return text;
  }
  const title = el.getAttribute('title');
  if (title) return normalise(title);
  return normalise(el.getAttribute('placeholder'));
}

type Name = string | RegExp;
const matches = (actual: string, wanted: Name) => (typeof wanted === 'string' ? actual === wanted : wanted.test(actual));

export function queryAllByRole(role: string, name?: Name): HTMLElement[] {
  const selector = ROLE_SELECTORS[role] ?? `[role="${role}"]`;
  return (Array.from(document.body.querySelectorAll(selector)) as HTMLElement[])
    .filter((el) => !isHiddenFromAT(el))
    .filter((el) => name === undefined || matches(accessibleName(el), name));
}

export function getByRole(role: string, name?: Name): HTMLElement {
  const found = queryAllByRole(role, name);
  if (found.length !== 1) {
    const all = queryAllByRole(role).map((el) => `"${accessibleName(el)}"`).join(', ');
    throw new Error(`Expected exactly one ${role} named ${String(name)}, found ${found.length}. ${role}s present: ${all}`);
  }
  return found[0];
}

export const queryByRole = (role: string, name?: Name): HTMLElement | null => queryAllByRole(role, name)[0] ?? null;

/** The element whose own text is exactly (or matches) `text`; the innermost one. */
export function queryByText(text: Name): HTMLElement | null {
  const all = Array.from(document.body.querySelectorAll('*')) as HTMLElement[];
  const hits = all.filter((el) => matches(normalise(el.textContent), text) && !Array.from(el.children).some((c) => matches(normalise(c.textContent), text)));
  return hits[0] ?? null;
}

export function bodyText(): string {
  return normalise(document.body.textContent);
}

export interface Mounted {
  root: Root;
  container: HTMLDivElement;
  render: (ui: ReactElement) => Promise<void>;
  unmount: () => void;
}

export function mount(): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return {
    root,
    container,
    render: async (ui) => { await act(async () => { root.render(ui); }); },
    unmount: () => { act(() => root.unmount()); container.remove(); },
  };
}

/** Let pending promise continuations (store actions, effects) settle inside act. */
export async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
}

export async function click(el: Element): Promise<void> {
  await act(async () => { (el as HTMLElement).click(); });
}

export async function keyDown(el: Element, key: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); });
}

/** Type into a controlled input or textarea the way React sees it. */
export async function type(el: HTMLElement, value: string): Promise<void> {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export async function choose(select: HTMLElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** A promise settled from outside, to hold a store action "in flight". */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

