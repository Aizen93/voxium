import { describe, it, expect, vi, afterEach } from 'vitest';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { logSmtpSecurity, smtpSecurity, smtpTransportOptions } from '../../utils/email';

// How the mail transport secures its connection to the relay. Under a
// production configuration no mail (account links, the SMTP login) goes out
// in clear text because the relay did not offer STARTTLS, unless the operator
// says so; development keeps working against a plain local catcher; and a
// deployment that sets SMTP_SECURE / SMTP_REQUIRE_TLS explicitly behaves as
// it did.

/** The transport options as utils/email.ts built them before the production default (kept verbatim). */
function previousOptions(env: Record<string, string | undefined>) {
  return {
    host: env.SMTP_HOST || 'localhost',
    port: parseInt(env.SMTP_PORT || '1025', 10),
    secure: env.SMTP_SECURE === 'true',
    ...(env.SMTP_SECURE !== 'true' && env.SMTP_REQUIRE_TLS === 'true'
      ? { requireTLS: true }
      : {}),
    ...(env.SMTP_USER && env.SMTP_PASS
      ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } }
      : {}),
  };
}

const NODE_ENVS = [undefined, 'production', 'development', 'test'];
const SECURE = [undefined, '', 'true', 'false', 'TRUE', '1'];
const REQUIRE = [undefined, '', '  ', 'true', 'false', 'TRUE', 'yes', '0'];

function combos() {
  const out: Record<string, string | undefined>[] = [];
  for (const NODE_ENV of NODE_ENVS) for (const SMTP_SECURE of SECURE) for (const SMTP_REQUIRE_TLS of REQUIRE) {
    out.push({ NODE_ENV, SMTP_SECURE, SMTP_REQUIRE_TLS, SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', SMTP_USER: 'mailer', SMTP_PASS: 'secret' });
  }
  return out;
}

const label = (env: Record<string, string | undefined>) =>
  `NODE_ENV=${JSON.stringify(env.NODE_ENV)} SMTP_SECURE=${JSON.stringify(env.SMTP_SECURE)} SMTP_REQUIRE_TLS=${JSON.stringify(env.SMTP_REQUIRE_TLS)}`;

describe('smtpTransportOptions: every combination of NODE_ENV, SMTP_SECURE and SMTP_REQUIRE_TLS', () => {
  it.each(combos().map((env) => [label(env), env] as const))('%s', (_name, env) => {
    const options = smtpTransportOptions(env);
    const unsetRequire = env.SMTP_REQUIRE_TLS === undefined || env.SMTP_REQUIRE_TLS.trim() === '';

    if (env.SMTP_SECURE === 'true') {
      // implicit TLS from the first byte; STARTTLS has nothing to add
      expect(options.secure).toBe(true);
      expect(options).not.toHaveProperty('requireTLS');
    } else if (env.SMTP_REQUIRE_TLS === 'true' || (unsetRequire && env.NODE_ENV === 'production')) {
      expect(options.secure).toBe(false);
      expect(options.requireTLS).toBe(true);
    } else {
      // opportunistic: what every explicit value but `true` always meant, and development's default
      expect(options.secure).toBe(false);
      expect(options).not.toHaveProperty('requireTLS');
    }

    // The one change: production with SMTP_REQUIRE_TLS unset (or empty) and no implicit TLS
    const changed = env.NODE_ENV === 'production' && unsetRequire && env.SMTP_SECURE !== 'true';
    if (changed) {
      expect(options).toEqual({ ...previousOptions(env), requireTLS: true });
    } else {
      expect(options).toEqual(previousOptions(env));
    }

    expect(options.host).toBe('smtp.example.com');
    expect(options.port).toBe(587);
    expect(options.auth).toEqual({ user: 'mailer', pass: 'secret' });
  });

  it('keeps the development defaults: localhost:1025, no login, no TLS demanded', () => {
    expect(smtpTransportOptions({})).toEqual({ host: 'localhost', port: 1025, secure: false });
    expect(smtpTransportOptions({ NODE_ENV: 'development' })).toEqual({ host: 'localhost', port: 1025, secure: false });
  });

  it('logs in only with both a user and a password', () => {
    expect(smtpTransportOptions({ SMTP_USER: 'mailer' })).not.toHaveProperty('auth');
    expect(smtpTransportOptions({ SMTP_PASS: 'secret' })).not.toHaveProperty('auth');
  });
});

describe('smtpSecurity: where each mode comes from', () => {
  it.each([
    [{ SMTP_SECURE: 'true' }, { mode: 'implicit-tls', source: 'explicit' }],
    [{ SMTP_SECURE: 'true', SMTP_REQUIRE_TLS: 'false', NODE_ENV: 'production' }, { mode: 'implicit-tls', source: 'explicit' }],
    [{ SMTP_REQUIRE_TLS: 'true' }, { mode: 'starttls-required', source: 'explicit' }],
    [{ NODE_ENV: 'production' }, { mode: 'starttls-required', source: 'production-default' }],
    [{ NODE_ENV: 'production', SMTP_REQUIRE_TLS: '' }, { mode: 'starttls-required', source: 'production-default' }],
    [{ NODE_ENV: 'production', SMTP_REQUIRE_TLS: 'false' }, { mode: 'starttls-opportunistic', source: 'explicit' }],
    [{ NODE_ENV: 'production', SMTP_REQUIRE_TLS: 'yes' }, { mode: 'starttls-opportunistic', source: 'unrecognised' }],
    [{}, { mode: 'starttls-opportunistic', source: 'development-default' }],
    [{ NODE_ENV: 'test' }, { mode: 'starttls-opportunistic', source: 'development-default' }],
  ])('%j → %j', (env, expected) => {
    expect(smtpSecurity(env)).toEqual(expected);
  });
});

describe('logSmtpSecurity: one line at start, without the host, the user or any address', () => {
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  function run(env: Record<string, string>) {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const full = { SMTP_HOST: 'smtp.example.com', SMTP_USER: 'mailer@example.com', SMTP_PASS: 'secret', SMTP_FROM: 'noreply@example.com', ...env };
    logSmtpSecurity(full);
    const lines = [...log.mock.calls, ...warn.mock.calls].map((c) => c.join(' '));
    for (const line of lines) {
      for (const secret of ['smtp.example.com', 'mailer@example.com', 'secret', 'noreply@example.com', 'example.com']) {
        expect(line, line).not.toContain(secret);
      }
    }
    return { info: log.mock.calls.map((c) => c.join(' ')), warnings: warn.mock.calls.map((c) => c.join(' ')) };
  }
  afterEach(() => vi.restoreAllMocks());

  it('implicit TLS', () => {
    const { info, warnings } = run({ SMTP_SECURE: 'true', NODE_ENV: 'production' });
    expect(info).toEqual(['[Email] SMTP connection security: implicit TLS (SMTP_SECURE=true)']);
    expect(warnings).toEqual([]);
  });

  it('STARTTLS required, by the production default', () => {
    const { info, warnings } = run({ NODE_ENV: 'production' });
    expect(info).toHaveLength(1);
    expect(info[0]).toContain('STARTTLS required (the default under NODE_ENV=production; SMTP_REQUIRE_TLS=false allows a relay without TLS)');
    expect(warnings).toEqual([]);
  });

  it('STARTTLS required, set explicitly', () => {
    const { info } = run({ SMTP_REQUIRE_TLS: 'true' });
    expect(info[0]).toContain('STARTTLS required (SMTP_REQUIRE_TLS=true)');
  });

  it('the opt-out in production is a warning', () => {
    const { info, warnings } = run({ NODE_ENV: 'production', SMTP_REQUIRE_TLS: 'false' });
    expect(info).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('plain text otherwise (SMTP_REQUIRE_TLS=false)');
    expect(warnings[0]).toContain('unencrypted');
  });

  it('opportunistic outside production is a plain line', () => {
    expect(run({ NODE_ENV: 'development' })).toEqual({
      info: ['[Email] SMTP connection security: STARTTLS when the relay offers it, plain text otherwise (the default outside production)'],
      warnings: [],
    });
    vi.restoreAllMocks();
    expect(run({ SMTP_REQUIRE_TLS: 'false' }).warnings).toEqual([]);
  });

  it('an unrecognised value is reported (and keeps reading as false, as it always did)', () => {
    const { warnings } = run({ NODE_ENV: 'production', SMTP_REQUIRE_TLS: 'yes' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('SMTP_REQUIRE_TLS is neither true nor false and reads as false');
    expect(warnings[0]).not.toContain('yes');
    vi.restoreAllMocks();
    const secure = run({ SMTP_SECURE: 'TRUE' });
    expect(secure.warnings[0]).toContain('SMTP_SECURE is neither true nor false');
  });

  it('runs once, in the server start', () => {
    const index = readFileSync(path.resolve(__dirname, '../../index.ts'), 'utf8');
    expect(index.match(/logSmtpSecurity\(\)/g)).toHaveLength(1);
    const main = index.indexOf('async function main()');
    expect(index.indexOf('logSmtpSecurity();')).toBeGreaterThan(main);
  });
});

// The real nodemailer against a relay that offers no STARTTLS (a minimal
// SMTP server in this process, on a loopback port of its own): with the
// production default the send fails before any login or envelope, so
// neither the credentials nor the message cross the wire; with the opt-out
// the message goes out as before.
describe('nodemailer with these options, against a relay without STARTTLS', () => {
  async function plainRelay() {
    const commands: string[] = [];
    let data = '';
    const server = net.createServer((socket) => {
      let inData = false;
      let buffer = '';
      socket.write('220 relay.test ESMTP\r\n');
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let at: number;
        while ((at = buffer.indexOf('\r\n')) !== -1) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (inData) {
            if (line === '.') {
              inData = false;
              socket.write('250 queued\r\n');
            } else {
              data += line + '\n';
            }
            continue;
          }
          commands.push(line.split(' ')[0].toUpperCase());
          const verb = commands[commands.length - 1];
          if (verb === 'EHLO') socket.write('250-relay.test\r\n250 AUTH PLAIN\r\n');
          else if (verb === 'AUTH') socket.write('235 ok\r\n');
          else if (verb === 'MAIL' || verb === 'RCPT') socket.write('250 ok\r\n');
          else if (verb === 'DATA') { inData = true; socket.write('354 go\r\n'); }
          else if (verb === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
          else socket.write('502 not implemented\r\n');
        }
      });
      socket.on('error', () => { /* the client may drop the line */ });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    return { port, commands, data: () => data, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  const message = { from: 'noreply@example.com', to: 'user@example.com', subject: 'Verify', text: 'https://chat.example.com/verify-email/LINK' };

  it('the production default refuses to send: ETLS at STARTTLS, no AUTH, no MAIL', async () => {
    const relay = await plainRelay();
    try {
      const transport = nodemailer.createTransport({
        ...smtpTransportOptions({ NODE_ENV: 'production', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(relay.port), SMTP_USER: 'mailer', SMTP_PASS: 'secret' }),
        connectionTimeout: 5000, greetingTimeout: 5000,
      });
      await expect(transport.sendMail(message)).rejects.toMatchObject({ code: 'ETLS', command: 'STARTTLS' });
      expect(relay.commands).toEqual(['EHLO', 'STARTTLS']);
      expect(relay.data()).toBe('');
    } finally {
      await relay.close();
    }
  }, 20_000);

  it('the explicit opt-out sends in plain text, as every deployment did before', async () => {
    const relay = await plainRelay();
    try {
      const transport = nodemailer.createTransport({
        ...smtpTransportOptions({ NODE_ENV: 'production', SMTP_REQUIRE_TLS: 'false', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(relay.port), SMTP_USER: 'mailer', SMTP_PASS: 'secret' }),
        connectionTimeout: 5000, greetingTimeout: 5000,
      });
      await expect(transport.sendMail(message)).resolves.toBeDefined();
      expect(relay.commands).toEqual(expect.arrayContaining(['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA']));
      expect(relay.commands).not.toContain('STARTTLS');
      expect(relay.data()).toContain('verify-email/LINK');
    } finally {
      await relay.close();
    }
  }, 20_000);

  it('development against a plain catcher needs no setting', async () => {
    const relay = await plainRelay();
    try {
      const transport = nodemailer.createTransport({
        ...smtpTransportOptions({ NODE_ENV: 'development', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(relay.port) }),
        connectionTimeout: 5000, greetingTimeout: 5000,
      });
      await expect(transport.sendMail(message)).resolves.toBeDefined();
      expect(relay.data()).toContain('verify-email/LINK');
    } finally {
      await relay.close();
    }
  }, 20_000);
});
