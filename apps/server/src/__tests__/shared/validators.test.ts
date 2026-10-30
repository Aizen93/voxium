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

import { validateEmail } from '@voxium/shared';

describe('Shared validators — validateEmail (one mailbox, as the mailer reads it)', () => {
  it.each([
    'alice@example.com',
    'first.last@example.co.uk',
    'alice+newsletter@example.com',
    'o\'brien@example.ie',
    'user-name_1@sub.domain.example',
    'jürgen@müller.de',
    'a@b.co',
    'x@mail-1.a-b.example.co.uk',
  ])('accepts %s', (email) => {
    expect(validateEmail(email)).toBeNull();
  });

  it.each([
    ['a comment after the domain', 'victim@gmail.com(1)'],
    ['a comment in the local part', 'victim(1)@gmail.com'],
    ['a comment that looks like a TLD', 'x@mailinator.com(.org)'],
    ['a list separator', 'a,victim@corp.com'],
    ['a group/semicolon tail', 'victim@corp.com;x.y'],
    ['an angle-addr', '<victim@corp.com>'],
    ['a quoted local part', '"victim"@corp.com'],
    ['a domain literal', 'victim@[127.0.0.1].com'],
    ['a colon', 'victim:x@corp.com'],
    ['a backslash', 'vic\tim@corp.com'],
    ['a space', 'vic tim@corp.com'],
    ['a tab', 'victim@corp.com\t'],
    ['a control character', 'victim\u0001@corp.com'],
    ['a DEL character', 'victim\u007f@corp.com'],
    ['two @', 'a@b@corp.com'],
    ['no @', 'victim.corp.com'],
    ['no dot in the domain', 'victim@localhost'],
    ['an empty local part', '@corp.com'],
    ['a trailing dot after the domain', 'a@gmail.com.'],
    ['a trailing dot after a listed domain', 'a@mailinator.com.'],
    ['two trailing dots', 'a@gmail.com..'],
    ['a leading dot in the domain', 'a@.gmail.com'],
    ['two dots in a row in the domain', 'a@gmail..com'],
    ['a domain that is only dots', 'a@..'],
  ])('refuses %s', (_label, email) => {
    expect(validateEmail(email)).toBe('Invalid email address');
  });

  it('caps the whole address at 254 characters (RFC 5321)', () => {
    // a 64-character local part, the domain padded to make exactly 254
    const local = 'a'.repeat(64);
    const host = 'b'.repeat(254 - local.length - '@'.length - '.com'.length);
    expect(`${local}@${host}.com`).toHaveLength(LIMITS.EMAIL_MAX);
    expect(validateEmail(`${local}@${host}.com`)).toBeNull();
    expect(validateEmail(`${local}@${host}x.com`)).toBe('Invalid email address');
  });

  it('caps the local part at 64 characters', () => {
    expect(validateEmail(`${'a'.repeat(64)}@example.com`)).toBeNull();
    expect(validateEmail(`${'a'.repeat(65)}@example.com`)).toBe('Invalid email address');
  });

  it('refuses the 98 KB comma list that made the address parser quadratic, in linear time', () => {
    const list = 'a,'.repeat(49_000) + 'a@b.co';
    const started = performance.now();
    expect(validateEmail(list)).toBe('Invalid email address');
    expect(performance.now() - started).toBeLessThan(50);
  });
});
