// @vitest-environment node
// Pure filesystem check: the end-to-end specs wait on conditions, not on the
// clock. A fixed sleep is too short on a loaded runner and wasted time on a
// fast one, and with CI's retries it turns into a flake the gate lets through.
// The one kind kept is a measured time window: request-budget.spec.ts counts
// what a session sends in real time, and each of its waits says so in a
// "Measurement" comment right above it. That file is the only place one may
// stand.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const E2E = fileURLToPath(new URL('../../../../../tests/e2e/', import.meta.url));

/** The one spec whose fixed waits are measurements. */
const MEASURING_SPEC = 'request-budget.spec.ts';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(`${dir}${e.name}/`) : /\.ts$/.test(e.name) ? [`${dir}${e.name}`] : [],
  );
}

const isCommentLine = (line: string) => /^\s*(\/\/|\/\*|\*)/.test(line);

// A timer whose callback only settles a promise is a sleep, whatever the delay
// expression (a number, a constant, a variable) and however the promise is
// typed: `setTimeout(r, d)`, `setTimeout(() => r(), d)`, `setTimeout(() => { r(); }, d)`.
const IDENT = '[A-Za-z_$][\\w$]*';
const TIMER_SLEEPS = [
  new RegExp(`\\bsetTimeout\\(\\s*${IDENT}\\s*,`),
  new RegExp(`\\bsetTimeout\\(\\s*\\(\\s*\\)\\s*=>\\s*${IDENT}\\(\\s*\\)\\s*,`),
  new RegExp(`\\bsetTimeout\\(\\s*\\(\\s*\\)\\s*=>\\s*\\{\\s*${IDENT}\\(\\s*\\)\\s*;?\\s*\\}\\s*,`),
  // node:timers/promises' setTimeout is a sleep by definition
  /timers\/promises/,
];

/**
 * The fixed waits of one source file that the rule refuses, as
 * `<file>:<line>: <code>` (an empty list when the file is clean).
 */
function refusedWaits(name: string, text: string): string[] {
  const lines = text.split(/\r?\n/);
  const refused: string[] = [];
  lines.forEach((line, i) => {
    if (isCommentLine(line)) return;
    // Any mention outside a comment: a call, a bracket access, a string key
    if (!/waitForTimeout/.test(line)) return;
    const above: string[] = [];
    for (let j = i - 1; j >= 0 && /^\s*\/\//.test(lines[j]); j--) above.push(lines[j]);
    const documented = name === MEASURING_SPEC && above.some((l) => /\bMeasurement\b/.test(l));
    if (!documented) refused.push(`${name}:${i + 1}: ${line.trim()}`);
  });
  // Timer sleeps, matched over the code with comment lines removed (a call may span lines)
  const code = lines.map((l) => (isCommentLine(l) ? '' : l)).join('\n');
  for (const pattern of TIMER_SLEEPS) {
    const global = new RegExp(pattern.source, 'g');
    for (const m of code.matchAll(global)) {
      const line = code.slice(0, m.index).split('\n').length;
      refused.push(`${name}:${line}: ${lines[line - 1].trim()}`);
    }
  }
  return refused;
}

const files = sources(E2E).map((path) => ({
  name: path.slice(E2E.length).replace(/\\/g, '/'),
  text: readFileSync(path, 'utf8'),
}));

describe('fixed waits in the end-to-end specs', () => {
  it('finds the specs', () => {
    expect(files.some((f) => f.name === 'message-scroll.spec.ts')).toBe(true);
    expect(files.some((f) => f.name === MEASURING_SPEC)).toBe(true);
  });

  it('holds no fixed wait except the documented measurements', () => {
    expect(files.flatMap((f) => refusedWaits(f.name, f.text))).toEqual([]);
  });

  it('the measuring spec still measures with fixed waits', () => {
    const spec = files.find((f) => f.name === MEASURING_SPEC)!;
    expect(spec.text.match(/\bwaitForTimeout\(/g)?.length ?? 0).toBeGreaterThan(0);
  });

  describe('refuses each way around the rule', () => {
    const spec = 'some.spec.ts';
    const cases: Record<string, string> = {
      'a typed timer promise': 'await new Promise<void>((r) => setTimeout(r, 500));',
      'a delay held in a variable': 'const delay = 500;\nawait new Promise((resolve) => setTimeout(resolve, delay));',
      'an arrow that only resolves': 'await new Promise((r) => setTimeout(() => r(), SETTLE_MS));',
      'a block that only resolves': 'await new Promise((r) => setTimeout(() => {\n  r();\n}, 300));',
      'a timer spread over lines': 'await new Promise((r) =>\n  setTimeout(\n    r,\n    300,\n  ),\n);',
      'a sleep in the page': 'await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));',
      'node timers/promises': "import { setTimeout as sleep } from 'node:timers/promises';\nawait sleep(500);",
      'a bracket access': "await page['waitForTimeout'](500);",
      'a plain call': 'await page.waitForTimeout(500);',
      'a "Measurement" comment outside the measuring spec': '// Measurement window\nawait page.waitForTimeout(500);',
    };
    it.each(Object.entries(cases))('%s', (_label, text) => {
      expect(refusedWaits(spec, text)).not.toEqual([]);
    });

    it('a wait in the measuring spec without its comment', () => {
      expect(refusedWaits(MEASURING_SPEC, 'await page.waitForTimeout(500);')).not.toEqual([]);
      expect(refusedWaits(MEASURING_SPEC, '// a window\nawait page.waitForTimeout(500);')).not.toEqual([]);
    });
  });

  describe('lets through what is not a sleep', () => {
    it.each(Object.entries({
      'a documented measurement in the measuring spec': [MEASURING_SPEC, '// Measurement window: counted\nawait page.waitForTimeout(3_000);'],
      'a frame wait after a timer of zero': ['dm.spec.ts', 'setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 0);'],
      'an in-page time limit that rejects': ['dm.spec.ts', "const limit = setTimeout(() => {\n  observer.disconnect();\n  reject(new Error('late'));\n}, 15_000);"],
      'a test timeout': ['x.spec.ts', 'test.setTimeout(180_000);'],
      'a mention in a comment': ['x.spec.ts', '// this used to be a waitForTimeout(700)'],
    }))('%s', (_label, [name, text]) => {
      expect(refusedWaits(name, text)).toEqual([]);
    });
  });
});
