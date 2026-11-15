import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { readEncryptionKey, checkEncryptionKeyAtBoot } from '../../utils/secretBox';

// TOTP_ENCRYPTION_KEY as every consumer reads it (#51): totpService, the
// secret box and the boot check share one rule. A distinctive key, so a test
// can prove no message ever repeats it.
const KEY = 'c0ffee0123456789abcdef0123456789abcdef0123456789abcdef01234567ff';
const env = (vars: Record<string, string | undefined>) => vars as NodeJS.ProcessEnv;

describe('readEncryptionKey — one reading of the key for every consumer', () => {
  it('unset when missing or empty (what the example env files leave)', () => {
    expect(readEncryptionKey(undefined)).toEqual({ state: 'unset' });
    expect(readEncryptionKey('')).toEqual({ state: 'unset' });
  });

  it('usable and canonical for 64 hexadecimal characters, either case', () => {
    const lower = readEncryptionKey(KEY);
    expect(lower).toMatchObject({ state: 'usable', canonical: true });
    expect(lower.state === 'usable' && lower.key.equals(Buffer.from(KEY, 'hex'))).toBe(true);
    expect(readEncryptionKey(KEY.toUpperCase())).toMatchObject({ state: 'usable', canonical: true });
  });

  it('usable but not canonical when characters follow the 64 hexadecimal ones: the same 32 bytes as without them', () => {
    for (const tail of ['\r', '\n', ' ', ' # comment', 'a', 'zz']) {
      const read = readEncryptionKey(`${KEY}${tail}`);
      expect(read, JSON.stringify(tail)).toMatchObject({ state: 'usable', canonical: false });
      expect(read.state === 'usable' && read.key.equals(Buffer.from(KEY, 'hex'))).toBe(true);
    }
  });

  it('unusable when the value does not give 32 bytes', () => {
    for (const value of [
      KEY.slice(0, 62), // too short
      KEY.slice(0, 63), // an odd length short of 64
      `${KEY}ab`, // 33 bytes
      `${KEY.slice(0, 40)}g${KEY.slice(41)}`, // a non-hex character inside
      ` ${KEY}`, // the decoder stops at the leading space
      'your_32_byte_hex_key', // a placeholder left in an env file
    ]) {
      expect(readEncryptionKey(value), value).toEqual({ state: 'unusable' });
    }
  });
});

describe('checkEncryptionKeyAtBoot (#51)', () => {
  it('unset in production: refuses to start, as before', () => {
    const check = checkEncryptionKeyAtBoot(env({ NODE_ENV: 'production' }));
    expect(check.fatal).toMatch(/^TOTP_ENCRYPTION_KEY is not set — refusing to start in production/);
    expect(check.fatal).toContain('openssl rand -hex 32');
    expect(check.warning).toBeNull();
  });

  it('unset elsewhere: starts with the plaintext warning, as before', () => {
    for (const NODE_ENV of [undefined, 'development', 'test']) {
      const check = checkEncryptionKeyAtBoot(env({ NODE_ENV, TOTP_ENCRYPTION_KEY: '' }));
      expect(check.fatal).toBeNull();
      expect(check.warning).toMatch(/^TOTP_ENCRYPTION_KEY is not set\. TOTP secrets will be stored UNENCRYPTED/);
    }
  });

  it('set but unusable: refuses to start in EVERY environment, naming the setting and the rule', () => {
    for (const NODE_ENV of ['production', 'development', undefined]) {
      const check = checkEncryptionKeyAtBoot(env({ NODE_ENV, TOTP_ENCRYPTION_KEY: KEY.slice(0, 62) }));
      expect(check.fatal).toContain('TOTP_ENCRYPTION_KEY');
      expect(check.fatal).toContain('64 hexadecimal characters (32 bytes)');
      expect(check.fatal).toContain('openssl rand -hex 32');
      expect(check.warning).toBeNull();
    }
  });

  it('usable: starts silently', () => {
    expect(checkEncryptionKeyAtBoot(env({ NODE_ENV: 'production', TOTP_ENCRYPTION_KEY: KEY }))).toEqual({ fatal: null, warning: null });
    expect(checkEncryptionKeyAtBoot(env({ TOTP_ENCRYPTION_KEY: KEY.toUpperCase() }))).toEqual({ fatal: null, warning: null });
  });

  it('usable but with characters after the key: starts, with a warning that they are ignored (an install that works today keeps working)', () => {
    const check = checkEncryptionKeyAtBoot(env({ NODE_ENV: 'production', TOTP_ENCRYPTION_KEY: `${KEY}\r` }));
    expect(check.fatal).toBeNull();
    expect(check.warning).toContain('TOTP_ENCRYPTION_KEY');
    expect(check.warning).toContain('ignored');
  });

  it('never prints the value, nor any part of it', () => {
    const values = [KEY.slice(0, 62), `${KEY}ab`, `${KEY} # note`, `${KEY.slice(0, 40)}g${KEY.slice(41)}`];
    for (const value of values) {
      for (const NODE_ENV of ['production', 'development']) {
        const { fatal, warning } = checkEncryptionKeyAtBoot(env({ NODE_ENV, TOTP_ENCRYPTION_KEY: value }));
        for (const text of [fatal, warning]) {
          if (text === null) continue;
          expect(text).not.toContain(KEY.slice(0, 16));
          expect(text).not.toContain(KEY.slice(-16));
          expect(text).not.toContain('note');
        }
      }
    }
  });
});

describe('index.ts runs the check before it starts anything', () => {
  it('calls checkEncryptionKeyAtBoot with the environment and exits on a fatal answer, before the server is created', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../index.ts'), 'utf8');
    const check = source.indexOf('checkEncryptionKeyAtBoot(process.env)');
    expect(check).toBeGreaterThan(-1);
    const afterCheck = source.slice(check, check + 400);
    expect(afterCheck).toMatch(/\.fatal\)[\s\S]*process\.exit\(1\)/);
    // the old presence-only check is gone, so the two cannot disagree
    expect(source).not.toMatch(/if \(!process\.env\.TOTP_ENCRYPTION_KEY\)/);
    expect(check).toBeLessThan(source.indexOf('http.createServer('));
  });

  it('the compiled entry point requires the check before it calls it (CommonJS requires a module where its import stands)', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../index.ts'), 'utf8');
    const out = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const required = out.indexOf('require("./utils/secretBox")');
    expect(required).toBeGreaterThan(-1);
    expect(required).toBeLessThan(out.indexOf('checkEncryptionKeyAtBoot)(process.env)'));
  });
});

describe('the samples a self-hoster copies never hold an unusable key', () => {
  const ROOT = path.resolve(__dirname, '../../../../..');
  const SAMPLES = ['README.md', '.env.production.example', 'apps/server/.env.example'];

  it('every TOTP_ENCRYPTION_KEY= line in the samples is empty (unset) or a usable key', () => {
    let seen = 0;
    for (const file of SAMPLES) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const m of text.matchAll(/^TOTP_ENCRYPTION_KEY=(.*)$/gm)) {
        seen++;
        const value = m[1].trim().replace(/^"(.*)"$/, '$1');
        expect(readEncryptionKey(value).state, `${file}: ${m[0]}`).not.toBe('unusable');
      }
    }
    expect(seen).toBe(SAMPLES.length);
  });
});
