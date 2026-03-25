import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock nodemailer to avoid creating real SMTP transports
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      sendMail: vi.fn().mockResolvedValue({ messageId: 'test-id' }),
    }),
  },
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
