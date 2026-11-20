import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * services/sessionService.ts is the ONE minter of the tokens that open a
 * session: every access token names a session row and every refresh token a
 * generation of one, so a token signed anywhere else would be a session the
 * table does not know (unrevocable by a sign-out, invisible to the cap and
 * the sweep). What holds that:
 *  - JWT_REFRESH_SECRET is named by the session module alone, and by the
 *    boot check of index.ts that refuses to start without it;
 *  - every other jwt.sign in the server signs a token with a `purpose`
 *    claim, which `authenticate` and the socket handshake refuse as an access
 *    token (a two-factor challenge, a trusted device, a mail-block link);
 *  - the session module signs exactly the access token, the refresh token
 *    and a throwaway it only decodes (reading a lifetime the way
 *    jsonwebtoken does);
 *  - the minting function of before (generateTokens) and the old refresh
 *    (refreshTokens) are gone.
 */

const SRC = resolve(__dirname, '../..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'generated' || name === 'node_modules') continue;
      out.push(...sourceFiles(path));
    } else if (/\.ts$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

const files = sourceFiles(SRC).map((path) => ({
  rel: relative(SRC, path).replace(/\\/g, '/'),
  text: readFileSync(path, 'utf8'),
}));

/** The source of each `jwt.sign(` call's first argument (up to its closing brace). */
function signPayloads(text: string): string[] {
  const out: string[] = [];
  let i = text.indexOf('jwt.sign(');
  while (i !== -1) {
    const open = text.indexOf('{', i);
    let depth = 0;
    let end = open;
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++;
      else if (text[end] === '}' && --depth === 0) break;
    }
    out.push(text.slice(open, end + 1));
    i = text.indexOf('jwt.sign(', end);
  }
  return out;
}

describe('the session module is the only minter of session tokens', () => {
  it('JWT_REFRESH_SECRET is named nowhere but the session module and the boot check', () => {
    const naming = files.filter((f) => f.text.includes('JWT_REFRESH_SECRET')).map((f) => f.rel).sort();
    expect(naming).toEqual(['index.ts', 'services/sessionService.ts']);
    // In index.ts: the list of settings the server refuses to start without, nothing else
    const index = files.find((f) => f.rel === 'index.ts')!.text;
    expect(index.match(/JWT_REFRESH_SECRET/g)).toHaveLength(1);
    expect(index).toMatch(/REQUIRED_ENV_VARS = \[[^\]]*'JWT_REFRESH_SECRET'/);
  });

  it('every jwt.sign outside the session module signs a token with a purpose (never an access or a refresh token)', () => {
    const others = files.filter((f) => f.rel !== 'services/sessionService.ts' && f.text.includes('jwt.sign('));
    expect(others.length).toBeGreaterThan(0);
    for (const file of others) {
      for (const payload of signPayloads(file.text)) {
        expect(payload, `${file.rel}: ${payload}`).toMatch(/\bpurpose\s*:/);
      }
    }
  });

  it('the session module signs the access token, the refresh token and a throwaway it only decodes', () => {
    const session = files.find((f) => f.rel === 'services/sessionService.ts')!.text;
    const payloads = signPayloads(session);
    expect(payloads).toHaveLength(3);
    const [probe, access, refresh] = payloads;
    expect(probe).toBe('{}');
    expect(session).toMatch(/jwt\.decode\(\s*jwt\.sign\(\{\}, 'lifetime-probe'/);
    expect(access).toMatch(/sid: session\.id/);
    expect(refresh).toMatch(/sid: session\.id/);
    expect(refresh).toMatch(/gen: session\.generation/);
    // Neither carries a purpose: they are what `authenticate` and the refresh accept
    expect(access).not.toMatch(/purpose/);
    expect(refresh).not.toMatch(/purpose/);
    // Every verify of a refresh token pins HS256
    const verifies = session.match(/jwt\.verify\([^;]*;/g) ?? [];
    expect(verifies).toHaveLength(2);
    for (const v of verifies) expect(v).toContain("algorithms: ['HS256']");
  });

  it('nothing defines or calls the minting function of before, nor the old refresh', () => {
    for (const file of files) {
      expect(file.text, file.rel).not.toMatch(/\bgenerateTokens\b/);
      expect(file.text, file.rel).not.toMatch(/\brefreshTokens\b/);
    }
  });

  it('the places that open or renew a session go through the session module', () => {
    const text = (rel: string) => files.find((f) => f.rel === rel)!.text;
    // Sign-in, the two-factor step, the password change
    expect(text('services/authService.ts').match(/\bcreateSession\(/g)).toHaveLength(2);
    expect(text('services/authService.ts')).toMatch(/\brekeySession\(tx, account, sid, admittedVersion\)/);
    // Registration completion, in the account's transaction
    expect(text('services/signupService.ts')).toMatch(/\bopenSession\(\s*tx,/);
    // The renewal
    expect(text('routes/auth.ts')).toMatch(/\brefreshSession\(refreshToken,/);
  });
});
