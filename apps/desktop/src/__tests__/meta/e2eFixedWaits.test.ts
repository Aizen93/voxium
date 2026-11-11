// @vitest-environment node
// Pure filesystem check: the end-to-end specs wait on conditions, not on the
// clock. A fixed sleep is too short on a loaded runner and wasted time on a
// fast one, and with CI's retries it turns into a flake the gate lets through.
// The one kind kept is a measured time window (request-budget.spec.ts counts
// what a session sends in real time), and each such wait says so in a
// "Measurement" comment right above it.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const E2E = fileURLToPath(new URL('../../../../../tests/e2e/', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(`${dir}${e.name}/`) : /\.ts$/.test(e.name) ? [`${dir}${e.name}`] : [],
  );
}

const files = sources(E2E);

describe('fixed waits in the end-to-end specs', () => {
  it('finds the specs', () => {
    expect(files.some((f) => f.endsWith('message-scroll.spec.ts'))).toBe(true);
  });

  it('every waitForTimeout is a documented measurement window', () => {
    const undocumented: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!/\bwaitForTimeout\s*\(/.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
        // The comment lines directly above the wait
        const above: string[] = [];
        for (let j = i - 1; j >= 0 && /^\s*\/\//.test(lines[j]); j--) above.push(lines[j]);
        if (!above.some((l) => /\bMeasurement\b/.test(l))) {
          undocumented.push(`${file.slice(E2E.length)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(undocumented).toEqual([]);
  });

  it('the specs that used to sleep wait on conditions now', () => {
    for (const name of ['message-scroll.spec.ts', 'message-search.spec.ts', 'dm-flow.spec.ts', 'voice-sfu.spec.ts']) {
      expect(readFileSync(`${E2E}${name}`, 'utf8'), name).not.toMatch(/\bwaitForTimeout\s*\(/);
    }
  });

  it('no sleep hides behind a bare timer promise', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file.slice(E2E.length)).not.toMatch(/new Promise\(\s*\(?\s*\w+\s*\)?\s*=>\s*setTimeout\(\s*\w+\s*,\s*\d/);
    }
  });
});
