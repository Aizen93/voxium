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
