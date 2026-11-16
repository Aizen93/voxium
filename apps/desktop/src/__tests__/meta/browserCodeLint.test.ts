// @vitest-environment node
// The desktop and admin apps' code runs in a browser, so their src/ outside
// src/**/__tests__/** (what tsconfig.browser.json checks) is linted against
// Node's globals and built-in modules (scripts/lib/eslintBrowserCode.mjs, added
// by each app's eslint.config.js): the editor shows what
// `pnpm typecheck:browser` refuses. Each source string below is linted by
// ESLint with the package's own config, as `pnpm lint` runs it, under the path
// given; the files need not exist.
//
// Every lint here also carries a `debugger;` statement, which the recommended
// rules refuse: a result without that message would mean the path was never
// linted, and an "allowed" answer would prove nothing.
import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const PACKAGES = {
  desktop: join(REPO, 'apps', 'desktop'),
  admin: join(REPO, 'apps', 'admin'),
  server: join(REPO, 'apps', 'server'),
} as const;
type Package = keyof typeof PACKAGES;
type App = Exclude<Package, 'server'>;
const APPS: App[] = ['desktop', 'admin'];

const RULES = new Set(['no-restricted-globals', 'no-restricted-imports']);
// Written out here, not read from the config: the test says what must be refused.
const NODE_ONLY_GLOBALS = [
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
];

const linters = new Map<Package, ESLint>();
function linter(pkg: Package): ESLint {
  let eslint = linters.get(pkg);
  if (!eslint) {
    // All packages' configs load in this one process, as in an editor opened
    // at the repository root: each config names its tsconfigRootDir for that.
    eslint = new ESLint({ cwd: PACKAGES[pkg] });
    linters.set(pkg, eslint);
  }
  return eslint;
}

/** The messages for `code` linted as `path` (relative to the package), checked to have been linted at all. */
async function lint(eslint: ESLint, pkg: Package, path: string, code: string) {
  const [result] = await eslint.lintText(`${code}\ndebugger;\n`, { filePath: join(PACKAGES[pkg], path) });
  expect(result.messages.filter((m) => m.fatal)).toEqual([]);
  expect(result.messages.some((m) => m.ruleId === 'no-debugger')).toBe(true);
  return result.messages;
}

/** The browser-code messages for `code` linted as `path`. */
async function restricted(pkg: Package, path: string, code: string) {
  return (await lint(linter(pkg), pkg, path, code)).filter((m) => m.ruleId !== null && RULES.has(m.ruleId));
}

const GLOBALS_AS_VALUES = [
  'export const a = process.env.NODE_ENV;',
  "export const b = Buffer.from('x');",
  'export const c = __dirname;',
  'export const d = __filename;',
  "export const e = require('x');",
  'export const f = module;',
  'export const g = exports;',
  'export const h = global;',
  'export const i = gc;',
  'export const j = setImmediate(() => undefined);',
  'clearImmediate(j);',
].join('\n');

const NODE_IMPORTS = [
  "import fs from 'node:fs';",
  "import { join } from 'path';",
  "import 'fs/promises';",
  "import type { Server } from 'node:http';",
  "export * from 'node:os';",
  "export { EventEmitter } from 'events';",
  "import { test } from 'node:test';",
  'export { fs, join, test };',
  'export type { Server };',
].join('\n');

const ALLOWED = [
  // a package whose name ends like a built-in, imported statically and lazily
  "import { relaunch } from '@tauri-apps/plugin-process';",
  "import { io } from 'socket.io-client';",
  "export const lazy = () => import('@tauri-apps/plugin-process');",
  // locals and properties named like Node's globals
  'const module = { id: 1 };',
  'export const id = module.id;',
  'const obj = { process: 1, Buffer: 2, require: () => 0, exports: 3, gc: 4 };',
  'export const p = obj.process + obj.Buffer + obj.require() + obj.exports + obj.gc;',
  'export function run(process: string, global: number) { return `${process}${global}`; }',
  // what browser code uses instead
  'export const dev = import.meta.env.DEV;',
  'export const timer: ReturnType<typeof setTimeout> = setTimeout(() => undefined, 0);',
  'export const bytes = new TextEncoder().encode(String(id));',
  'export const diag = (globalThis as { __voxDiag?: () => void }).__voxDiag;',
  'export { relaunch, io };',
].join('\n');

// A test file beside the code is compiled by the browser pass (it excludes
// src/**/__tests__/** only), so it is browser code to the lint as well.
const SOURCE_PATHS: Record<App, string[]> = {
  desktop: ['src/components/chat/Probe.tsx', 'src/services/probe.ts', 'src/workers/probe.worker.ts', 'src/components/Probe.test.tsx'],
  admin: ['src/components/AdminProbe.tsx', 'src/stores/probe.ts', 'src/stores/probe.spec.ts'],
};

const OUTSIDE_PATHS: Record<App, string[]> = {
  // the tests, the test setup, config files, scripts
  desktop: ['src/__tests__/stores/probe.test.ts', 'src/__tests__/setup.ts', 'vite.config.ts', 'scripts/probe.mjs'],
  admin: ['src/__tests__/components/probe.test.tsx', 'vite.config.ts'],
};

describe.each(APPS)('the %s app: browser code', (app) => {
  it.each(SOURCE_PATHS[app])('%s: refuses each Node-only global used as a value', async (path) => {
    const messages = await restricted(app, path, GLOBALS_AS_VALUES);
    expect(messages.map((m) => m.ruleId)).toEqual(NODE_ONLY_GLOBALS.map(() => 'no-restricted-globals'));
    expect(messages.map((m) => /'(\w+)'/.exec(m.message)?.[1])).toEqual(NODE_ONLY_GLOBALS);
    for (const m of messages) {
      expect(m.severity).toBe(2);
      expect(m.message).toContain('runs in a browser');
      expect(m.message).toContain('`pnpm typecheck:browser`');
    }
  }, 60_000);

  it('refuses them through the global object too', async () => {
    const code = ['export const a = globalThis.process;', 'export const b = window.Buffer;', 'export const c = self.require;'].join('\n');
    const messages = await restricted(app, SOURCE_PATHS[app][0], code);
    expect(messages.map((m) => [m.ruleId, m.line])).toEqual([
      ['no-restricted-globals', 1],
      ['no-restricted-globals', 2],
      ['no-restricted-globals', 3],
    ]);
  }, 60_000);

  it('refuses an import or re-export of a Node built-in module, prefixed or bare, a type-only one included', async () => {
    const messages = await restricted(app, SOURCE_PATHS[app][0], NODE_IMPORTS);
    expect(messages.map((m) => [m.ruleId, m.line])).toEqual([1, 2, 3, 4, 5, 6, 7].map((line) => ['no-restricted-imports', line]));
    for (const m of messages) expect(m.message).toContain('`pnpm typecheck:browser`');
  }, 60_000);

  it("refuses every module in the running Node's list, under both its names", async () => {
    const specifiers = [
      ...builtinModules,
      ...builtinModules.filter((name) => !name.startsWith('node:')).map((name) => `node:${name}`),
    ];
    const code = specifiers.map((s) => `import '${s}';`).join('\n');
    const messages = await restricted(app, SOURCE_PATHS[app][0], code);
    expect(messages.filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.line)).toEqual(specifiers.map((_, i) => i + 1));
  }, 60_000);

  it('allows what browser code uses: packages, locals and properties named like Node globals, import.meta, timers', async () => {
    expect(await restricted(app, SOURCE_PATHS[app][0], ALLOWED)).toEqual([]);
  }, 60_000);

  it.each(OUTSIDE_PATHS[app])('%s: is not browser code, and nothing is refused', async (path) => {
    // a JavaScript file gets the imports without their TypeScript-only lines
    const imports = /\.[cm]?jsx?$/.test(path)
      ? NODE_IMPORTS.split('\n').filter((line) => !/\btype\b/.test(line)).join('\n')
      : NODE_IMPORTS;
    expect(await restricted(app, path, `${GLOBALS_AS_VALUES}\n${imports}`)).toEqual([]);
  }, 60_000);
});

describe('the server', () => {
  it('runs on Node: its code may use Node, and nothing is refused', async () => {
    expect(await restricted('server', 'src/routes/probe.ts', `${GLOBALS_AS_VALUES}\n${NODE_IMPORTS}`)).toEqual([]);
  }, 60_000);
});

// Before each config named its tsconfigRootDir, linting a desktop file and then
// a server file in one process failed to parse the second ("multiple candidate
// TSConfigRootDirs"). Every order of the three packages, each with fresh linters.
const ORDERS: Package[][] = [
  ['desktop', 'admin', 'server'],
  ['desktop', 'server', 'admin'],
  ['admin', 'desktop', 'server'],
  ['admin', 'server', 'desktop'],
  ['server', 'desktop', 'admin'],
  ['server', 'admin', 'desktop'],
];
const PROBE: Record<Package, string> = { desktop: 'src/probe.ts', admin: 'src/probe.ts', server: 'src/probe.ts' };

describe('the three linted packages in one process', () => {
  it.each(ORDERS.map((order) => [order.join(' → '), order] as const))('lint in the order %s', async (_, order) => {
    for (const pkg of order) {
      const eslint = new ESLint({ cwd: PACKAGES[pkg] });
      await lint(eslint, pkg, PROBE[pkg], 'export const typed: number = 1;');
    }
  }, 60_000);
});
