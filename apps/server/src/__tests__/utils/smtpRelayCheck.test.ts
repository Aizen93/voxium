import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The one check at start (production, a relay configured): the relay is asked
// once, not awaited, and a refusal reaches the log as a machine code only.

const verify = vi.hoisted(() => vi.fn());
const createTransport = vi.hoisted(() => vi.fn());
vi.mock('nodemailer', () => ({ default: { createTransport } }));
vi.mock('../../utils/mailSuppression', () => ({
  isMailSuppressed: vi.fn().mockResolvedValue(false),
  mailBlockUrl: vi.fn(),
}));

const CONFIG = {
  NODE_ENV: 'production',
  SMTP_HOST: 'relay.internal.example.net',
  SMTP_USER: 'mailer-account',
  SMTP_PASS: 'relay-password',
  SMTP_FROM: 'noreply@mail.example.org',
};
const SAVED = Object.fromEntries(Object.keys(CONFIG).map((k) => [k, process.env[k]]));

function setEnv(env: Partial<Record<keyof typeof CONFIG, string>>) {
  for (const k of Object.keys(CONFIG)) delete process.env[k];
  Object.assign(process.env, env);
}

async function load() {
  vi.resetModules();
  return import('../../utils/email');
}

describe('verifySmtpRelayAtStart', () => {
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

  beforeEach(() => {
    verify.mockReset();
    createTransport.mockReset().mockReturnValue({ verify });
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(SAVED)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  const texts = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c) => c.join(' '));

  it('logs one info line when the relay accepts the setup', async () => {
    setEnv(CONFIG);
    verify.mockResolvedValue(true);
    const { verifySmtpRelayAtStart } = await load();
    expect(verifySmtpRelayAtStart()).toBeUndefined();
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(texts(log)[0]).toContain('SMTP relay check passed');
    expect(warn).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('warns once with the machine code of a refusal, and nothing of the config', async () => {
    setEnv(CONFIG);
    const refusal = Object.assign(new Error('Connection to relay.internal.example.net for mailer-account failed (noreply@mail.example.org)'), { code: 'ETLS', responseCode: 502 });
    verify.mockRejectedValue(refusal);
    const { verifySmtpRelayAtStart } = await load();
    verifySmtpRelayAtStart();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    const [line] = texts(warn);
    expect(line).toContain('SMTP relay check failed (ETLS (SMTP 502))');
    for (const secret of ['relay.internal.example.net', 'mailer-account', 'relay-password', 'noreply@mail.example.org', 'example.org', 'example.net']) {
      expect(line).not.toContain(secret);
    }
    // the error object itself is never passed to the log
    expect(warn.mock.calls[0]).toHaveLength(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('does not wait for the relay: it returns while verify is still pending', async () => {
    setEnv(CONFIG);
    verify.mockReturnValue(new Promise(() => {}));
    const { verifySmtpRelayAtStart } = await load();
    expect(verifySmtpRelayAtStart()).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a rejected verify leaves no unhandled rejection', async () => {
    setEnv(CONFIG);
    verify.mockRejectedValue(Object.assign(new Error('x'), { code: 'EAUTH' }));
    const { verifySmtpRelayAtStart } = await load();
    verifySmtpRelayAtStart();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  });

  it('never throws: not when verify throws, not when creating the transport throws, not when verify is no promise', async () => {
    setEnv(CONFIG);
    const first = await load();
    verify.mockImplementation(() => { throw Object.assign(new Error('boom'), { code: 'ESOCKET' }); });
    expect(() => first.verifySmtpRelayAtStart()).not.toThrow();
    expect(texts(warn).at(-1)).toContain('SMTP relay check failed (ESOCKET)');

    const second = await load();
    createTransport.mockImplementation(() => { throw new Error('bad options'); });
    expect(() => second.verifySmtpRelayAtStart()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);

    const third = await load();
    createTransport.mockReset().mockReturnValue({ verify: () => undefined });
    expect(() => third.verifySmtpRelayAtStart()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it.each(['development', 'test', undefined])('does nothing outside production (NODE_ENV=%s)', async (nodeEnv) => {
    setEnv({ ...CONFIG, ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}) });
    if (!nodeEnv) delete process.env.NODE_ENV;
    const { verifySmtpRelayAtStart } = await load();
    verifySmtpRelayAtStart();
    expect(createTransport).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does nothing when no relay is configured', async () => {
    setEnv({ NODE_ENV: 'production' });
    const { verifySmtpRelayAtStart } = await load();
    verifySmtpRelayAtStart();
    expect(createTransport).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('the server start', () => {
  it('starts the check once, after the mode line, without awaiting it', () => {
    const index = readFileSync(path.resolve(__dirname, '../../index.ts'), 'utf8');
    expect(index.match(/verifySmtpRelayAtStart\(\)/g)).toHaveLength(1);
    expect(index).not.toMatch(/await\s+verifySmtpRelayAtStart/);
    expect(index.indexOf('verifySmtpRelayAtStart();')).toBeGreaterThan(index.indexOf('logSmtpSecurity();'));
    expect(index.indexOf('verifySmtpRelayAtStart();')).toBeGreaterThan(index.indexOf('async function main()'));
  });
});
