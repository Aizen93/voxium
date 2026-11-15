// The jsdom suites must see jsdom's Web Storage, never Node's. Node 25+ defines
// localStorage, sessionStorage and Storage on globalThis itself, and vitest 4's
// jsdom environment left Node's in place (measured with vitest 4.1.12 on Node
// 26.13.0): localStorage read undefined, since the process had no
// --localstorage-file, and sessionStorage was Node's own in-memory store, which
// a write-then-read alone cannot tell from jsdom's, hence the identity checks.
// The config used to turn Node's Web Storage off for that; vitest 5 installs
// jsdom's over Node's, so it no longer does, and this file fails if that ever
// stops being true. No environment pragma: it runs under the config's own
// environment, like every suite it stands for.
import { describe, it, expect } from 'vitest';

interface JsdomWindow {
  localStorage: Storage;
  sessionStorage: Storage;
  Storage: typeof Storage;
}

// vitest's jsdom environment exposes the JSDOM instance it built as `jsdom`.
const dom = (globalThis as { jsdom?: { window: JsdomWindow } }).jsdom;

describe('Web Storage in the jsdom environment', () => {
  it('runs under vitest\'s jsdom environment', () => {
    expect(dom).toBeDefined();
  });

  it.each(['localStorage', 'sessionStorage'] as const)('%s is the jsdom window\'s own', (name) => {
    const win = dom!.window;
    expect(globalThis[name]).toBe(win[name]);
    expect(Object.getPrototypeOf(globalThis[name]).constructor).toBe(win.Storage);
    expect(globalThis.Storage).toBe(win.Storage);
  });

  it.each(['localStorage', 'sessionStorage'] as const)('%s keeps what is written to it', (name) => {
    const store = globalThis[name];
    store.setItem('voxium-probe', 'stored');
    expect(store.getItem('voxium-probe')).toBe('stored');
    store.removeItem('voxium-probe');
    expect(store.getItem('voxium-probe')).toBeNull();
  });
});
