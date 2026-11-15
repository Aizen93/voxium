// @vitest-environment node
// The node-environment suites run without Web Storage on every Node line: the
// setup file removes the localStorage, sessionStorage and Storage globals Node
// 25+ defines, so a suite takes the same path on Node 24 and 26. If a Node ever
// keeps one of them (a global that cannot be deleted), this fails rather than
// letting the CI legs drift apart again. Descriptors only: reading Node 26's
// localStorage getter is what prints its ExperimentalWarning.
import { describe, it, expect } from 'vitest';

describe('Web Storage in the node environment', () => {
  it('runs without a window', () => {
    expect(typeof window).toBe('undefined');
  });

  it.each(['localStorage', 'sessionStorage', 'Storage'] as const)('%s is not defined', (key) => {
    expect(Object.getOwnPropertyDescriptor(globalThis, key)).toBeUndefined();
  });
});
