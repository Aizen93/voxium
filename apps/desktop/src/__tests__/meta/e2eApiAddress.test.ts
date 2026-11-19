// @vitest-environment node
// Pure filesystem check (#184): the end-to-end runner reaches the API at its
// IPv4 address. The server listens on 0.0.0.0 only, and Node resolves
// `localhost` in the operating system's order (::1 first on some machines), so
// a runner call spelled `localhost:3001` is refused there. The address is
// written once, in tests/e2e/helpers/api.ts, and every spec imports it. The
// pages keep `localhost` (the origin the CORS lists name), and the one
// constant that spells it, PAGE_API_URL, is for comparing with what the page
// shows, never for a request.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const E2E = `${ROOT}tests/e2e/`;
const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(`${dir}${e.name}/`) : /\.ts$/.test(e.name) ? [`${dir}${e.name}`] : [],
  );
}

describe('the end-to-end runner reaches the API by its IPv4 address', () => {
  it('defines the API address once, on 127.0.0.1', () => {
    const helper = read(`${E2E}helpers/api.ts`);
    expect(helper).toContain("export const API_URL = 'http://127.0.0.1:3001/api/v1';");
    expect(helper).toContain("export const PAGE_API_URL = 'http://localhost:3001/api/v1';");
  });

  it('spells localhost:3001 nowhere else under tests/e2e', () => {
    const offenders = sources(E2E)
      .filter((f) => !f.endsWith('/helpers/api.ts'))
      .filter((f) => /localhost:3001/.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('uses PAGE_API_URL only to compare with what the page shows', () => {
    const users = sources(E2E)
      .filter((f) => !f.endsWith('/helpers/api.ts'))
      .filter((f) => /PAGE_API_URL/.test(read(f)))
      .map((f) => f.slice(E2E.length));
    expect(users).toEqual(['webhooks.spec.ts']);
  });

  it('probes the API health route by its IPv4 address in the Playwright config', () => {
    const config = read(`${ROOT}playwright.config.ts`);
    expect(config).toContain("url: 'http://127.0.0.1:3001/health'");
    expect(config).not.toContain('localhost:3001');
  });

  it('keeps the pages on localhost, the origin the server and the object store name', () => {
    for (const file of ['playwright.config.ts', 'playwright-firefox.config.ts']) {
      expect(read(`${ROOT}${file}`), file).toContain("baseURL: 'http://localhost:8080'");
    }
    const ci = read(`${ROOT}.github/workflows/ci.yml`);
    expect(ci).toContain('CORS_ORIGIN: http://localhost:8080,http://localhost:8082');
    expect(ci).toContain('"AllowedOrigins":["http://localhost:8080"]');
  });
});
