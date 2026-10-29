// @vitest-environment node
// Pure filesystem check: the Vite dev servers (desktop 8080, admin 8082) listen
// on loopback unless VOXIUM_DEV_LAN=1 asks for the LAN. A dev server reachable
// from the network serves the source tree and Vite's dev-only middleware to
// anyone on it, so "all interfaces" must stay an explicit opt-in.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const read = (p: string) => readFileSync(REPO + p, 'utf8');

describe('Vite dev server exposure', () => {
  for (const file of ['apps/desktop/vite.config.ts', 'apps/admin/vite.config.ts']) {
    it(`${file} binds to localhost unless VOXIUM_DEV_LAN=1`, () => {
      const config = read(file);
      expect(config).toContain("host: process.env.VOXIUM_DEV_LAN === '1' ? true : 'localhost',");
      expect(config).not.toMatch(/host:\s*(true|'0\.0\.0\.0'|"0\.0\.0\.0")\s*,/);
    });
  }
});
