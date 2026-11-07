import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'test-jwt-secret-for-mail-suppression';

const { mailSuppression } = vi.hoisted(() => ({
  mailSuppression: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
}));
vi.mock('../../utils/prisma', () => ({ prisma: { mailSuppression } }));

import {
  mailboxOf,
  mailboxDigest,
  mailBlockToken,
  mailBlockUrl,
  readMailBlockToken,
  isMailSuppressed,
  isDigestSuppressed,
  suppressDigest,
  unsuppressDigest,
} from '../../utils/mailSuppression';

/**
 * "Not you? Block Voxium mail to this address": the list is keyed on the
 * MAILBOX, the key is a digest and never the address, and the only credential
 * that can touch an entry is the token mailed to that very mailbox.
 */

beforeEach(() => {
  mailSuppression.findUnique.mockReset();
  mailSuppression.upsert.mockReset().mockResolvedValue({});
  mailSuppression.deleteMany.mockReset().mockResolvedValue({ count: 1 });
});

describe('mailboxOf — the mailbox an address delivers to', () => {
  it('lowercases and trims, like every other e-mail lookup', () => {
    expect(mailboxOf('  Alice@Example.COM ')).toBe('alice@example.com');
  });

  it('folds a +tag into the mailbox for EVERY domain, not only the gmail family', () => {
    expect(mailboxOf('victim+1@outlook.com')).toBe('victim@outlook.com');
    expect(mailboxOf('victim+voxium@proton.me')).toBe('victim@proton.me');
    expect(mailboxOf('victim+a+b@fastmail.com')).toBe('victim@fastmail.com');
  });

  it('keeps the gmail-family canonical form (dots stripped too)', () => {
    expect(mailboxOf('J.o.h.n+x@gmail.com')).toBe('john@gmail.com');
    expect(mailboxOf('j.o.h.n@googlemail.com')).toBe('john@googlemail.com');
  });

  it('keeps dots on every other domain — they are significant there', () => {
    expect(mailboxOf('first.last@example.org')).toBe('first.last@example.org');
  });

  it('passes a string without @ through unchanged (lowercased)', () => {
    expect(mailboxOf('Nonsense')).toBe('nonsense');
  });
});

describe('mailboxDigest — what the table stores', () => {
  it('is a SHA-256 hex of the mailbox under a fixed domain prefix, never the address', () => {
    const expected = createHash('sha256').update('voxium-mail-suppression:alice@example.com').digest('hex');
    expect(mailboxDigest('Alice@example.com')).toBe(expected);
    expect(mailboxDigest('alice@example.com')).toMatch(/^[0-9a-f]{64}$/);
    expect(mailboxDigest('alice@example.com')).not.toContain('alice');
  });

  it('gives every spelling of one mailbox the same key', () => {
    const base = mailboxDigest('victim@outlook.com');
    expect(mailboxDigest('Victim+1@outlook.com')).toBe(base);
    expect(mailboxDigest('victim+anything@outlook.com ')).toBe(base);
    expect(mailboxDigest('other@outlook.com')).not.toBe(base);
  });

  it('is NOT keyed on a secret: the list must survive a JWT_SECRET rotation', () => {
    const before = mailboxDigest('alice@example.com');
    const saved = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'a-rotated-secret';
    try {
      expect(mailboxDigest('alice@example.com')).toBe(before);
    } finally {
      process.env.JWT_SECRET = saved;
    }
  });
});

describe('mailBlockToken / readMailBlockToken — the credential in the link', () => {
  it('round-trips to the mailbox digest', () => {
    const token = mailBlockToken('victim+7@outlook.com');
    expect(readMailBlockToken(token)).toBe(mailboxDigest('victim@outlook.com'));
  });

  it('carries the digest and a purpose, never the address', () => {
    const payload = jwt.decode(mailBlockToken('alice@example.com')) as Record<string, unknown>;
    expect(payload.purpose).toBe('mail-block');
    expect(payload.m).toBe(mailboxDigest('alice@example.com'));
    expect(JSON.stringify(payload)).not.toContain('alice');
    expect(payload).not.toHaveProperty('userId');
  });

  it('lives a year — a victim may act on an old e-mail', () => {
    const payload = jwt.decode(mailBlockToken('alice@example.com')) as { iat: number; exp: number };
    expect(payload.exp - payload.iat).toBe(365 * 24 * 3600);
  });

  it('is signed HS256 with JWT_SECRET and verified with the algorithm pinned', () => {
    const token = mailBlockToken('alice@example.com');
    expect(() => jwt.verify(token, process.env.JWT_SECRET!, { algorithms: ['HS256'] })).not.toThrow();
    const forged = jwt.sign({ purpose: 'mail-block', m: mailboxDigest('alice@example.com') }, 'another-secret', { algorithm: 'HS256' });
    expect(readMailBlockToken(forged)).toBeNull();
  });

  it('refuses garbage, an expired token and a token of another purpose, all as null', () => {
    expect(readMailBlockToken('not-a-token')).toBeNull();
    expect(readMailBlockToken('')).toBeNull();
    const expired = jwt.sign({ purpose: 'mail-block', m: mailboxDigest('a@b.c') }, process.env.JWT_SECRET!, { algorithm: 'HS256', expiresIn: -10 });
    expect(readMailBlockToken(expired)).toBeNull();
    // An access token, a TOTP challenge or a trusted-device token must not open the block page
    const access = jwt.sign({ userId: 'u-1', username: 'alice' }, process.env.JWT_SECRET!, { algorithm: 'HS256' });
    expect(readMailBlockToken(access)).toBeNull();
    const totp = jwt.sign({ userId: 'u-1', purpose: 'totp-verify' }, process.env.JWT_SECRET!, { algorithm: 'HS256' });
    expect(readMailBlockToken(totp)).toBeNull();
  });

  it('refuses a digest that is not 64 hex characters (a forged payload cannot pick an arbitrary key)', () => {
    const odd = jwt.sign({ purpose: 'mail-block', m: 'alice@example.com' }, process.env.JWT_SECRET!, { algorithm: 'HS256' });
    expect(readMailBlockToken(odd)).toBeNull();
    const short = jwt.sign({ purpose: 'mail-block', m: 'abc' }, process.env.JWT_SECRET!, { algorithm: 'HS256' });
    expect(readMailBlockToken(short)).toBeNull();
    const missing = jwt.sign({ purpose: 'mail-block' }, process.env.JWT_SECRET!, { algorithm: 'HS256' });
    expect(readMailBlockToken(missing)).toBeNull();
  });

  it('rethrows what is not a token refusal (a missing secret is a configuration error, not a 400)', () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      expect(() => readMailBlockToken('whatever')).toThrow('JWT_SECRET is not configured');
      expect(() => mailBlockToken('alice@example.com')).toThrow('JWT_SECRET is not configured');
    } finally {
      process.env.JWT_SECRET = saved;
    }
  });

  it('mailBlockUrl points at the client page with the token in the path', () => {
    const saved = process.env.CLIENT_URL;
    process.env.CLIENT_URL = 'https://app.example.test';
    try {
      const url = mailBlockUrl('alice@example.com');
      expect(url.startsWith('https://app.example.test/mail-block/')).toBe(true);
      expect(readMailBlockToken(url.slice('https://app.example.test/mail-block/'.length))).toBe(mailboxDigest('alice@example.com'));
    } finally {
      if (saved === undefined) delete process.env.CLIENT_URL; else process.env.CLIENT_URL = saved;
    }
  });
});

describe('isMailSuppressed — what every user-facing sender asks', () => {
  it('looks the MAILBOX digest up, and answers true for a listed row', async () => {
    mailSuppression.findUnique.mockResolvedValueOnce({ mailboxHash: mailboxDigest('victim@outlook.com') });
    await expect(isMailSuppressed('Victim+99@outlook.com')).resolves.toBe(true);
    expect(mailSuppression.findUnique).toHaveBeenCalledWith({
      where: { mailboxHash: mailboxDigest('victim@outlook.com') },
      select: { mailboxHash: true },
    });
  });

  it('answers false for an unlisted mailbox', async () => {
    mailSuppression.findUnique.mockResolvedValueOnce(null);
    await expect(isMailSuppressed('alice@example.com')).resolves.toBe(false);
  });

  it('FAILS OPEN on a store error, logging without the address', async () => {
    mailSuppression.findUnique.mockRejectedValueOnce(new Error('connection refused'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(isMailSuppressed('alice@example.com')).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith('[MailSuppression] Lookup failed (allowing send):', 'connection refused');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('alice@example.com');
    warn.mockRestore();
  });
});

describe('the three writes the block page makes', () => {
  const digest = mailboxDigest('victim@outlook.com');

  it('isDigestSuppressed reads the row by digest and does NOT swallow errors (the route answers them)', async () => {
    mailSuppression.findUnique.mockResolvedValueOnce({ mailboxHash: digest });
    await expect(isDigestSuppressed(digest)).resolves.toBe(true);
    mailSuppression.findUnique.mockResolvedValueOnce(null);
    await expect(isDigestSuppressed(digest)).resolves.toBe(false);
    mailSuppression.findUnique.mockRejectedValueOnce(new Error('down'));
    await expect(isDigestSuppressed(digest)).rejects.toThrow('down');
  });

  it('suppressDigest upserts, so a second click is not a conflict', async () => {
    await suppressDigest(digest);
    expect(mailSuppression.upsert).toHaveBeenCalledWith({
      where: { mailboxHash: digest },
      create: { mailboxHash: digest },
      update: {},
    });
  });

  it('unsuppressDigest deletes by digest and tolerates an absent row', async () => {
    mailSuppression.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(unsuppressDigest(digest)).resolves.toBeUndefined();
    expect(mailSuppression.deleteMany).toHaveBeenCalledWith({ where: { mailboxHash: digest } });
  });
});
