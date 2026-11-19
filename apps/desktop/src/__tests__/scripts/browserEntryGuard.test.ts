import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { browserEntryGuard, isTauriModule, tauriModulesAtStartup, type GuardedChunk } from '../../../scripts/browserEntryGuard.mjs';

// The desktop client is one bundle for the Tauri app and for the browser. No
// browser session may download Tauri code: every @tauri-apps/* module is
// loaded with import() on a Tauri-only path, and the production build fails
// when a chunk the browser loads at startup holds one.

// __dirname, not import.meta.url: under the jsdom environment the latter is
// the page's http URL, not a file URL
const DESKTOP = resolve(__dirname, '../../..');
const SRC = join(DESKTOP, 'src');

const PNPM = 'C:/repo/node_modules/.pnpm';
const CORE = `${PNPM}/@tauri-apps+api@2.12.4/node_modules/@tauri-apps/api/core.js`;
const PLUGIN = `${PNPM}/@tauri-apps+plugin-notification@2.8.1/node_modules/@tauri-apps/plugin-notification/dist-js/index.js`;
const REACT = `${PNPM}/react@19.3.1/node_modules/react/index.js`;

function chunk(fileName: string, moduleIds: string[], options: { isEntry?: boolean; imports?: string[] } = {}): GuardedChunk {
  return { type: 'chunk', fileName, isEntry: options.isEntry ?? false, imports: options.imports ?? [], moduleIds };
}

function bundleOf(...chunks: GuardedChunk[]) {
  return Object.fromEntries([...chunks.map((c) => [c.fileName, c]), ['index.css', { type: 'asset' as const, fileName: 'index.css' }]]);
}

describe('isTauriModule', () => {
  it('is a module of a @tauri-apps package, under node_modules, with either separator', () => {
    for (const id of [CORE, PLUGIN, CORE.replace(/\//g, '\\'), '/repo/node_modules/@tauri-apps/api/window.js']) {
      expect(isTauriModule(id), id).toBe(true);
    }
    for (const id of [REACT, 'C:/repo/apps/desktop/src/services/notifications.ts', '/repo/src/@tauri-apps/x.js', '/repo/node_modules/not-@tauri-apps/x.js', '\0vite/preload-helper.js', undefined]) {
      expect(isTauriModule(id), String(id)).toBe(false);
    }
  });
});

describe('tauriModulesAtStartup', () => {
  it('finds Tauri code in an entry chunk', () => {
    expect(tauriModulesAtStartup(bundleOf(chunk('index.js', ['/src/main.tsx', CORE], { isEntry: true })))).toEqual([CORE]);
  });

  it('finds it in a chunk the entry imports statically, however deep', () => {
    const bundle = bundleOf(
      chunk('index.js', ['/src/main.tsx'], { isEntry: true, imports: ['a.js'] }),
      chunk('a.js', ['/src/a.ts'], { imports: ['b.js'] }),
      chunk('b.js', ['/src/b.ts', PLUGIN, CORE]),
    );
    expect(tauriModulesAtStartup(bundle)).toEqual([CORE, PLUGIN].sort());
  });

  it('leaves a chunk reached only through import() alone', () => {
    const bundle = bundleOf(
      chunk('index.js', ['/src/main.tsx', REACT], { isEntry: true, imports: ['shared.js'] }),
      chunk('shared.js', ['/src/shared.ts'], { imports: ['index.js'] }),
      chunk('core.js', [CORE]),
      chunk('plugin.js', [PLUGIN], { imports: ['core.js'] }),
    );
    expect(tauriModulesAtStartup(bundle)).toEqual([]);
  });

  it('reads the modules record when a chunk lists no module ids', () => {
    const entry = { type: 'chunk' as const, fileName: 'index.js', isEntry: true, imports: [], modules: { [CORE]: {}, '/src/main.tsx': {} } };
    expect(tauriModulesAtStartup({ 'index.js': entry })).toEqual([CORE]);
  });
});

describe('the build plugin', () => {
  it('runs on production builds and fails one whose startup chunks hold Tauri code, naming the packages', () => {
    const plugin = browserEntryGuard();
    expect(plugin.apply).toBe('build');
    const errors: string[] = [];
    const context = {
      error(message: string): never {
        errors.push(message);
        throw new Error(message);
      },
    };
    const clean = bundleOf(chunk('index.js', ['/src/main.tsx'], { isEntry: true }), chunk('core.js', [CORE]));
    plugin.generateBundle.call(context, {}, clean);
    expect(errors).toEqual([]);

    const dirty = bundleOf(chunk('index.js', ['/src/main.tsx', CORE, PLUGIN], { isEntry: true }));
    expect(() => plugin.generateBundle.call(context, {}, dirty)).toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('@tauri-apps/api, @tauri-apps/plugin-notification');
  });

  it('is registered in vite.config.ts', () => {
    const config = readFileSync(join(DESKTOP, 'vite.config.ts'), 'utf8');
    expect(config).toContain("import { browserEntryGuard } from './scripts/browserEntryGuard.mjs';");
    expect(config).toMatch(/plugins: \[[^\]]*browserEntryGuard\(\)[^\]]*\]/);
  });
});

describe('no app source imports a Tauri module statically', () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return entry === '__tests__' ? [] : sources(path);
      return /\.(?:ts|tsx|js|jsx|mjs)$/.test(entry) ? [path] : [];
    });
  }

  /** Static imports and re-exports of @tauri-apps/* (a type-only import is erased, and allowed). */
  const STATIC = [
    /(?:^|[\n;])\s*import\s+(?!type\s)[^'";]*?\bfrom\s*['"]@tauri-apps\//,
    /(?:^|[\n;])\s*import\s*['"]@tauri-apps\//,
    /(?:^|[\n;])\s*export\s+(?!type\s)[^'";]*?\bfrom\s*['"]@tauri-apps\//,
    /\brequire\(\s*['"]@tauri-apps\//,
  ];
  const isStatic = (text: string) => STATIC.some((re) => re.test(text));

  it('the scan sees every form of static import, and lets import() and type imports through', () => {
    for (const text of [
      "import { invoke } from '@tauri-apps/api/core';",
      'import {\n  isPermissionGranted,\n  sendNotification,\n} from "@tauri-apps/plugin-notification";',
      "import * as core from '@tauri-apps/api/core';",
      "import '@tauri-apps/api/core';",
      "export { invoke } from '@tauri-apps/api/core';",
      "const x = 1; import core from '@tauri-apps/api/core'",
    ]) {
      expect(isStatic(text), text).toBe(true);
    }
    for (const text of [
      "const { invoke } = await import('@tauri-apps/api/core');",
      "const load = () => import('@tauri-apps/plugin-opener');",
      "import type { Update } from '@tauri-apps/plugin-updater';",
      "type Core = typeof import('@tauri-apps/api/core');",
      "// see '@tauri-apps/api/core'",
    ]) {
      expect(isStatic(text), text).toBe(false);
    }
  });

  it('holds for every file under src outside the tests', () => {
    const offenders = sources(SRC)
      .filter((path) => isStatic(readFileSync(path, 'utf8')))
      .map((path) => path.slice(SRC.length + 1).replace(/\\/g, '/'));
    expect(offenders).toEqual([]);
  });
});
