// @vitest-environment node
// Pure filesystem check: the repository compiles with ONE TypeScript, and the
// settings the move to TypeScript 6 had to write down stay written down.
// TypeScript 6 includes no @types package a tsconfig does not name and refuses
// the Node 10 module resolution, so every tsconfig of every workspace package
// names its `types` (each one a dependency its own package declares, not one
// found through hoisting) and resolves modules another way. The server stays
// on CommonJS output: its dynamic imports name files without an extension,
// which Node's own module settings would refuse and emit differently.
// Code that runs in a browser (the desktop and admin apps, and the shared
// package they bundle) is compiled by a tsconfig.json that also serves the
// tests or the server, with Node's types: so it is checked a second time, by
// tsconfig.browser.json, without them.
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const read = (p: string) => readFileSync(join(REPO, p), 'utf8').replace(/\r\n/g, '\n');

type Manifest = {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
type CompilerOptions = {
  types?: string[];
  lib?: string[];
  module?: string;
  moduleResolution?: string;
  customConditions?: string[];
  noCheck?: boolean;
};
type Tsconfig = { extends?: string | string[]; compilerOptions?: CompilerOptions; include?: string[]; exclude?: string[] };

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

  it('no tsconfig turns type checking off', () => {
    for (const { file } of TSCONFIGS) expect(compilerOptions(file).noCheck, `${file}: compilerOptions.noCheck`).not.toBe(true);
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

/**
 * The packages whose code runs in a browser: one whose tsconfig.json compiles against
 * the DOM (it names a DOM or worker library, or names none: the compiler's default
 * list includes the DOM), and every workspace package with a tsconfig.json that such
 * a package ships with: its `dependencies` (a devDependency is never bundled).
 */
function browserPackages(): string[] {
  const withConfig = PACKAGES.filter((dir) => existsSync(join(REPO, dir, 'tsconfig.json')));
  const found = new Set(
    withConfig.filter((dir) => {
      const { lib } = compilerOptions(`${dir}/tsconfig.json`);
      return lib === undefined || lib.some((entry) => /^(dom|webworker)/i.test(entry));
    }),
  );
  const byName = new Map(withConfig.map((dir) => [manifest(dir).name, dir]));
  // A Set also visits what is added while it is walked: the dependencies of a dependency.
  for (const dir of found) {
    for (const name of Object.keys(manifest(dir).dependencies ?? {})) {
      const dependency = byName.get(name);
      if (dependency !== undefined) found.add(dependency);
    }
  }
  return [...found].sort();
}

/** The `include` and `exclude` a tsconfig ends up with: its own lists, else those of the config it extends. */
function fileLists(file: string): Pick<Tsconfig, 'include' | 'exclude'> {
  const path = resolve(REPO, file);
  const config = parseJsonc<Tsconfig>(readFileSync(path, 'utf8'));
  let { include, exclude } = config;
  // Of several extended configs the last one wins.
  for (const target of [config.extends ?? []].flat().reverse()) {
    const inherited = fileLists(extendedFile(path, target));
    include ??= inherited.include;
    exclude ??= inherited.exclude;
  }
  return { include, exclude };
}

const BROWSER_CONFIG = 'tsconfig.browser.json';
const CANARY = 'typecheck/noNodeTypes.ts';
const TESTS = 'src/**/__tests__/**';
/** The steps of a script, as written between `&&`. */
const steps = (script: string | undefined) => (script ?? '').split('&&').map((step) => step.trim());
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('code that runs in a browser is also checked without Node types', () => {
  it('finds the desktop and admin apps and the package they bundle, and not the server', () => {
    expect(browserPackages()).toEqual(expect.arrayContaining(['apps/admin', 'apps/desktop', 'packages/shared']));
    expect(browserPackages()).not.toContain('apps/server');
  });

  it('each has a second tsconfig that extends the first, names no Node types and covers the same code', () => {
    for (const dir of browserPackages()) {
      const file = `${dir}/${BROWSER_CONFIG}`;
      expect(existsSync(join(REPO, file)), `${file} (${dir} runs in a browser)`).toBe(true);
      expect(parseJsonc<Tsconfig>(read(file)).extends, `${file}: extends`).toBe('./tsconfig.json');
      for (const entry of compilerOptions(file).types ?? []) {
        expect(entry, `${file}: compilerOptions.types`).not.toMatch(/^(@types\/)?node(\/|$)/);
      }
      // A list of its own replaces the one it would inherit, so compare what each ends up with.
      const base = fileLists(`${dir}/tsconfig.json`);
      const own = fileLists(file);
      expect(base.include, `${dir}/tsconfig.json: include`).toBeDefined();
      expect(own.include, `${file}: include`).toEqual(expect.arrayContaining([...(base.include ?? []), CANARY]));
      // It may leave out the tests, which need Node's types, and nothing else of the code.
      for (const entry of own.exclude ?? []) {
        expect([...(base.exclude ?? []), TESTS], `${file}: exclude "${entry}"`).toContain(entry);
      }
    }
  });

  it('each keeps the canary that fails that pass the day Node types come back by themselves', () => {
    // Naming no types does not keep them out when a declaration file asks for them. The
    // canary expects an error on each Node global, and an unused directive is an error.
    for (const dir of browserPackages()) {
      const file = `${dir}/${CANARY}`;
      expect(existsSync(join(REPO, file)), file).toBe(true);
      const canary = read(file);
      // Nothing that switches the file's checking off or hides a statement from the compiler.
      expect(canary, file).not.toMatch(/@ts-nocheck|@ts-ignore|\/\*/);
      const code = canary
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && (!line.startsWith('//') || line.startsWith('// @ts-expect-error')));
      // Nothing but expected errors, one per name, then the line that makes it a module.
      expect(code.pop(), `${file}: last statement`).toBe('export {};');
      const names: string[] = [];
      for (let i = 0; i < code.length; i += 2) {
        expect(code[i], `${file}: the line above "${code[i + 1]}"`).toMatch(/^\/\/ @ts-expect-error\b/);
        const name = /^void ([A-Za-z_$][\w$]*);$/.exec(code[i + 1] ?? '')?.[1];
        expect(name, `${file}: "${code[i + 1]}" is not "void <name>;"`).toBeDefined();
        names.push(name ?? '');
      }
      expect(names, file).toEqual(expect.arrayContaining(['process', 'Buffer']));
    }
  });

  it('pnpm typecheck runs that pass for each of them', () => {
    const scripts = (JSON.parse(read('package.json')) as Manifest).scripts ?? {};
    for (const name of ['typecheck', 'typecheck:browser']) {
      // Steps joined by `&&` and nothing else: any other operator can let a failed step through.
      expect((scripts[name] ?? '').replace(/&&/g, ''), `package.json: scripts.${name}`).not.toMatch(/[|;&]/);
    }
    expect(steps(scripts.typecheck), 'package.json: scripts.typecheck').toContainEqual(
      expect.stringMatching(/^pnpm (run )?typecheck:browser$/),
    );
    for (const dir of browserPackages()) {
      const pass = `^pnpm --filter ${literal(manifest(dir).name ?? dir)} exec tsc (--noEmit )?(-p|--project) ${literal(BROWSER_CONFIG)}( --noEmit)?$`;
      expect(steps(scripts['typecheck:browser']), `package.json: scripts.typecheck:browser (${dir})`).toContainEqual(
        expect.stringMatching(new RegExp(pass)),
      );
    }
  });

  it('CI runs pnpm typecheck on every pull request, in a step and a job with no `if` and no `continue-on-error`', () => {
    const lines = read('.github/workflows/ci.yml').split('\n');
    const indent = (line: string) => line.length - line.trimStart().length;
    const idle = (line: string) => line.trim() === '' || line.trim().startsWith('#');
    /** The lines from `first` to the next line indented no deeper than it, blank lines and comments aside. */
    const block = (first: number) => {
      let last = first + 1;
      while (last < lines.length && (idle(lines[last]) || indent(lines[last]) > indent(lines[first]))) last++;
      return lines.slice(first, last).filter((line) => !idle(line));
    };
    const excuse = /^["']?(if|continue-on-error)["']?\s*:/;

    const at = lines.findIndex((line) => /^\s+(- )?run: ["']?pnpm (run )?typecheck["']?\s*(#.*)?$/.test(line));
    expect(at, 'ci.yml: a step that runs pnpm typecheck').toBeGreaterThan(-1);

    // The step: its `- ` line and the keys written under it.
    let step = at;
    while (step > 0 && !/^\s*- /.test(lines[step])) step--;
    const stepKeys = block(step).filter((line, i) => i === 0 || indent(line) === indent(lines[step]) + 2);
    for (const line of stepKeys) expect(line.trim().replace(/^- /, ''), 'the step').not.toMatch(excuse);

    // The job: the keys one level under its name, written above or below its steps.
    let job = step;
    while (job > 0 && !/^ {2}[\w-]+:\s*(#.*)?$/.test(lines[job])) job--;
    expect(job, 'ci.yml: the job of that step').toBeGreaterThan(0);
    for (const line of block(job).filter((entry) => indent(entry) === 4)) expect(line.trim(), 'the job').not.toMatch(excuse);

    // The trigger: `pull_request` with no filter under it (paths, branches, types).
    const trigger = lines.findIndex((line) => /^ {2}["']?pull_request["']?:\s*(#.*)?$/.test(line));
    expect(trigger, 'ci.yml: on.pull_request, written as a key').toBeGreaterThan(-1);
    expect(block(trigger), 'on.pull_request').toHaveLength(1);
  });
});
