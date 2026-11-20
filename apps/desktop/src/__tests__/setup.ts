/**
 * jsdom gaps that every component test would otherwise have to paper over.
 *
 * These are NOT product shims — the real browser and the Tauri webview both
 * implement all of them. Stubbing here keeps the components free of defensive
 * code written purely to satisfy the test environment.
 */

// Scroll-into-view: used by the server rail and the switcher to keep the active
// row visible. jsdom has no layout, so it does not implement it at all.
// Guarded on Element existing at all: several suites opt into a node
// environment (`@vitest-environment node`) for the wasm engine, and a setup
// file runs for every suite regardless of which environment it chose.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// ResizeObserver: the rail measures its own overflow with one. Components that
// use it already guard on `typeof ResizeObserver === 'undefined'`, but tests
// that DO want it observed need something callable.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// Web Storage in the node-environment suites: none, on every Node line. Node 25+
// puts its own localStorage, sessionStorage and Storage on globalThis, and what
// they hold differs by line (absent on 24; on 26 localStorage is a getter that
// reads undefined and prints an ExperimentalWarning without --localstorage-file),
// so the same suite would take a different path on each leg of the CI matrix.
// Removing them gives every line what Node 24 gives. The check is on the
// descriptor, never the value: reading Node 26's getter is what prints the
// warning. jsdom suites (window defined) keep jsdom's storage, see
// meta/jsdomStorage.test.ts; meta/nodeEnvironmentStorage.test.ts fails if a Node
// ever keeps one of these globals.
if (typeof window === 'undefined') {
  for (const key of ['localStorage', 'sessionStorage', 'Storage'] as const) {
    if (Object.getOwnPropertyDescriptor(globalThis, key)) Reflect.deleteProperty(globalThis, key);
  }
}

// BroadcastChannel: Node's, which the jsdom suites see on `window` too. It
// reaches every other channel of the same name in the process, so two suites
// (or two module copies) would talk to each other through the vault
// ownership's channel (services/e2e/vaultOwnership.ts). The suites that test
// the channel inject one of their own; every other suite runs without it,
// as a page with no other tab.
if (Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel')) {
  Reflect.deleteProperty(globalThis, 'BroadcastChannel');
}
