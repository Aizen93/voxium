import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { signInOrRegister } from '../../../../../scripts/lib/signInOrRegister';

// How the root scripts get their test accounts (beside portProbe.test.ts: the
// root scripts' helpers are tested in this suite). A registration started for
// an account that exists is a failed attempt the server charges to the
// address for 24 hours, so the scripts sign in first.

/** An error shaped like axios' for an HTTP answer. */
function httpError(status: number): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });
}

describe('signInOrRegister', () => {
  it('returns the sign-in and starts no registration when the account exists', async () => {
    const signIn = vi.fn(async () => 'token-of-the-existing-account');
    const register = vi.fn(async () => 'never');

    await expect(signInOrRegister(signIn, register)).resolves.toBe('token-of-the-existing-account');

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(register).not.toHaveBeenCalled();
  });

  it('registers when the sign-in is refused as unknown (401)', async () => {
    const signIn = vi.fn(async () => { throw httpError(401); });
    const register = vi.fn(async () => 'token-of-the-new-account');

    await expect(signInOrRegister(signIn, register)).resolves.toBe('token-of-the-new-account');

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it.each([429, 403, 500, 503])('throws a sign-in answered %i as it is and registers nothing', async (status) => {
    const failure = httpError(status);
    const register = vi.fn(async () => 'never');

    await expect(signInOrRegister(async () => { throw failure; }, register)).rejects.toBe(failure);

    expect(register).not.toHaveBeenCalled();
  });

  it('throws a sign-in that never got an answer as it is and registers nothing', async () => {
    const failure = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const register = vi.fn(async () => 'never');

    await expect(signInOrRegister(async () => { throw failure; }, register)).rejects.toBe(failure);

    expect(register).not.toHaveBeenCalled();
  });

  it('lets a failed registration through (a taken username, 409, is the caller\'s to read)', async () => {
    const conflict = httpError(409);

    await expect(signInOrRegister(async () => { throw httpError(401); }, async () => { throw conflict; })).rejects.toBe(conflict);
  });
});

describe('the root scripts that create accounts', () => {
  const SCRIPTS = ['load-test-voice.ts', 'test-multi-node.ts', 'test-permissions.ts', 'test-voice-optimizations.ts'];
  const read = (name: string) => readFileSync(path.resolve(__dirname, '../../../../../scripts', name), 'utf8');

  it.each(SCRIPTS)('%s registers an account only through signInOrRegister', (name) => {
    const source = read(name);
    expect(source).toContain("from './lib/signInOrRegister'");
    const registrations = [...source.matchAll(/\bregisterTestUser\(/g)].map((m) => m.index);
    expect(registrations.length).toBeGreaterThan(0);
    for (const at of registrations) {
      // the registration is the second argument of the nearest signInOrRegister( above it
      const guard = source.lastIndexOf('signInOrRegister(', at);
      expect(guard, `${name}: registerTestUser at offset ${at} has no signInOrRegister above it`).toBeGreaterThan(-1);
      expect(at - guard, `${name}: registerTestUser at offset ${at} is not inside a signInOrRegister call`).toBeLessThan(1500);
      // the old path read the registration's 409 as "exists, sign in"
      expect(source.slice(at, at + 400)).not.toMatch(/status\s*[!=]==\s*409/);
    }
  });

  it('a script that raises the sign-in limit raises the per-network one too (a first run signs in to nothing)', () => {
    for (const name of SCRIPTS) {
      const source = read(name);
      const lists = source.match(/\['login',[^\]]*\]/g) ?? [];
      for (const list of lists) expect(list, name).toContain("'loginSubnet'");
    }
    // the three scripts that raise limits each hold at least one such list
    expect(SCRIPTS.filter((name) => /\['login',[^\]]*\]/.test(read(name)))).toEqual([
      'load-test-voice.ts', 'test-permissions.ts', 'test-voice-optimizations.ts',
    ]);
  });
});
