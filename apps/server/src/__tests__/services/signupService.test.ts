import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  SIGNUP, USERNAME_TAKEN_MESSAGE, SIGNUP_CODE_INVALID_MESSAGE, SIGNUP_EMAIL_REGISTERED_MESSAGE,
} from '@voxium/shared';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-for-testing-12345';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-jwt-refresh-secret-key-12345';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => {
  const tx = {
    user: { create: vi.fn() },
    pendingRegistration: { delete: vi.fn() },
  };
  return {
    tx,
    prisma: {
      ipBan: { findUnique: vi.fn() },
      user: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
      pendingRegistration: {
        create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(),
      },
      signupMailLedger: { deleteMany: vi.fn() },
      ipRecord: { create: vi.fn(), upsert: vi.fn() },
      mailSuppression: { findUnique: vi.fn() },
      $queryRaw: vi.fn(),
      $transaction: vi.fn(),
    },
    sendCode: vi.fn(),
    sendExisting: vi.fn(),
    mailSuppressed: vi.fn(),
    domainCount: vi.fn(),
    domainConsume: vi.fn(),
    deleteUserAccount: vi.fn(),
    geoLookup: vi.fn(),
    bcryptHash: vi.fn(),
  };
});

vi.mock('../../utils/prisma', () => ({ prisma: h.prisma }));

vi.mock('../../utils/email', () => ({
  sendSignupCodeEmail: (...a: unknown[]) => h.sendCode(...a),
  sendSignupExistingAccountEmail: (...a: unknown[]) => h.sendExisting(...a),
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  describeEmailError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  // A real class: the service tells it apart with instanceof
  MailSuppressedError: class MailSuppressedError extends Error {
    constructor() { super('Mail to this address is blocked'); this.name = 'MailSuppressedError'; }
  },
}));

// mailboxDigest is pure and IS the ledger key: the real one is under test.
vi.mock('../../utils/mailSuppression', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/mailSuppression')>();
  return { ...actual, isMailSuppressed: (...a: unknown[]) => h.mailSuppressed(...a) };
});

vi.mock('../../utils/redis', () => ({
  getRedis: () => ({ incr: vi.fn(), expire: vi.fn(), get: vi.fn() }),
}));

vi.mock('../../middleware/rateLimiter', async (importOriginal) => {
  // normalizeIp is pure: the real one is what ban matching and the IP record
  // must agree with, so it is NOT stubbed.
  const actual = await importOriginal<typeof import('../../middleware/rateLimiter')>();
  return {
    normalizeIp: actual.normalizeIp,
    getDomainRegistrationCount: (...a: unknown[]) => h.domainCount(...a),
    countDomainRegistration: (...a: unknown[]) => h.domainConsume(...a),
    domainRegistrationCap: () => 10,
    consumeMailCap: vi.fn().mockResolvedValue(true),
  };
});

vi.mock('../../utils/accountDeletion', () => ({
  deleteUserAccount: (...a: unknown[]) => h.deleteUserAccount(...a),
}));

vi.mock('geoip-lite', () => ({ default: { lookup: (...a: unknown[]) => h.geoLookup(...a) } }));

// bcrypt at cost 12 is ~250 ms a call: record the cost the service asks for,
// hash for real at cost 4 so the stored value is still a bcrypt hash.
vi.mock('bcryptjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bcryptjs')>();
  const real = (actual as unknown as { default?: typeof actual }).default ?? actual;
  const hash = (password: string, rounds: number) => {
    h.bcryptHash(password, rounds);
    return real.hash(password, 4);
  };
  return { ...actual, default: { ...real, hash }, hash };
});

import { prisma } from '../../utils/prisma';
import { mailboxDigest } from '../../utils/mailSuppression';
import { MailSuppressedError } from '../../utils/email';
import {
  startRegistration, completeRegistration, resendRegistrationCode, claimSignupMailSlot,
  purgeExpiredSignupState, signupCodeHash,
} from '../../services/signupService';

// ─── Helpers ────────────────────────────────────────────────────────────────

const CONSENT = { acceptTerms: true, acceptPrivacy: true } as const;
const PASSWORD = 'ValidPass123';
const MINUTE = 60_000;

type QueryCall = [TemplateStringsArray, ...unknown[]];
const queryCalls = () => vi.mocked(prisma.$queryRaw).mock.calls as unknown as QueryCall[];
const ledgerCalls = () => queryCalls().filter((c) => c[0].join('?').includes('signup_mail_ledger'));

/** findFirst answers by question: the username lookup, or the holder of the address. */
function users(opts: { nameTaken?: boolean; holder?: { emailVerified: boolean } | null } = {}) {
  h.prisma.user.findFirst.mockImplementation(async (args: { where: Record<string, unknown> }) => {
    if ('username' in args.where) return opts.nameTaken ? { id: 'someone' } : null;
    return opts.holder ?? null;
  });
}

const createdRow = () => h.prisma.pendingRegistration.create.mock.calls[0][0].data as Record<string, unknown> & {
  id: string; codeHash: string; passwordHash: string; lastSentAt: Date | null; expiresAt: Date; codeExpiresAt: Date;
  termsAcceptedAt: Date; privacyAcceptedAt: Date; ip: string | null; email: string; emailCanonical: string; displayName: string;
};

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  vi.resetAllMocks();
  h.prisma.ipBan.findUnique.mockResolvedValue(null);
  users();
  h.prisma.user.findMany.mockResolvedValue([]);
  h.prisma.pendingRegistration.create.mockResolvedValue({});
  h.prisma.pendingRegistration.update.mockResolvedValue({});
  h.prisma.pendingRegistration.updateMany.mockResolvedValue({ count: 1 });
  h.prisma.pendingRegistration.delete.mockResolvedValue({});
  h.prisma.ipRecord.create.mockResolvedValue({});
  h.prisma.$queryRaw.mockResolvedValue([{ sent: 1 }]);
  h.prisma.$transaction.mockImplementation(async (cb: (tx: typeof h.tx) => unknown) => cb(h.tx));
  h.tx.pendingRegistration.delete.mockResolvedValue({});
  h.sendCode.mockResolvedValue(undefined);
  h.sendExisting.mockResolvedValue(undefined);
  h.mailSuppressed.mockResolvedValue(false);
  h.domainCount.mockResolvedValue(0);
  h.domainConsume.mockResolvedValue(undefined);
  h.deleteUserAccount.mockResolvedValue(undefined);
  h.geoLookup.mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── signupCodeHash ─────────────────────────────────────────────────────────

describe('signupCodeHash', () => {
  it('is sha256(pendingId:code) in hex, and binds the id', () => {
    expect(signupCodeHash('p1', '123456')).toMatch(/^[0-9a-f]{64}$/);
    expect(signupCodeHash('p1', '123456')).toBe(signupCodeHash('p1', '123456'));
    expect(signupCodeHash('p1', '123456')).not.toBe(signupCodeHash('p2', '123456'));
    expect(signupCodeHash('p1', '123456')).not.toBe(signupCodeHash('p1', '123457'));
  });
});

// ─── claimSignupMailSlot ────────────────────────────────────────────────────

describe('claimSignupMailSlot', () => {
  it('takes the slot in ONE conditional upsert and reports whether a row came back', async () => {
    h.prisma.$queryRaw.mockResolvedValueOnce([{ sent: 2 }]);
    await expect(claimSignupMailSlot('d'.repeat(64))).resolves.toBe(true);

    expect(queryCalls()).toHaveLength(1);
    const [strings, ...values] = queryCalls()[0];
    const sql = strings.join('?');
    expect(sql).toContain('INSERT INTO signup_mail_ledger');
    expect(sql).toContain('ON CONFLICT (mailbox_hash) DO UPDATE');
    expect(sql).toMatch(/WHERE[\s\S]*sent </);
    expect(sql).toContain('RETURNING sent');
    expect(values).toContain('d'.repeat(64));
    expect(values).toContain(SIGNUP.LEDGER_WINDOW_DAYS);
    expect(values).toContain(SIGNUP.LEDGER_MAX_MAILS);
  });

  it('takes the max the caller asks for (the existing-account notice asks one)', async () => {
    await claimSignupMailSlot('d'.repeat(64), SIGNUP.LEDGER_MAX_NOTICES);
    const [strings, ...values] = queryCalls()[0];
    expect(strings.join('?')).toMatch(/OR signup_mail_ledger\.sent < \?/);
    expect(values.at(-1)).toBe(SIGNUP.LEDGER_MAX_NOTICES);
    expect(SIGNUP.LEDGER_MAX_NOTICES).toBe(1);
  });

  it('answers false when the window is used up (the conditional update returned nothing)', async () => {
    h.prisma.$queryRaw.mockResolvedValueOnce([]);
    await expect(claimSignupMailSlot('d'.repeat(64))).resolves.toBe(false);
  });

  it('fails CLOSED on a store error: no mail, logged without throwing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.prisma.$queryRaw.mockRejectedValueOnce(new Error('db gone'));
    await expect(claimSignupMailSlot('d'.repeat(64))).resolves.toBe(false);
    expect(error).toHaveBeenCalledWith('[Signup] Mail ledger write failed (no mail sent):', 'db gone');
    error.mockRestore();
  });
});

// ─── startRegistration ──────────────────────────────────────────────────────

describe('startRegistration — refusals', () => {
  it.each([
    ['no consent', undefined],
    ['terms only', { acceptTerms: true, acceptPrivacy: false }],
    ['privacy only', { acceptTerms: false, acceptPrivacy: true }],
    ['truthy strings', { acceptTerms: 'true', acceptPrivacy: 'true' }],
  ])('refuses %s before any work', async (_label, consent) => {
    await expect(startRegistration('testuser', 'test@example.com', PASSWORD, undefined, undefined, consent as never))
      .rejects.toMatchObject({ statusCode: 400, message: 'You must accept the Terms of Service and the Privacy Policy' });
    expect(h.bcryptHash).not.toHaveBeenCalled();
    expect(prisma.pendingRegistration.create).not.toHaveBeenCalled();
  });

  it.each([
    ['a short username', 'ab', 'test@example.com', PASSWORD, /Username/],
    ['an invalid e-mail', 'testuser', 'not-an-email', PASSWORD, /email/i],
    ['a password over bcrypt\'s 72 bytes', 'testuser', 'test@example.com', 'A'.repeat(73), /Password/],
    ['a short password', 'testuser', 'test@example.com', 'short', /Password/],
  ])('refuses %s with a 400 before any lookup', async (_label, username, email, password, message) => {
    await expect(startRegistration(username, email, password, undefined, '203.0.113.9', CONSENT))
      .rejects.toMatchObject({ statusCode: 400, message });
    expect(prisma.ipBan.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.pendingRegistration.create).not.toHaveBeenCalled();
  });

  it.each(['victim@gmail.com(1)', 'victim(1)@gmail.com', 'a,victim@corp.com', `${'a,'.repeat(40_000)}a@b.co`])(
    'refuses an address the mailer would read differently (%#) before any lookup or mail',
    async (email) => {
      await expect(startRegistration('testuser', email, PASSWORD, undefined, undefined, CONSENT))
        .rejects.toThrow('Invalid email address');
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(prisma.pendingRegistration.create).not.toHaveBeenCalled();
      expect(queryCalls()).toHaveLength(0);
      expect(h.sendCode).not.toHaveBeenCalled();
      expect(h.sendExisting).not.toHaveBeenCalled();
    },
  );

  it('refuses a banned address (normalized from IPv4-mapped IPv6) before the username lookup', async () => {
    h.prisma.ipBan.findUnique.mockResolvedValueOnce({ id: 'ban-1', ip: '203.0.113.9', reason: 'bot wave' });
    await expect(startRegistration('testuser', 'test@example.com', PASSWORD, undefined, '::FFFF:203.0.113.9', CONSENT))
      .rejects.toMatchObject({ statusCode: 403, message: 'Account banned: bot wave' });
    expect(prisma.ipBan.findUnique).toHaveBeenCalledWith({ where: { ip: '203.0.113.9' } });
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.pendingRegistration.create).not.toHaveBeenCalled();
  });

  it('a ban without a reason answers the generic ban message', async () => {
    h.prisma.ipBan.findUnique.mockResolvedValueOnce({ id: 'ban-1', ip: '203.0.113.9', reason: null });
    await expect(startRegistration('testuser', 'test@example.com', PASSWORD, undefined, '203.0.113.9', CONSENT))
      .rejects.toMatchObject({ statusCode: 403, message: 'Your account has been banned' });
  });

  it('a taken username is the ONE synchronous conflict: 409, matched case-insensitively, nothing stored or mailed', async () => {
    users({ nameTaken: true });
    await expect(startRegistration('Alice', 'brand-new@example.com', PASSWORD, undefined, undefined, CONSENT))
      .rejects.toMatchObject({ statusCode: 409, message: USERNAME_TAKEN_MESSAGE });
    expect(prisma.user.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { username: { equals: 'Alice', mode: 'insensitive' } },
      select: { id: true },
    });
    expect(h.bcryptHash).not.toHaveBeenCalled();
    expect(prisma.pendingRegistration.create).not.toHaveBeenCalled();
    expect(queryCalls()).toHaveLength(0);
    expect(h.sendCode).not.toHaveBeenCalled();
  });
});

describe('startRegistration — the same answer after the same work on every branch', () => {
  type Scenario = {
    email: string;
    setup: () => void;
    mail: 'code' | 'existing' | 'none';
    ledger: boolean;
  };
  const scenarios: Array<[string, Scenario]> = [
    ['a new address', { email: 'new@smallcorp.example', setup: () => {}, mail: 'code', ledger: true }],
    ['an address with a VERIFIED account (notice, never a code)', {
      email: 'owner@smallcorp.example', setup: () => users({ holder: { emailVerified: true } }), mail: 'existing', ledger: true,
    }],
    ['an address held by an UNVERIFIED legacy account (still a code)', {
      email: 'legacy@smallcorp.example', setup: () => users({ holder: { emailVerified: false } }), mail: 'code', ledger: true,
    }],
    ['a disposable domain', { email: 'bot@mailinator.com', setup: () => {}, mail: 'none', ledger: false }],
    ['a mailbox that blocked Voxium mail', {
      email: 'victim@smallcorp.example', setup: () => h.mailSuppressed.mockResolvedValue(true), mail: 'none', ledger: false,
    }],
    ['a verified holder whose mailbox is blocked', {
      email: 'owner@smallcorp.example',
      setup: () => { users({ holder: { emailVerified: true } }); h.mailSuppressed.mockResolvedValue(true); },
      mail: 'none', ledger: false,
    }],
    ['a novel domain over its daily cap', {
      email: 'bot@catchall.example', setup: () => h.domainCount.mockResolvedValue(10), mail: 'none', ledger: false,
    }],
    ['a mailbox whose sign-up mails are used up', {
      email: 'new@smallcorp.example', setup: () => h.prisma.$queryRaw.mockResolvedValue([]), mail: 'none', ledger: true,
    }],
    ['a ledger the store cannot write', {
      email: 'new@smallcorp.example',
      setup: () => { h.prisma.$queryRaw.mockRejectedValue(new Error('db gone')); vi.spyOn(console, 'error').mockImplementation(() => {}); },
      mail: 'none', ledger: true,
    }],
  ];

  afterEach(() => { vi.restoreAllMocks(); });

  it.each(scenarios)('%s', async (_label, s) => {
    s.setup();
    const before = Date.now();
    const result = await startRegistration('newuser', s.email, PASSWORD, undefined, undefined, CONSENT);
    await flush();

    // One pending row, whatever the branch
    expect(prisma.pendingRegistration.create).toHaveBeenCalledTimes(1);
    const row = createdRow();
    // ...and the answer is that row's id with the one fixed delay, nothing else
    expect(result).toEqual({ pendingId: row.id, resendAfterSeconds: SIGNUP.RESEND_AFTER_SECONDS });
    expect(result.pendingId).toMatch(/^[A-Za-z0-9_-]{22}$/);

    // The same work: bcrypt at cost 12, both user lookups, the suppression read
    expect(h.bcryptHash).toHaveBeenCalledTimes(1);
    expect(h.bcryptHash).toHaveBeenCalledWith(PASSWORD, 12);
    expect(row.passwordHash).toMatch(/^\$2[ab]\$/);
    expect(prisma.user.findFirst).toHaveBeenCalledTimes(2);
    expect(h.mailSuppressed).toHaveBeenCalledWith(s.email);

    // The row: consent recorded at the start, the lifetimes, a stored code hash
    expect(row.termsAcceptedAt).toBeInstanceOf(Date);
    expect(row.privacyAcceptedAt).toBeInstanceOf(Date);
    expect(row.termsAcceptedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.expiresAt.getTime() - before).toBeGreaterThanOrEqual(SIGNUP.PENDING_TTL_MINUTES * MINUTE - 1000);
    expect(row.expiresAt.getTime() - before).toBeLessThanOrEqual(SIGNUP.PENDING_TTL_MINUTES * MINUTE + 5000);
    expect(row.codeExpiresAt.getTime() - before).toBeGreaterThanOrEqual(SIGNUP.CODE_TTL_MINUTES * MINUTE - 1000);
    expect(row.codeExpiresAt.getTime() - before).toBeLessThanOrEqual(SIGNUP.CODE_TTL_MINUTES * MINUTE + 5000);
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);

    // Nothing is counted against the domain until an account exists
    expect(h.domainConsume).not.toHaveBeenCalled();

    expect(ledgerCalls()).toHaveLength(s.ledger ? 1 : 0);
    if (s.ledger) {
      expect(ledgerCalls()[0]).toContain(mailboxDigest(s.email));
      // The notice claims under its own, tighter max; a code under the shared one
      expect(ledgerCalls()[0].at(-1)).toBe(s.mail === 'existing' ? SIGNUP.LEDGER_MAX_NOTICES : SIGNUP.LEDGER_MAX_MAILS);
    }

    if (s.mail === 'code') {
      expect(h.sendCode).toHaveBeenCalledTimes(1);
      const [to, code, minutes] = h.sendCode.mock.calls[0];
      expect(to).toBe(s.email);
      expect(code).toMatch(/^\d{6}$/);
      expect(minutes).toBe(SIGNUP.CODE_TTL_MINUTES);
      // The stored hash is the hash of the code that was mailed
      expect(row.codeHash).toBe(signupCodeHash(row.id, code));
      expect(row.lastSentAt).toBeInstanceOf(Date);
      expect(h.sendExisting).not.toHaveBeenCalled();
    } else {
      expect(h.sendCode).not.toHaveBeenCalled();
      // A row that mailed no code can never resend one
      expect(row.lastSentAt).toBeNull();
      if (s.mail === 'existing') {
        expect(h.sendExisting).toHaveBeenCalledWith(s.email);
      } else {
        expect(h.sendExisting).not.toHaveBeenCalled();
      }
    }
  });

  it('a silent branch stores the hash of a code nobody was given (no six-digit code matches it)', async () => {
    h.mailSuppressed.mockResolvedValue(true);
    await startRegistration('newuser', 'victim@smallcorp.example', PASSWORD, undefined, undefined, CONSENT);
    const row = createdRow();
    // The decoy code is a six-digit code plus 16 hex characters: spot-check a
    // spread of six-digit codes, none can match it.
    for (const code of ['000000', '123456', '999999', '424242', '100000']) {
      expect(row.codeHash).not.toBe(signupCodeHash(row.id, code));
    }
  });

  it('checks the domain cap only on a branch that would mail a code, and never for a common provider', async () => {
    await startRegistration('newuser', 'human@gmail.com', PASSWORD, undefined, undefined, CONSENT);
    expect(h.domainCount).not.toHaveBeenCalled();
    expect(h.sendCode).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    await startRegistration('newuser', 'a@smallcorp.example', PASSWORD, undefined, undefined, CONSENT);
    expect(h.domainCount).toHaveBeenCalledWith('smallcorp.example');

    vi.clearAllMocks();
    users({ holder: { emailVerified: true } });
    await startRegistration('newuser', 'b@smallcorp.example', PASSWORD, undefined, undefined, CONSENT);
    expect(h.domainCount).not.toHaveBeenCalled();
  });

  it('a verified mailbox gets at most ONE existing-account notice per window: a second start mails nothing', async () => {
    users({ holder: { emailVerified: true } });
    await startRegistration('newuser', 'owner@smallcorp.example', PASSWORD, undefined, undefined, CONSENT);
    // The window now holds the notice: the conditional upsert returns no row
    h.prisma.$queryRaw.mockResolvedValueOnce([]);
    const second = await startRegistration('newuser2', 'owner@smallcorp.example', PASSWORD, undefined, undefined, CONSENT);
    await flush();

    expect(h.sendExisting).toHaveBeenCalledTimes(1);
    expect(h.sendCode).not.toHaveBeenCalled();
    expect(second).toEqual({ pendingId: expect.any(String), resendAfterSeconds: SIGNUP.RESEND_AFTER_SECONDS });
    expect(ledgerCalls()).toHaveLength(2);
    for (const call of ledgerCalls()) expect(call.at(-1)).toBe(SIGNUP.LEDGER_MAX_NOTICES);
  });

  it('one mailbox, one ledger key: dotted and +tagged spellings claim the SAME slot', async () => {
    await startRegistration('newuser', 'V.i.c.t.i.m+1@GMAIL.com', PASSWORD, undefined, undefined, CONSENT);
    await startRegistration('newuser2', 'victim@gmail.com', PASSWORD, undefined, undefined, CONSENT);
    const [first, second] = ledgerCalls();
    const digest = mailboxDigest('victim@gmail.com');
    expect(first).toContain(digest);
    expect(second).toContain(digest);
  });

  it('stores the address as typed (lowercased, trimmed) next to its canonical form', async () => {
    await startRegistration('newuser', '  John.Doe+x@GMAIL.com ', PASSWORD, undefined, undefined, CONSENT);
    const row = createdRow();
    expect(row.email).toBe('john.doe+x@gmail.com');
    expect(row.emailCanonical).toBe('johndoe@gmail.com');
    // The holder lookup covers both spellings
    const holderWhere = vi.mocked(prisma.user.findFirst).mock.calls[1][0]!.where as { OR: unknown[] };
    expect(holderWhere.OR).toEqual([{ email: 'john.doe+x@gmail.com' }, { emailCanonical: 'johndoe@gmail.com' }]);
    expect(h.sendCode.mock.calls[0][0]).toBe('john.doe+x@gmail.com');
  });

  it('stores the normalized address the start came from, and none when it is unknown', async () => {
    await startRegistration('newuser', 'a@example.com', PASSWORD, undefined, '::ffff:203.0.113.9', CONSENT);
    expect(prisma.ipBan.findUnique).toHaveBeenCalledWith({ where: { ip: '203.0.113.9' } });
    expect(createdRow().ip).toBe('203.0.113.9');

    vi.clearAllMocks();
    await startRegistration('newuser', 'a@example.com', PASSWORD, undefined, undefined, CONSENT);
    expect(prisma.ipBan.findUnique).not.toHaveBeenCalled();
    expect(createdRow().ip).toBeNull();
  });

  it('sanitizes the display name and falls back to the username', async () => {
    await startRegistration('newuser', 'a@example.com', PASSWORD, '<b>Alice</b> ', undefined, CONSENT);
    expect(createdRow().displayName).toBe('Alice');

    vi.clearAllMocks();
    await startRegistration('newuser', 'a@example.com', PASSWORD, undefined, undefined, CONSENT);
    expect(createdRow().displayName).toBe('newuser');
  });

  it('every start gets a fresh pending id', async () => {
    const a = await startRegistration('newuser', 'a@example.com', PASSWORD, undefined, undefined, CONSENT);
    const b = await startRegistration('newuser', 'a@example.com', PASSWORD, undefined, undefined, CONSENT);
    expect(a.pendingId).not.toBe(b.pendingId);
  });
});

describe('startRegistration — the mail is fire-and-forget', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('answers while the transport still hangs', async () => {
    let release: () => void = () => {};
    h.sendCode.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    await expect(startRegistration('newuser', 'a@example.com', PASSWORD, undefined, undefined, CONSENT))
      .resolves.toMatchObject({ resendAfterSeconds: SIGNUP.RESEND_AFTER_SECONDS });
    release();
  });

  it('a blocked mailbox refused by the sender is logged at WARN, without the address', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.sendCode.mockRejectedValueOnce(new MailSuppressedError());

    await startRegistration('newuser', 'victim@example.com', PASSWORD, undefined, undefined, CONSENT);
    await flush();

    expect(warn).toHaveBeenCalledWith('[Signup] code mail skipped: the mailbox blocked Voxium mail');
    expect(error).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('victim@example.com');
  });

  it('a transport failure is logged at ERROR, for the code and for the existing-account notice', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.sendCode.mockRejectedValueOnce(new Error('relay refused'));
    await startRegistration('newuser', 'a@example.com', PASSWORD, undefined, undefined, CONSENT);
    await flush();
    expect(error).toHaveBeenCalledWith('[Signup] Failed to send the code mail:', 'relay refused');

    users({ holder: { emailVerified: true } });
    h.sendExisting.mockRejectedValueOnce(new Error('relay refused'));
    await startRegistration('newuser', 'b@example.com', PASSWORD, undefined, undefined, CONSENT);
    await flush();
    expect(error).toHaveBeenCalledWith('[Signup] Failed to send the existing-account notice mail:', 'relay refused');
  });
});

// ─── resendRegistrationCode ─────────────────────────────────────────────────

describe('resendRegistrationCode', () => {
  const ID = 'pend-resend-1';
  const answer = { pendingId: ID, resendAfterSeconds: SIGNUP.RESEND_AFTER_SECONDS };
  const row = (over: Record<string, unknown> = {}) => ({
    id: ID,
    email: 'new@example.com',
    lastSentAt: new Date(Date.now() - (SIGNUP.RESEND_AFTER_SECONDS + 5) * 1000),
    expiresAt: new Date(Date.now() + 30 * MINUTE),
    resends: 0,
    attempts: 0,
    ...over,
  });

  const nothingHappened = () => {
    expect(prisma.pendingRegistration.updateMany).not.toHaveBeenCalled();
    expect(prisma.pendingRegistration.update).not.toHaveBeenCalled();
    expect(queryCalls()).toHaveLength(0);
    expect(h.sendCode).not.toHaveBeenCalled();
  };

  it.each([
    ['a non-string id', 42],
    ['an id over 64 characters', 'x'.repeat(65)],
  ])('answers the same to %s without a lookup', async (_label, id) => {
    await expect(resendRegistrationCode(id as string)).resolves.toEqual({ pendingId: id, resendAfterSeconds: SIGNUP.RESEND_AFTER_SECONDS });
    expect(prisma.pendingRegistration.findUnique).not.toHaveBeenCalled();
    nothingHappened();
  });

  it.each([
    ['an unknown id', () => null],
    ['a row that never mailed a code', () => row({ lastSentAt: null })],
    ['an expired row', () => row({ expiresAt: new Date(Date.now() - 1000) })],
    ['a row whose resend is used', () => row({ resends: SIGNUP.MAX_RESENDS })],
    ['a row burned by wrong codes', () => row({ attempts: SIGNUP.MAX_CODE_ATTEMPTS })],
    ['a resend asked too early', () => row({ lastSentAt: new Date(Date.now() - 60_000) })],
  ])('answers the same and sends nothing for %s', async (_label, make) => {
    h.prisma.pendingRegistration.findUnique.mockResolvedValueOnce(make());
    await expect(resendRegistrationCode(ID)).resolves.toEqual(answer);
    expect(prisma.pendingRegistration.findUnique).toHaveBeenCalledWith({ where: { id: ID } });
    nothingHappened();
  });

  it('sends nothing to a mailbox that blocked Voxium mail', async () => {
    h.prisma.pendingRegistration.findUnique.mockResolvedValueOnce(row());
    h.mailSuppressed.mockResolvedValueOnce(true);
    await expect(resendRegistrationCode(ID)).resolves.toEqual(answer);
    expect(h.mailSuppressed).toHaveBeenCalledWith('new@example.com');
    nothingHappened();
  });

  it('claims the resend with a conditional update first: a lost race sends nothing', async () => {
    const r = row();
    h.prisma.pendingRegistration.findUnique.mockResolvedValueOnce(r);
    h.prisma.pendingRegistration.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(resendRegistrationCode(ID)).resolves.toEqual(answer);

    const claim = h.prisma.pendingRegistration.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual({ id: ID, resends: 0, lastSentAt: r.lastSentAt });
    expect(claim.data.resends).toEqual({ increment: 1 });
    expect(claim.data.lastSentAt).toBeInstanceOf(Date);
    expect(queryCalls()).toHaveLength(0);
    expect(prisma.pendingRegistration.update).not.toHaveBeenCalled();
    expect(h.sendCode).not.toHaveBeenCalled();
  });

  it('a mailbox whose ledger is used up gets nothing (the claimed resend stays spent)', async () => {
    h.prisma.pendingRegistration.findUnique.mockResolvedValueOnce(row());
    h.prisma.$queryRaw.mockResolvedValueOnce([]);

    await expect(resendRegistrationCode(ID)).resolves.toEqual(answer);

    expect(prisma.pendingRegistration.updateMany).toHaveBeenCalledTimes(1);
    expect(ledgerCalls()).toHaveLength(1);
    expect(ledgerCalls()[0]).toContain(mailboxDigest('new@example.com'));
    expect(prisma.pendingRegistration.update).not.toHaveBeenCalled();
    expect(h.sendCode).not.toHaveBeenCalled();
  });

  it('mails a NEW code and stores its hash with a fresh code lifetime', async () => {
    h.prisma.pendingRegistration.findUnique.mockResolvedValueOnce(row());
    const before = Date.now();

    await expect(resendRegistrationCode(ID)).resolves.toEqual(answer);

    const callOrder = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0];
    expect(callOrder(h.prisma.pendingRegistration.updateMany)).toBeLessThan(callOrder(h.prisma.$queryRaw));
    expect(callOrder(h.prisma.$queryRaw)).toBeLessThan(callOrder(h.prisma.pendingRegistration.update));

    expect(h.sendCode).toHaveBeenCalledTimes(1);
    const [to, code, minutes] = h.sendCode.mock.calls[0];
    expect(to).toBe('new@example.com');
    expect(code).toMatch(/^\d{6}$/);
    expect(minutes).toBe(SIGNUP.CODE_TTL_MINUTES);

    const update = h.prisma.pendingRegistration.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: ID });
    expect(update.data.codeHash).toBe(signupCodeHash(ID, code));
    expect(update.data.codeExpiresAt.getTime() - before).toBeGreaterThanOrEqual(SIGNUP.CODE_TTL_MINUTES * MINUTE - 1000);
    expect(update.data.codeExpiresAt.getTime() - before).toBeLessThanOrEqual(SIGNUP.CODE_TTL_MINUTES * MINUTE + 5000);
  });

  it('a send failure is logged and the answer does not change', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.prisma.pendingRegistration.findUnique.mockResolvedValueOnce(row());
    h.sendCode.mockRejectedValueOnce(new Error('relay refused'));
    await expect(resendRegistrationCode(ID)).resolves.toEqual(answer);
    await flush();
    expect(error).toHaveBeenCalledWith('[Signup] Failed to send the code mail:', 'relay refused');
    error.mockRestore();
  });
});

// ─── completeRegistration ───────────────────────────────────────────────────

describe('completeRegistration', () => {
  const ID = 'pend-complete-1';
  const CODE = '482913';
  const TERMS_AT = new Date('2026-10-30T09:00:00.000Z');
  const PRIVACY_AT = new Date('2026-10-30T09:00:00.500Z');

  const pendingRow = (over: Record<string, unknown> = {}) => ({
    id: ID,
    username: 'newuser',
    email: 'new@smallcorp.example',
    email_canonical: 'new@smallcorp.example',
    display_name: 'New User',
    password_hash: '$2a$04$abcdefghijklmnopqrstuuJ0r4wFh2v0bqvSx1bSHDmV5k5uFQ9pK',
    code_hash: signupCodeHash(ID, CODE),
    terms_accepted_at: TERMS_AT,
    privacy_accepted_at: PRIVACY_AT,
    ...over,
  });

  beforeEach(() => {
    h.prisma.$queryRaw.mockResolvedValue([pendingRow()]);
    h.tx.user.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'user-1',
      username: data.username,
      displayName: data.displayName,
      email: data.email,
      avatarUrl: null,
      bio: null,
      status: 'offline',
      role: 'user',
      totpEnabled: false,
      emailVerified: data.emailVerified,
      isSupporter: false,
      supporterTier: null,
      tokenVersion: 3,
      createdAt: new Date(),
      termsAcceptedAt: data.termsAcceptedAt,
      privacyAcceptedAt: data.privacyAcceptedAt,
    }));
  });

  afterEach(() => { vi.restoreAllMocks(); });

  const refund = () => expect(prisma.pendingRegistration.update).toHaveBeenCalledWith({
    where: { id: ID }, data: { attempts: { decrement: 1 } },
  });

  describe('input', () => {
    it.each([
      ['a non-string id', 42, CODE],
      ['an empty id', '', CODE],
      ['an id over 64 characters', 'x'.repeat(65), CODE],
      ['a numeric code', ID, 482913],
      ['a five-digit code', ID, '12345'],
      ['a seven-digit code', ID, '1234567'],
      ['a code with letters', ID, '12a456'],
      ['a padded code', ID, ' 48291'],
      ['no code', ID, undefined],
    ])('refuses %s with the one code answer, charging no attempt', async (_label, id, code) => {
      await expect(completeRegistration(id, code, undefined, undefined))
        .rejects.toMatchObject({ statusCode: 400, message: SIGNUP_CODE_INVALID_MESSAGE });
      expect(queryCalls()).toHaveLength(0);
    });

    it('refuses a non-string username override before charging an attempt', async () => {
      await expect(completeRegistration(ID, CODE, 42, undefined))
        .rejects.toMatchObject({ statusCode: 400, message: 'Username must be a string' });
      expect(queryCalls()).toHaveLength(0);
    });
  });

  describe('the code', () => {
    it('counts the guess atomically, only on a live row under its cap', async () => {
      await completeRegistration(ID, CODE, undefined, undefined);
      expect(queryCalls()).toHaveLength(1);
      const [strings, ...values] = queryCalls()[0];
      const sql = strings.join('?');
      expect(sql).toContain('UPDATE pending_registrations SET attempts = attempts + 1');
      expect(sql).toMatch(/attempts < \?/);
      expect(sql).toContain('expires_at > ');
      expect(sql).toContain('code_expires_at > ');
      expect(sql).toContain('RETURNING');
      expect(values).toEqual([ID, SIGNUP.MAX_CODE_ATTEMPTS]);
    });

    it('an unknown, expired or used-up row is the same 400', async () => {
      h.prisma.$queryRaw.mockResolvedValueOnce([]);
      await expect(completeRegistration(ID, CODE, undefined, undefined))
        .rejects.toMatchObject({ statusCode: 400, message: SIGNUP_CODE_INVALID_MESSAGE });
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('a wrong code is the same 400, and the attempt stays charged', async () => {
      await expect(completeRegistration(ID, '000000', undefined, undefined))
        .rejects.toMatchObject({ statusCode: 400, message: SIGNUP_CODE_INVALID_MESSAGE });
      expect(prisma.pendingRegistration.update).not.toHaveBeenCalled();
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it(`after ${SIGNUP.MAX_CODE_ATTEMPTS} wrong codes even the right one is refused`, async () => {
      // The statement's own cap, simulated: a row comes back only while attempts < MAX
      let attempts = 0;
      h.prisma.$queryRaw.mockImplementation(async () => {
        if (attempts >= SIGNUP.MAX_CODE_ATTEMPTS) return [];
        attempts += 1;
        return [pendingRow()];
      });
      for (let i = 0; i < SIGNUP.MAX_CODE_ATTEMPTS; i += 1) {
        await expect(completeRegistration(ID, String(100000 + i), undefined, undefined))
          .rejects.toMatchObject({ statusCode: 400, message: SIGNUP_CODE_INVALID_MESSAGE });
      }
      await expect(completeRegistration(ID, CODE, undefined, undefined))
        .rejects.toMatchObject({ statusCode: 400, message: SIGNUP_CODE_INVALID_MESSAGE });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('a hash bound to another pending id does not match', async () => {
      h.prisma.$queryRaw.mockResolvedValueOnce([pendingRow({ code_hash: signupCodeHash('other-id', CODE) })]);
      await expect(completeRegistration(ID, CODE, undefined, undefined))
        .rejects.toMatchObject({ statusCode: 400, message: SIGNUP_CODE_INVALID_MESSAGE });
    });
  });

  describe('success', () => {
    it('creates a VERIFIED account carrying the consent of the start, and deletes the pending row in the same transaction', async () => {
      const result = await completeRegistration(ID, CODE, undefined, undefined);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const create = h.tx.user.create.mock.calls[0][0];
      expect(create.data).toMatchObject({
        username: 'newuser',
        email: 'new@smallcorp.example',
        emailCanonical: 'new@smallcorp.example',
        displayName: 'New User',
        password: pendingRow().password_hash,
        emailVerified: true,
        termsAcceptedAt: TERMS_AT,
        privacyAcceptedAt: PRIVACY_AT,
      });
      expect(create.data.emailVerifiedAt).toBeInstanceOf(Date);
      expect(create.select.tokenVersion).toBe(true);
      expect(h.tx.pendingRegistration.delete).toHaveBeenCalledWith({ where: { id: ID } });
      // Nothing outside the transaction touches the pending row on success
      expect(prisma.pendingRegistration.delete).not.toHaveBeenCalled();
      expect(prisma.pendingRegistration.update).not.toHaveBeenCalled();

      // The answer the one-step registration used to give
      expect(Object.keys(result).sort()).toEqual(['accessToken', 'refreshToken', 'user']);
      expect(result.user).toMatchObject({ id: 'user-1', username: 'newuser', emailVerified: true, consentRequired: false });
      expect(result.user).not.toHaveProperty('tokenVersion');
      expect(result.user).not.toHaveProperty('password');
      expect(result.user).not.toHaveProperty('termsAcceptedAt');
      expect(result.user).not.toHaveProperty('privacyAcceptedAt');
      const access = jwt.verify(result.accessToken, process.env.JWT_SECRET!) as Record<string, unknown>;
      expect(access).toMatchObject({ userId: 'user-1', username: 'newuser', role: 'user', tokenVersion: 3 });
      const refresh = jwt.verify(result.refreshToken, process.env.JWT_REFRESH_SECRET!) as Record<string, unknown>;
      expect(refresh).toMatchObject({ userId: 'user-1', tokenVersion: 3 });
    });

    it('looks the username up case-insensitively and the holders up by both spellings', async () => {
      await completeRegistration(ID, CODE, undefined, undefined);
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { username: { equals: 'newuser', mode: 'insensitive' } },
        select: { id: true },
      });
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { OR: [{ email: 'new@smallcorp.example' }, { emailCanonical: 'new@smallcorp.example' }] },
        select: { id: true, emailVerified: true },
      });
    });

    it('counts a novel domain only once the account exists; a common provider never', async () => {
      await completeRegistration(ID, CODE, undefined, undefined);
      expect(h.domainConsume).toHaveBeenCalledWith('smallcorp.example');

      vi.clearAllMocks();
      h.prisma.$queryRaw.mockResolvedValueOnce([pendingRow({ email: 'human@gmail.com', email_canonical: 'human@gmail.com' })]);
      await completeRegistration(ID, CODE, undefined, undefined);
      expect(h.domainConsume).not.toHaveBeenCalled();
    });

    it('records the registration address (normalized) with its country', async () => {
      h.geoLookup.mockReturnValueOnce({ country: 'FR' });
      await completeRegistration(ID, CODE, undefined, '::ffff:203.0.113.5');
      expect(h.geoLookup).toHaveBeenCalledWith('203.0.113.5');
      expect(prisma.ipRecord.create).toHaveBeenCalledWith({
        data: { userId: 'user-1', ip: '203.0.113.5', kind: 'register', countryCode: 'FR', country: 'France' },
      });
    });

    it('records no address when none is known, and a failed record never fails the registration', async () => {
      await completeRegistration(ID, CODE, undefined, undefined);
      expect(prisma.ipRecord.create).not.toHaveBeenCalled();

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      h.prisma.ipRecord.create.mockRejectedValueOnce(new Error('db gone'));
      await expect(completeRegistration(ID, CODE, undefined, '203.0.113.5')).resolves.toHaveProperty('accessToken');
      expect(warn).toHaveBeenCalledWith('[Signup] Registration IP record failed:', 'db gone');
    });
  });

  describe('the username', () => {
    it('a taken username is a 409 that costs no attempt', async () => {
      users({ nameTaken: true });
      await expect(completeRegistration(ID, CODE, undefined, undefined))
        .rejects.toMatchObject({ statusCode: 409, message: USERNAME_TAKEN_MESSAGE });
      refund();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.pendingRegistration.delete).not.toHaveBeenCalled();
    });

    it('the same code then completes with a new username', async () => {
      const result = await completeRegistration(ID, CODE, 'other_name', undefined);
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { username: { equals: 'other_name', mode: 'insensitive' } },
        select: { id: true },
      });
      expect(h.tx.user.create.mock.calls[0][0].data.username).toBe('other_name');
      expect(result.user.username).toBe('other_name');
    });

    it('an invalid override is a 400 that costs no attempt', async () => {
      await expect(completeRegistration(ID, CODE, 'ab', undefined))
        .rejects.toMatchObject({ statusCode: 400, message: /Username/ });
      refund();
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('a failed refund is logged and the 409 still answers', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      users({ nameTaken: true });
      h.prisma.pendingRegistration.update.mockRejectedValueOnce(new Error('db gone'));
      await expect(completeRegistration(ID, CODE, undefined, undefined))
        .rejects.toMatchObject({ statusCode: 409, message: USERNAME_TAKEN_MESSAGE });
      expect(warn).toHaveBeenCalledWith('[Signup] Attempt refund failed:', 'db gone');
    });
  });

  describe('the address', () => {
    it('a verified holder (completed meanwhile) is a 409 that says sign in, and the pending row goes', async () => {
      h.prisma.user.findMany.mockResolvedValueOnce([{ id: 'u-verified', emailVerified: true }]);
      await expect(completeRegistration(ID, CODE, undefined, undefined))
        .rejects.toMatchObject({ statusCode: 409, message: SIGNUP_EMAIL_REGISTERED_MESSAGE });
      expect(prisma.pendingRegistration.delete).toHaveBeenCalledWith({ where: { id: ID } });
      expect(h.deleteUserAccount).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('a failed cleanup of that pending row is logged and the 409 still answers', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      h.prisma.user.findMany.mockResolvedValueOnce([{ id: 'u-verified', emailVerified: true }]);
      h.prisma.pendingRegistration.delete.mockRejectedValueOnce(new Error('db gone'));
      await expect(completeRegistration(ID, CODE, undefined, undefined))
        .rejects.toMatchObject({ statusCode: 409, message: SIGNUP_EMAIL_REGISTERED_MESSAGE });
      expect(warn).toHaveBeenCalledWith('[Signup] Pending registration cleanup failed:', 'db gone');
    });

    it('a verified holder wins even next to an unverified one: nothing is deleted', async () => {
      h.prisma.user.findMany.mockResolvedValueOnce([
        { id: 'u-legacy', emailVerified: false },
        { id: 'u-verified', emailVerified: true },
      ]);
      await expect(completeRegistration(ID, CODE, undefined, undefined))
        .rejects.toMatchObject({ statusCode: 409, message: SIGNUP_EMAIL_REGISTERED_MESSAGE });
      expect(h.deleteUserAccount).not.toHaveBeenCalled();
    });

    it('unverified legacy holders are deleted the way every account is, BEFORE the new account is created', async () => {
      h.prisma.user.findMany.mockResolvedValueOnce([
        { id: 'u-legacy-1', emailVerified: false },
        { id: 'u-legacy-2', emailVerified: false },
      ]);
      await completeRegistration(ID, CODE, undefined, undefined);
      expect(h.deleteUserAccount).toHaveBeenCalledTimes(2);
      expect(h.deleteUserAccount).toHaveBeenNthCalledWith(1, 'u-legacy-1', { reason: 'superseded by a verified sign-up', logPrefix: '[Signup]' });
      expect(h.deleteUserAccount).toHaveBeenNthCalledWith(2, 'u-legacy-2', { reason: 'superseded by a verified sign-up', logPrefix: '[Signup]' });
      const lastDelete = h.deleteUserAccount.mock.invocationCallOrder[1];
      expect(lastDelete).toBeLessThan(h.prisma.$transaction.mock.invocationCallOrder[0]);
    });

    it('a failing legacy deletion stops the registration (no account next to the old row)', async () => {
      h.prisma.user.findMany.mockResolvedValueOnce([{ id: 'u-legacy-1', emailVerified: false }]);
      h.deleteUserAccount.mockRejectedValueOnce(new Error('db gone'));
      await expect(completeRegistration(ID, CODE, undefined, undefined)).rejects.toThrow('db gone');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('unique-index races (two completions at once)', () => {
    const p2002 = (meta: Record<string, unknown>) => Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta });
    // Prisma 7 behind a driver adapter reports the violated index under
    // meta.driverAdapterError.cause.constraint; meta.target is never set.
    const adapterP2002 = (index: string | { fields: string[] }) => p2002({
      modelName: 'User',
      driverAdapterError: Object.assign(new Error('UniqueConstraintViolation'), {
        name: 'DriverAdapterError',
        cause: {
          kind: 'UniqueConstraintViolation',
          constraint: typeof index === 'string' ? { index } : index,
          originalCode: '23505',
        },
      }),
    });

    it.each([
      ['meta.target email', p2002({ target: ['email'] }), SIGNUP_EMAIL_REGISTERED_MESSAGE],
      ['meta.target email_canonical', p2002({ target: ['email_canonical'] }), SIGNUP_EMAIL_REGISTERED_MESSAGE],
      ['meta.target username index', p2002({ target: ['users_username_lower_key'] }), USERNAME_TAKEN_MESSAGE],
      ['no target at all', p2002({}), USERNAME_TAKEN_MESSAGE],
      ['adapter index users_email_key', adapterP2002('users_email_key'), SIGNUP_EMAIL_REGISTERED_MESSAGE],
      ['adapter index users_email_canonical_key', adapterP2002('users_email_canonical_key'), SIGNUP_EMAIL_REGISTERED_MESSAGE],
      ['adapter index users_username_lower_key', adapterP2002('users_username_lower_key'), USERNAME_TAKEN_MESSAGE],
      ['adapter index users_username_key', adapterP2002('users_username_key'), USERNAME_TAKEN_MESSAGE],
      ['adapter fields (email)', adapterP2002({ fields: ['email'] }), SIGNUP_EMAIL_REGISTERED_MESSAGE],
      ['adapter fields (username)', adapterP2002({ fields: ['username'] }), USERNAME_TAKEN_MESSAGE],
    ])('%s maps to its 409, refunds the attempt, counts nothing', async (_label, err, message) => {
      h.tx.user.create.mockRejectedValueOnce(err);
      await expect(completeRegistration(ID, CODE, undefined, undefined))
        .rejects.toMatchObject({ statusCode: 409, message });
      refund();
      expect(h.domainConsume).not.toHaveBeenCalled();
      expect(prisma.ipRecord.create).not.toHaveBeenCalled();
    });

    it('any other database error surfaces as itself, with no refund', async () => {
      h.tx.user.create.mockRejectedValueOnce(new Error('connection reset'));
      await expect(completeRegistration(ID, CODE, undefined, undefined)).rejects.toThrow('connection reset');
      expect(prisma.pendingRegistration.update).not.toHaveBeenCalled();
      expect(h.domainConsume).not.toHaveBeenCalled();
    });
  });
});

// ─── purgeExpiredSignupState ────────────────────────────────────────────────

describe('purgeExpiredSignupState', () => {
  it('deletes expired pending rows and ledger rows past their window, and reports both counts', async () => {
    h.prisma.pendingRegistration.deleteMany.mockResolvedValueOnce({ count: 4 });
    h.prisma.signupMailLedger.deleteMany.mockResolvedValueOnce({ count: 2 });
    const before = Date.now();

    await expect(purgeExpiredSignupState()).resolves.toEqual({ pending: 4, ledger: 2 });

    const pendingCut = (h.prisma.pendingRegistration.deleteMany.mock.calls[0][0].where.expiresAt.lt as Date).getTime();
    expect(Math.abs(pendingCut - before)).toBeLessThan(5000);
    const ledgerCut = (h.prisma.signupMailLedger.deleteMany.mock.calls[0][0].where.windowStartAt.lt as Date).getTime();
    expect(Math.abs(ledgerCut - (before - SIGNUP.LEDGER_WINDOW_DAYS * 24 * 60 * MINUTE))).toBeLessThan(5000);
  });

  it('surfaces a store failure to its caller (the hygiene run logs it)', async () => {
    h.prisma.pendingRegistration.deleteMany.mockRejectedValueOnce(new Error('db gone'));
    await expect(purgeExpiredSignupState()).rejects.toThrow('db gone');
  });
});
