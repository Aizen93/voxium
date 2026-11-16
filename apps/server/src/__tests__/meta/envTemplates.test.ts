import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// The settings a self-hoster can give Voxium are the ones the code reads.
// Every one of them is in a tracked template and in the README's
// Configuration Reference, with the default the code uses, and neither names
// a setting nothing reads. A new `process.env.X` in the server fails here
// until it is documented. Variables only tests or CI read are not scanned:
// test files are skipped, and the scripts under scripts/ are development and
// CI tools with their own headers.

const ROOT = path.resolve(__dirname, '../../../../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/** Source files under `dir`, tests and generated code left out. */
function sources(dir: string, exts = ['.ts', '.tsx']): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs)) {
      if (name === '__tests__' || name === 'generated' || name === 'node_modules') continue;
      const full = path.join(abs, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (exts.some((e) => name.endsWith(e)) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(full);
    }
  };
  walk(path.join(ROOT, dir));
  return out;
}

const NAME = '[A-Z_][A-Z0-9_]*';

/**
 * Every environment variable a set of files reads: `process.env.X`,
 * `process.env['X']`, and `env.X` on an env object handed to a function
 * (`smtpTransportOptions(process.env)`). Any other use of `process.env` is
 * reported as unclassified, so a new access form cannot slip past.
 */
function envReads(files: string[], allowDynamic: (file: string, line: string) => boolean) {
  const reads = new Set<string>();
  const unclassified: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(new RegExp(`(?<![\\w$])(?:process\\.)?env\\.(${NAME})`, 'g'))) reads.add(m[1]);
    for (const m of text.matchAll(new RegExp(`process\\.env\\[['"](${NAME})['"]\\]`, 'g'))) reads.add(m[1]);
    for (const m of text.matchAll(/process\.env(?![.\w])(.{0,20})/g)) {
      const after = m[1];
      if (/^\[['"]/.test(after)) continue; // process.env['X'], counted above
      // The whole env handed to a function as an argument or a default
      // parameter: its env.X reads are counted. Not `= process.env;` (a
      // destructuring reads names this scan would not see).
      if (/^\s*[),]/.test(after)) continue;
      const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index));
      if (allowDynamic(file, line)) continue;
      unclassified.push(`${path.relative(ROOT, file)}: ${line.trim()}`);
    }
  }
  return { reads, unclassified };
}

/**
 * The settings of a template, with their value: `NAME=value` lines, and
 * commented ones (`# NAME=value`, alone on the line or followed by two
 * spaces and a note). A comment's prose that starts with `NAME=value ...`
 * is not an entry.
 */
function templateEntries(rel: string): Map<string, { value: string; commented: boolean }> {
  const out = new Map<string, { value: string; commented: boolean }>();
  const commented = new RegExp(`^#\\s*(${NAME})=(\\S*)(?:\\s*$| {2,}\\S)`);
  const set = new RegExp(`^(${NAME})=(.*)$`);
  for (const line of read(rel).split('\n')) {
    const c = commented.exec(line);
    const s = c ? null : set.exec(line);
    const m = c ?? s;
    if (!m) continue;
    expect(out.has(m[1]), `${rel} names ${m[1]} twice`).toBe(false);
    out.set(m[1], { value: m[2].trim().replace(/^"(.*)"$/, '$1'), commented: c !== null });
  }
  return out;
}

/** The variables of the first README table after the line `heading`, with the second column. */
function readmeTable(heading: string): Map<string, string> {
  const lines = read('README.md').split('\n');
  const at = lines.indexOf(heading);
  expect(at, heading).toBeGreaterThan(-1);
  let i = at + 1;
  while (i < lines.length && !lines[i].startsWith('|')) i++;
  const out = new Map<string, string>();
  for (; i < lines.length && lines[i].startsWith('|'); i++) {
    const cells = lines[i].split('|').map((c) => c.trim());
    if (cells.length < 4 || !cells[1].startsWith('`')) continue;
    for (const name of cells[1].matchAll(new RegExp(`\`(${NAME})\``, 'g'))) out.set(name[1], cells[2]);
  }
  return out;
}

// ── The server ──────────────────────────────────────────────────────────────

const server = envReads(sources('apps/server/src'), (file, line) =>
  // The boot check of the required settings: `process.env[key]` over REQUIRED_ENV_VARS
  file.endsWith(path.join('apps', 'server', 'src', 'index.ts')) && line.includes('REQUIRED_ENV_VARS.filter((key) => !process.env[key])'));

/** The literal fallback of `process.env.X || '…'` in the server, by variable. */
function codeDefaults(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of sources('apps/server/src')) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(new RegExp(`process\\.env\\.(${NAME})\\s*\\|\\|\\s*'([^']*)'`, 'g'))) {
      const seen = out.get(m[1]);
      expect(seen === undefined || seen === m[2], `${m[1]} has two defaults in the code`).toBe(true);
      out.set(m[1], m[2]);
    }
  }
  return out;
}

/** Defaults the README states in words rather than as the literal the code falls back to. */
const DEFAULT_IN_WORDS: Record<string, string> = {
  MEDIASOUP_NUM_WORKERS: 'one per CPU core', // `|| '0'`, and 0 means one per core
};

/** Set by the compose file's `environment:` for the server container. */
function composeServerEnvironment(): Set<string> {
  const compose = read('docker-compose.production.yml');
  const server = compose.slice(compose.indexOf('\n  server:\n'), compose.indexOf('\n  postgres:\n'));
  const env = server.slice(server.indexOf('\n    environment:\n'));
  return new Set([...env.matchAll(new RegExp(`^ {6}- (${NAME})=`, 'gm'))].map((m) => m[1]));
}

/**
 * Read around the server by the Docker deployment, never by the server
 * itself: the compose file's own interpolations and the one-off switches.
 */
const OPERATOR_SWITCHES: Record<string, string> = {
  VOXIUM_ALLOW_CUTOVER: 'docker-entrypoint.sh',
  VOXIUM_ALLOW_DEMO_SEED: 'apps/server/prisma/seed.ts',
};

function composeInterpolations(): Set<string> {
  const compose = read('docker-compose.production.yml').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  return new Set([...compose.matchAll(new RegExp(`\\$\\{(${NAME})`, 'g'))].map((m) => m[1]));
}

describe('the settings the server reads', () => {
  it('reads process.env only in the forms this test understands', () => {
    expect(server.unclassified).toEqual([]);
  });

  it('finds them (a scan that found nothing would prove nothing)', () => {
    for (const name of ['DATABASE_URL', 'JWT_SECRET', 'SMTP_REQUIRE_TLS', 'NODE_ID', 'MEDIASOUP_NUM_WORKERS', 'LOG_FORMAT']) {
      expect(server.reads, name).toContain(name);
    }
  });

  it('every one is in apps/server/.env.example', () => {
    const template = templateEntries('apps/server/.env.example');
    expect([...server.reads].filter((n) => !template.has(n)).sort()).toEqual([]);
  });

  it('every one is in .env.production.example, or set by the compose file for the server', () => {
    const template = templateEntries('.env.production.example');
    const compose = composeServerEnvironment();
    expect(compose).toEqual(new Set(['NODE_ENV', 'DATABASE_URL', 'REDIS_URL']));
    expect([...server.reads].filter((n) => !template.has(n) && !compose.has(n)).sort()).toEqual([]);
    // and the template says so for the ones the compose file sets, without setting them
    for (const name of compose) expect(template.get(name)?.commented, name).toBe(true);
  });

  it('every one is in the README table, and the table names nothing the server does not read', () => {
    const table = readmeTable('### Server Environment Variables (`apps/server/.env`)');
    expect([...server.reads].filter((n) => !table.has(n)).sort()).toEqual([]);
    expect([...table.keys()].filter((n) => !server.reads.has(n)).sort()).toEqual([]);
  });

  it('the README states the default the code falls back to', () => {
    const table = readmeTable('### Server Environment Variables (`apps/server/.env`)');
    const defaults = codeDefaults();
    expect(defaults.size).toBeGreaterThan(10);
    const wrong: string[] = [];
    for (const [name, value] of defaults) {
      const stated = DEFAULT_IN_WORDS[name] ?? value;
      if (!table.get(name)?.includes(stated)) wrong.push(`${name}: code ${JSON.stringify(value)}, README ${JSON.stringify(table.get(name))}`);
    }
    expect(wrong).toEqual([]);
  });

  it('a template\'s commented line holds the code\'s default when there is one', () => {
    const defaults = codeDefaults();
    // The production template's lines for what the compose file sets show the compose file's values
    const setByCompose = composeServerEnvironment();
    const wrong: string[] = [];
    for (const rel of ['apps/server/.env.example', '.env.production.example']) {
      for (const [name, { value, commented }] of templateEntries(rel)) {
        if (rel === '.env.production.example' && setByCompose.has(name)) continue;
        if (commented && value !== '' && defaults.has(name) && defaults.get(name) !== value) wrong.push(`${rel} ${name}=${value} (code: ${defaults.get(name)})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('the development template\'s refresh-token lifetime is the code default the Cookie Policy states', () => {
    expect(codeDefaults().get('JWT_REFRESH_EXPIRES_IN')).toBe('30d');
    expect(templateEntries('apps/server/.env.example').get('JWT_REFRESH_EXPIRES_IN')?.value).toBe('30d');
  });
});

describe('the settings around the server (the Docker deployment)', () => {
  it('the switches are read where the table says, and documented there', () => {
    const table = readmeTable('### Server Environment Variables (`apps/server/.env`)');
    const around = readmeAroundTable();
    for (const [name, file] of Object.entries(OPERATOR_SWITCHES)) {
      expect(read(file), `${file} reads ${name}`).toContain(name);
      expect(table.has(name), `${name} is no server setting`).toBe(false);
      expect(around.has(name), name).toBe(true);
    }
  });

  it('the cutover switch is in the production template, commented; the demo seed\'s is in no template', () => {
    expect(templateEntries('.env.production.example').get('VOXIUM_ALLOW_CUTOVER')).toEqual({ value: '1', commented: true });
    for (const rel of ['apps/server/.env.example', '.env.production.example']) {
      expect(templateEntries(rel).has('VOXIUM_ALLOW_DEMO_SEED'), rel).toBe(false);
    }
  });

  it('every ${VAR} the compose file interpolates is in the production template', () => {
    const template = templateEntries('.env.production.example');
    const vars = composeInterpolations();
    expect(vars).toContain('POSTGRES_PASSWORD');
    expect([...vars].filter((n) => !template.has(n)).sort()).toEqual([]);
  });

  it('neither server template names a variable nothing reads', () => {
    const known = new Set([...server.reads, ...Object.keys(OPERATOR_SWITCHES), ...composeInterpolations()]);
    for (const rel of ['apps/server/.env.example', '.env.production.example']) {
      expect([...templateEntries(rel).keys()].filter((n) => !known.has(n)).sort(), rel).toEqual([]);
    }
  });
});

function readmeAroundTable(): Map<string, string> {
  return readmeTable('Read by the Docker deployment around the server, not by the server itself:');
}

// ── The clients ─────────────────────────────────────────────────────────────

/** VITE_* names a client's code reads (any mention outside tests: import.meta.env.X, env.X, the ImportMetaEnv type). */
function viteNames(dir: string): Set<string> {
  const out = new Set<string>();
  for (const file of sources(dir)) {
    for (const m of readFileSync(file, 'utf8').matchAll(/\bVITE_[A-Z0-9_]+\b/g)) out.add(m[0]);
  }
  return out;
}

describe.each([
  { app: 'desktop', heading: '### Frontend Environment Variables (`apps/desktop/.env`)', must: ['VITE_API_URL', 'VITE_WS_URL', 'VITE_STUN_URL'] },
  { app: 'admin', heading: '### Admin Dashboard Environment Variables (`apps/admin/.env`)', must: ['VITE_API_URL', 'VITE_WS_URL'] },
])('the $app client\'s build settings', ({ app, heading, must }) => {
  const names = viteNames(`apps/${app}/src`);
  const template = `apps/${app}/.env.example`;

  it('finds them', () => {
    for (const name of must) expect(names, name).toContain(name);
  });

  it(`every one is in ${template} and in the README table, and neither names one the code does not read`, () => {
    const entries = templateEntries(template);
    const table = readmeTable(heading);
    expect([...names].filter((n) => !entries.has(n)).sort()).toEqual([]);
    expect([...names].filter((n) => !table.has(n)).sort()).toEqual([]);
    // VOXIUM_DEV_LAN: listed as read from the environment only (next test)
    expect([...entries.keys()].filter((n) => !names.has(n) && n !== 'VOXIUM_DEV_LAN').sort()).toEqual([]);
    expect([...table.keys()].filter((n) => !names.has(n)).sort()).toEqual([]);
  });

  it('the template names the dev server switch its Vite config reads from the environment', () => {
    expect(read(`apps/${app}/vite.config.ts`)).toContain('process.env.VOXIUM_DEV_LAN');
    expect(read(template)).toContain('VOXIUM_DEV_LAN=1');
  });
});

describe('the desktop installer build\'s settings', () => {
  it('every variable the Tauri build scripts read is named in the desktop template and the README', () => {
    const scripts = ['apps/desktop/scripts/tauri-build-config.mjs', 'apps/desktop/scripts/tauri-release-config.mjs'];
    const names = new Set<string>();
    for (const rel of scripts) {
      for (const m of read(rel).matchAll(/\benv\.(TAURI_[A-Z0-9_]+)/g)) names.add(m[1]);
    }
    expect(names).toContain('TAURI_ASSET_ORIGIN');
    const template = read('apps/desktop/.env.example');
    const readme = read('README.md');
    for (const name of names) {
      expect(template, name).toContain(name.replace(/_PASSWORD$/, ''));
      expect(readme, name).toContain(`\`${name}\``);
    }
  });
});
