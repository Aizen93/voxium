// @vitest-environment node
// Pure filesystem check: the repository compiles with ONE TypeScript, and the
// settings the move to TypeScript 6 had to write down stay written down.
// TypeScript 6 includes no @types package a tsconfig does not name and refuses
// the Node 10 module resolution, so every tsconfig of every workspace package
// names its `types` (each one a dependency its own package declares, not one
// found through hoisting) and resolves modules another way. The server stays
// on CommonJS output: its dynamic imports name files without an extension,
// which Node's own module settings would refuse and emit differently.
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const read = (p: string) => readFileSync(join(REPO, p), 'utf8').replace(/\r\n/g, '\n');

type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
type CompilerOptions = { types?: string[]; module?: string; moduleResolution?: string; customConditions?: string[] };
type Tsconfig = { extends?: string | string[]; compilerOptions?: CompilerOptions };

/** A tsconfig is JSON with comments and trailing commas: drop both, outside strings. */
function parseJsonc<T>(text: string): T {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else if (c === '}' || c === ']') {
      out = out.replace(/,\s*$/, '') + c;
    } else {
      out += c;
    }
  }
  return JSON.parse(out) as T;
}

/** The directories pnpm-workspace.yaml names that hold a manifest. */
function workspacePackages(): string[] {
  const list = /^packages:\n((?:[ \t]+-[^\n]*\n)+)/m.exec(read('pnpm-workspace.yaml'));
  if (!list) throw new Error('pnpm-workspace.yaml: no "packages:" list');
  const dirs: string[] = [];
  for (const [, glob] of list[1].matchAll(/-[ \t]*["']?([^"'\n#]+?)["']?[ \t]*(?:#.*)?$/gm)) {
    const parent = glob.endsWith('/*') ? glob.slice(0, -2) : null;
    if ((parent ?? glob).includes('*')) {
      throw new Error(`pnpm-workspace.yaml: this test reads "dir/*" and plain directories, not "${glob}"`);
    }
    if (parent === null) dirs.push(glob);
    else if (existsSync(join(REPO, parent))) {
      for (const entry of readdirSync(join(REPO, parent), { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(`${parent}/${entry.name}`);
      }
    }
  }
  return dirs.filter((dir) => existsSync(join(REPO, dir, 'package.json'))).sort();
}

const PACKAGES = workspacePackages();

const manifest = (dir: string) => JSON.parse(read(join(dir, 'package.json'))) as Manifest;
const declared = (dir: string) => ({ ...manifest(dir).dependencies, ...manifest(dir).devDependencies });

/** Every `tsconfig.json` and `tsconfig.<name>.json` of one package, as paths from the repository root. */
function tsconfigsOf(dir: string): string[] {
  return readdirSync(join(REPO, dir))
    .filter((name) => /^tsconfig(\.[^/]+)?\.json$/.test(name))
    .map((name) => `${dir}/${name}`)
    .sort();
}

const TSCONFIGS = PACKAGES.flatMap((dir) => tsconfigsOf(dir).map((file) => ({ dir, file })));

function extendedFile(from: string, target: string): string {
  if (target.startsWith('.')) {
    const path = resolve(dirname(from), target);
    return existsSync(path) ? path : `${path}.json`;
  }
  // A package: the file it names, or (the way tsc reads a name without `.json`) that name with it, then its tsconfig.json.
  const require = createRequire(from);
  let reason = '';
  for (const candidate of target.endsWith('.json') ? [target] : [`${target}.json`, `${target}/tsconfig.json`]) {
    try {
      return require.resolve(candidate);
    } catch (err) {
      reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
    }
  }
  throw new Error(`${from}: cannot find the tsconfig it extends, "${target}" (${reason})`);
}

/** The compiler options a tsconfig ends up with, its `extends` chain applied the way tsc applies it. */
function compilerOptions(file: string, chain: string[] = []): CompilerOptions {
  const path = resolve(REPO, file);
  if (chain.includes(path)) throw new Error(`${file}: "extends" leads back to itself`);
  const config = parseJsonc<Tsconfig>(readFileSync(path, 'utf8'));
  let inherited: CompilerOptions = {};
  for (const target of [config.extends ?? []].flat()) {
    inherited = { ...inherited, ...compilerOptions(extendedFile(path, target), [...chain, path]) };
  }
  return { ...inherited, ...config.compilerOptions };
}

/** The package a `types` entry comes from: `node` → `@types/node`, `vite/client` → `vite`. */
function declares(dir: string, typesEntry: string): boolean {
  const all = declared(dir);
  const own = typesEntry.startsWith('@') ? typesEntry.split('/').slice(0, 2).join('/') : typesEntry.split('/')[0];
  return `@types/${typesEntry}` in all || own in all;
}

describe('TypeScript toolchain', () => {
  it('finds the workspace packages and their tsconfig files', () => {
    // A discovery that silently found nothing would make every check below pass.
    expect(PACKAGES).toEqual(expect.arrayContaining(['apps/admin', 'apps/desktop', 'apps/server', 'packages/shared']));
    expect(TSCONFIGS.map((t) => t.file)).toEqual(
      expect.arrayContaining(['apps/admin/tsconfig.json', 'apps/desktop/tsconfig.json', 'apps/server/tsconfig.json', 'packages/shared/tsconfig.json']),
    );
  });

  it('every manifest that declares TypeScript declares the same range, and a package with a tsconfig declares it', () => {
    const ranges = ['.', ...PACKAGES]
      .map((dir) => ({ dir, range: declared(dir).typescript }))
      .filter((entry) => entry.range !== undefined);
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges[0].range, ranges[0].dir).toMatch(/^\^\d+\.\d+\.\d+$/);
    for (const { dir, range } of ranges) expect(range, dir).toBe(ranges[0].range);
    for (const dir of PACKAGES) {
      if (tsconfigsOf(dir).length > 0) expect(declared(dir).typescript, `${dir} has a tsconfig`).toBeDefined();
    }
  });

  it('the lockfile resolves TypeScript to one version for every package that declares it', () => {
    const lock = read('pnpm-lock.yaml');
    const importers = lock.slice(lock.indexOf('\nimporters:\n'), lock.indexOf('\npackages:\n'));
    const resolved = [...importers.matchAll(/^ {6}typescript:\n {8}specifier: [^\n]+\n {8}version: ([^\n(]+)/gm)].map((m) => m[1].trim());
    const declaring = ['.', ...PACKAGES].filter((dir) => declared(dir).typescript !== undefined);
    // As many entries as manifests declaring it, or this pattern no longer reads the lockfile.
    expect(resolved).toHaveLength(declaring.length);
    expect([...new Set(resolved)]).toHaveLength(1);
  });

  it('every tsconfig names its type packages, and its package declares each of them', () => {
    for (const { dir, file } of TSCONFIGS) {
      const { types } = compilerOptions(file);
      expect(Array.isArray(types), `${file}: compilerOptions.types`).toBe(true);
      for (const entry of types ?? []) {
        expect(declares(dir, entry), `${dir}/package.json declares the package of "${entry}" (${file})`).toBe(true);
      }
    }
  });

  it('no tsconfig resolves modules the Node 10 way, or leaves the choice to a default', () => {
    for (const { file } of TSCONFIGS) {
      const { moduleResolution } = compilerOptions(file);
      expect(moduleResolution, `${file}: compilerOptions.moduleResolution`).toBeDefined();
      expect(String(moduleResolution).toLowerCase(), file).not.toMatch(/^(node|node10|classic)$/);
    }
  });

  it('the server emits CommonJS, resolves like a bundler and reads the Node entry of a package', () => {
    const { module, moduleResolution, customConditions } = compilerOptions('apps/server/tsconfig.json');
    expect(String(module).toLowerCase()).toBe('commonjs');
    expect(String(moduleResolution).toLowerCase()).toBe('bundler');
    // Types must come from the entry Node loads: `node`, and never the ES-module one a `require` does not take.
    expect(customConditions).toContain('node');
    expect(customConditions).not.toContain('import');
  });

  it('Architecture.md names the TypeScript major the manifests declare', () => {
    const major = /^\^(\d+)\./.exec(declared('apps/server').typescript ?? '')?.[1];
    expect(major, 'apps/server declares TypeScript').toBeDefined();
    const rows = [...read('Architecture.md').matchAll(/^\| Language \| TypeScript \| ([^|\n]+) \|$/gm)].map((m) => m[1].trim());
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toMatch(new RegExp(`^${major}\\.\\d+\\+$`));
  });
});
