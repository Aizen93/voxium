import { describe, it, expect } from 'vitest';
import { validatePassword, LIMITS } from '@voxium/shared';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Shared validators — validatePassword (P2 — bcrypt 72-BYTE limit)', () => {
  it('accepts a normal short password', () => {
    expect(validatePassword('password123')).toBeNull();
  });

  it('accepts exactly 72 ASCII characters (72 bytes)', () => {
    expect(validatePassword('a'.repeat(72))).toBeNull();
  });

  it('rejects 73 ASCII characters (73 bytes)', () => {
    expect(validatePassword('a'.repeat(73))).not.toBeNull();
  });

  it('rejects a multi-byte password that is under 72 chars but over 72 UTF-8 bytes', () => {
    // 30 CJK chars = 30 UTF-16 code units, but 90 UTF-8 bytes — bcrypt would
    // silently truncate at byte 72, so this must be rejected
    const password = '密'.repeat(30);
    expect(password.length).toBeLessThanOrEqual(LIMITS.PASSWORD_MAX);

    const err = validatePassword(password);
    expect(err).not.toBeNull();
    expect(err).toContain('bytes');
  });

  it('rejects passwords below PASSWORD_MIN', () => {
    const err = validatePassword('a'.repeat(LIMITS.PASSWORD_MIN - 1));
    expect(err).not.toBeNull();
    expect(err).toContain(`at least ${LIMITS.PASSWORD_MIN}`);
  });
});

// ─── Registration abuse defenses ─────────────────────────────────────────────

import { canonicalizeEmail, isDisposableEmailDomain } from '@voxium/shared';

describe('canonicalizeEmail', () => {
  it('collapses gmail dot/plus aliases to one canonical inbox', () => {
    // THE bot vector: every one of these is the same mailbox
    for (const alias of [
      'john.doe@gmail.com',
      'j.o.h.n.d.o.e@gmail.com',
      'johndoe+voxium@gmail.com',
      'John.Doe+a.b.c@GMAIL.COM',
      'johndoe@googlemail.com'.replace('googlemail', 'gmail'),
    ]) {
      expect(canonicalizeEmail(alias)).toBe('johndoe@gmail.com');
    }
    expect(canonicalizeEmail('j.doe@googlemail.com')).toBe('jdoe@googlemail.com');
  });

  it('leaves other providers untouched beyond lowercase/trim — dots are significant there', () => {
    expect(canonicalizeEmail('  John.Doe@Example.com ')).toBe('john.doe@example.com');
    expect(canonicalizeEmail('user+tag@proton.me')).toBe('user+tag@proton.me');
  });

  it('is safe on malformed input', () => {
    expect(canonicalizeEmail('not-an-email')).toBe('not-an-email');
    expect(canonicalizeEmail('')).toBe('');
  });
});

describe('isDisposableEmailDomain', () => {
  it('flags known disposable providers, case-insensitively', () => {
    expect(isDisposableEmailDomain('bot@mailinator.com')).toBe(true);
    expect(isDisposableEmailDomain('bot@YOPMAIL.com')).toBe(true);
    expect(isDisposableEmailDomain('x@10minutemail.net')).toBe(true);
  });

  it('passes normal providers and malformed input', () => {
    expect(isDisposableEmailDomain('user@gmail.com')).toBe(false);
    expect(isDisposableEmailDomain('user@proton.me')).toBe(false);
    expect(isDisposableEmailDomain('no-at-sign')).toBe(false);
  });
});
