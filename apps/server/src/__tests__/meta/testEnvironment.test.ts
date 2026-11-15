import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TEST_JWT_SECRET, TEST_JWT_REFRESH_SECRET } from '../helpers/testSecrets';

// The server suite brings its own token secrets. They used to come only from
// a developer's apps/server/.env (loaded by setup.ts) or from the env block of
// CI's unit-test step: in a fresh clone the route tests signed their tokens
// with a fallback the auth middleware never saw, and 688 of them answered 401.

const ROOT = path.resolve(__dirname, '../../../../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

describe('the server unit suite\'s environment', () => {
  it('signs and verifies with the suite\'s own secrets, whatever the shell or a local .env holds', () => {
    expect(process.env.JWT_SECRET).toBe(TEST_JWT_SECRET);
    expect(process.env.JWT_REFRESH_SECRET).toBe(TEST_JWT_REFRESH_SECRET);
    // An access token must never verify as a refresh token
    expect(TEST_JWT_SECRET).not.toBe(TEST_JWT_REFRESH_SECRET);
  });

  it('assigns them in setup.ts after the .env files are read, so a local value cannot win', () => {
    const setup = read('apps/server/src/__tests__/setup.ts');
    const lastEnvFile = setup.lastIndexOf('dotenv.config(');
    for (const name of ['JWT_SECRET', 'JWT_REFRESH_SECRET']) {
      const assignment = setup.search(new RegExp(`^process\\.env\\.${name} = `, 'm'));
      expect(assignment, name).toBeGreaterThan(-1);
      expect(assignment, `${name} is assigned after the last dotenv.config()`).toBeGreaterThan(lastEnvFile);
    }
  });

  it('CI\'s unit-test step gives the suite no token secret, so a run there proves it needs none', () => {
    const ci = read('.github/workflows/ci.yml');
    const start = ci.indexOf('      - name: Unit tests\n');
    expect(start).toBeGreaterThan(-1);
    const next = ci.indexOf('\n  e2e:\n', start);
    const step = ci.slice(start, next === -1 ? undefined : next);
    expect(step).toContain('run: pnpm test');
    expect(step).not.toMatch(/JWT_/);
  });
});
