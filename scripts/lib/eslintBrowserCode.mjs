// The lint rules for the code that runs in a browser: the desktop and admin
// apps' src/ outside src/**/__tests__/**, the files tsconfig.browser.json
// checks there. Each app's eslint.config.js adds this object.
//
// That code is compiled a second time without Node's types
// (tsconfig.browser.json, `pnpm typecheck:browser`, which `pnpm typecheck` and
// CI run); these rules show the same mistake in the editor, as it is written.
// They cover part of what that pass refuses: a Node-only global used as a value
// (`process.env`, `Buffer.from`, through `globalThis`, `window` or `self` too)
// and a static import or re-export of a Node built-in module, `node:` or bare.
// A Node type in a type position (`: Buffer`, `NodeJS.Timeout`) and a dynamic
// `import()` are left to the compiler.
//
// A later config object that sets `no-restricted-globals` or
// `no-restricted-imports` for the same files replaces these options instead of
// adding to them: extend the lists here instead.

import { builtinModules } from 'node:module';

const MESSAGE =
  'This code runs in a browser, which has no Node API: use a browser API instead (`pnpm typecheck:browser` refuses this too).';

/**
 * The value globals Node's types declare and the DOM and ES libraries do not
 * (the ES2024 ones @types/node also declares, such as DisposableStack, exist in
 * browsers and are not here).
 */
export const NODE_ONLY_GLOBALS = Object.freeze([
  'process',
  'Buffer',
  '__dirname',
  '__filename',
  'require',
  'module',
  'exports',
  'global',
  'gc',
  'setImmediate',
  'clearImmediate',
]);

/**
 * The built-in modules that can be imported without the `node:` prefix (the
 * prefixed form of every built-in is refused by one pattern), from the running
 * Node's own list, so a module a later Node adds is refused too.
 */
export const BARE_NODE_BUILTINS = Object.freeze(builtinModules.filter((name) => !name.startsWith('node:')).sort());

/** @type {import('eslint').Linter.Config} */
export const browserCodeConfig = {
  name: 'voxium/browser-code',
  files: ['src/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
  // the same exclusion as tsconfig.browser.json's
  ignores: ['src/**/__tests__/**'],
  // Declared so that `checkGlobalObject` sees `window.process` and `self.Buffer`
  // (`globalThis` is a global of the language itself).
  languageOptions: { globals: { window: 'readonly', self: 'readonly' } },
  rules: {
    'no-restricted-globals': [
      'error',
      {
        globals: NODE_ONLY_GLOBALS.map((name) => ({ name, message: MESSAGE })),
        checkGlobalObject: true,
      },
    ],
    'no-restricted-imports': [
      'error',
      {
        paths: BARE_NODE_BUILTINS.map((name) => ({ name, message: MESSAGE })),
        patterns: [{ regex: '^node:', message: MESSAGE }],
      },
    ],
  },
};
