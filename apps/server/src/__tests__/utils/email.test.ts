import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock nodemailer to avoid creating real SMTP transports
const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn().mockResolvedValue({ messageId: 'test-id' }) }));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({ sendMail }),
  },
}));

// The suppression list the user-facing senders consult (its own suite covers
// the digest, the token and the lookup); here only its two answers matter.
const { suppressed, blockUrl } = vi.hoisted(() => ({
  suppressed: vi.fn().mockResolvedValue(false),
  blockUrl: vi.fn((to: string) => `http://localhost:8080/mail-block/TOKEN-FOR-${to}`),
}));
vi.mock('../../utils/mailSuppression', () => ({
  isMailSuppressed: (...a: unknown[]) => suppressed(...a),
  mailBlockUrl: (...a: unknown[]) => blockUrl(...(a as [string])),
}));

describe('utils/email — lazy initialization', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('importing does NOT create a nodemailer transport', async () => {
    const nodemailer = await import('nodemailer');
    vi.mocked(nodemailer.default.createTransport).mockClear();

    // Dynamic import — should not trigger createTransport
    const mod = await import('../../utils/email');
    expect(mod).toBeDefined();
    expect(nodemailer.default.createTransport).not.toHaveBeenCalled();
  });

  it('importing does NOT read SMTP env vars', async () => {
    const saved = {
      SMTP_HOST: process.env.SMTP_HOST,
      SMTP_PORT: process.env.SMTP_PORT,
      SMTP_USER: process.env.SMTP_USER,
      SMTP_PASS: process.env.SMTP_PASS,
    };

    // Remove all SMTP env vars
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;

    // Should import without errors
    const mod = await import('../../utils/email');
    expect(mod.sendPasswordResetEmail).toBeDefined();
    expect(mod.sendVerificationEmail).toBeDefined();
    expect(mod.sendCleanupReport).toBeDefined();

    // Restore
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  });

  it('transport is created lazily when sendVerificationEmail is called', async () => {
    const nodemailer = await import('nodemailer');
    vi.mocked(nodemailer.default.createTransport).mockClear();

    const mod = await import('../../utils/email');

    // Transport not created yet
    expect(nodemailer.default.createTransport).not.toHaveBeenCalled();

    // Calling a send function triggers lazy transport creation
    await mod.sendVerificationEmail('test@example.com', 'token123');
    expect(nodemailer.default.createTransport).toHaveBeenCalledTimes(1);
  });

  it('transport is created only once (singleton)', async () => {
    const nodemailer = await import('nodemailer');
    vi.mocked(nodemailer.default.createTransport).mockClear();

    const mod = await import('../../utils/email');

    await mod.sendVerificationEmail('test@example.com', 'token1');
    await mod.sendPasswordResetEmail('test@example.com', 'token2');
    expect(nodemailer.default.createTransport).toHaveBeenCalledTimes(1);
  });

  it('exported functions are all defined at import time (not lazy)', async () => {
    const mod = await import('../../utils/email');
    expect(typeof mod.sendCleanupReport).toBe('function');
    expect(typeof mod.sendVerificationEmail).toBe('function');
    expect(typeof mod.sendPasswordResetEmail).toBe('function');
  });
});

describe('utils/email — describeEmailError', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('prefers machine codes for SMTP errors (message can embed the recipient address)', async () => {
    const { describeEmailError } = await import('../../utils/email');

    const smtpErr = Object.assign(
      new Error('550 5.1.1 <victim@example.com>: Recipient address rejected'),
      { code: 'EENVELOPE', responseCode: 550 },
    );

    const described = describeEmailError(smtpErr);
    expect(described).toBe('EENVELOPE (SMTP 550)');
    expect(described).not.toContain('victim@example.com');
  });

  it('uses the code alone when there is no responseCode', async () => {
    const { describeEmailError } = await import('../../utils/email');

    const connErr = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:587'), { code: 'ECONNECTION' });
    expect(describeEmailError(connErr)).toBe('ECONNECTION');
  });

  it('falls back to the message for plain errors without a code', async () => {
    const { describeEmailError } = await import('../../utils/email');

    expect(describeEmailError(new Error('something broke'))).toBe('something broke');
  });

  it('stringifies non-Error values', async () => {
    const { describeEmailError } = await import('../../utils/email');

    expect(describeEmailError('timeout')).toBe('timeout');
    expect(describeEmailError(undefined)).toBe('undefined');
  });
});

describe('utils/email — "Not you? Block Voxium mail to this address"', () => {
  beforeEach(() => {
    vi.resetModules();
    sendMail.mockClear();
    suppressed.mockReset().mockResolvedValue(false);
    blockUrl.mockClear();
  });

  const lastMail = () => sendMail.mock.calls[0][0] as { to: string; text: string; html: string; subject: string };

  it('the verification mail carries the prompt and the block link, in text and in HTML', async () => {
    const { sendVerificationEmail, MAIL_BLOCK_PROMPT } = await import('../../utils/email');
    await sendVerificationEmail('victim@example.com', 'tok');

    const mail = lastMail();
    expect(blockUrl).toHaveBeenCalledWith('victim@example.com');
    expect(mail.text).toContain(`${MAIL_BLOCK_PROMPT}:\nhttp://localhost:8080/mail-block/TOKEN-FOR-victim@example.com`);
    expect(mail.html).toContain(MAIL_BLOCK_PROMPT);
    expect(mail.html).toContain('href="http://localhost:8080/mail-block/TOKEN-FOR-victim@example.com"');
    // The verification link is still there, before the footer
    expect(mail.text.indexOf('/verify-email/tok')).toBeLessThan(mail.text.indexOf('/mail-block/'));
  });

  it('the password-reset mail carries them too', async () => {
    const { sendPasswordResetEmail, MAIL_BLOCK_PROMPT } = await import('../../utils/email');
    await sendPasswordResetEmail('victim@example.com', 'tok');

    const mail = lastMail();
    expect(mail.text).toContain('/reset-password/tok');
    expect(mail.text).toContain(`${MAIL_BLOCK_PROMPT}:\nhttp://localhost:8080/mail-block/TOKEN-FOR-victim@example.com`);
    expect(mail.html).toContain('href="http://localhost:8080/mail-block/TOKEN-FOR-victim@example.com"');
  });

  it('the prompt is the sentence the owner asked for', async () => {
    const { MAIL_BLOCK_PROMPT } = await import('../../utils/email');
    expect(MAIL_BLOCK_PROMPT).toBe('Not you? Block Voxium mail to this address');
  });

  it('a suppressed mailbox gets NOTHING: the sender throws MailSuppressedError before the transport', async () => {
    const { sendVerificationEmail, sendPasswordResetEmail, MailSuppressedError } = await import('../../utils/email');
    suppressed.mockResolvedValue(true);

    await expect(sendVerificationEmail('victim@example.com', 'tok')).rejects.toBeInstanceOf(MailSuppressedError);
    await expect(sendPasswordResetEmail('victim@example.com', 'tok')).rejects.toBeInstanceOf(MailSuppressedError);
    expect(sendMail).not.toHaveBeenCalled();
    // Decided on the address as given; the module folds spellings itself
    expect(suppressed).toHaveBeenCalledWith('victim@example.com');
  });

  it('MailSuppressedError names itself and carries no address', async () => {
    const { MailSuppressedError } = await import('../../utils/email');
    const err = new MailSuppressedError();
    expect(err.name).toBe('MailSuppressedError');
    expect(err.message).toBe('Mail to this address is blocked');
    expect(err).toBeInstanceOf(Error);
  });

  it('operator mail never consults the list: it goes to a configured address, not a typed one', async () => {
    const { sendCleanupReport, sendAdminAlert } = await import('../../utils/email');
    suppressed.mockResolvedValue(true);

    await sendCleanupReport('ops@example.com', {
      startedAt: new Date(), finishedAt: new Date(), filesExpired: 0, sizeFreed: 0,
      retentionDays: 3, remainingActive: 0, totalExpiredRecords: 0, error: null,
    });
    await sendAdminAlert('ops@example.com', 'Spike', ['30 signups']);

    expect(suppressed).not.toHaveBeenCalled();
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(blockUrl).not.toHaveBeenCalled();
  });
});
