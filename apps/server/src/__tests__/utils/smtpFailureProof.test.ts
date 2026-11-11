import { describe, it, expect, vi, afterEach } from 'vitest';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import nodemailer from 'nodemailer';

// failedBeforeAnyRecipient decides whether a password-reset mail's point is
// refunded. Hand-made error objects can only test what we think nodemailer
// reports; these run the REAL nodemailer against a scripted SMTP server on a
// loopback port the OS picks, and classify the errors it actually produces.

vi.mock('../../utils/mailSuppression', () => ({
  isMailSuppressed: vi.fn().mockResolvedValue(false),
  mailBlockUrl: vi.fn(() => 'http://localhost/mail-block/x'),
}));

import { failedBeforeAnyRecipient } from '../../utils/email';

type Script = (socket: net.Socket, line: string, state: { inData: boolean }) => void;

const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** A loopback SMTP server that greets (unless told not to) and answers each line through `script`. */
async function smtpServer(script: Script, { greet = true } = {}): Promise<number> {
  const server = net.createServer((socket) => {
    socket.on('error', () => { /* the client hanging up mid-test is expected */ });
    const state = { inData: false };
    let buffer = '';
    if (greet) socket.write('220 test ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let i: number;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        script(socket, line, state);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return (server.address() as AddressInfo).port;
}

/** Answers like a relay that accepts everything up to DATA, then hands DATA to `onData`. */
function acceptUntilData(onData: Script, rcpt = '250 OK'): Script {
  return (socket, line, state) => {
    if (state.inData) return onData(socket, line, state);
    if (/^(EHLO|HELO)/i.test(line)) socket.write('250-test\r\n250 OK\r\n');
    else if (/^MAIL FROM/i.test(line)) socket.write('250 OK\r\n');
    else if (/^RCPT TO/i.test(line)) socket.write(`${rcpt}\r\n`);
    else if (/^DATA/i.test(line)) { state.inData = true; socket.write('354 go ahead\r\n'); }
    else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n');
  };
}

async function sendThrough(port: number, timeouts: { greetingTimeout?: number; socketTimeout?: number } = {}): Promise<unknown> {
  const transport = nodemailer.createTransport({
    host: '127.0.0.1', port, secure: false, ignoreTLS: true,
    connectionTimeout: 2000, greetingTimeout: timeouts.greetingTimeout ?? 2000, socketTimeout: timeouts.socketTimeout ?? 2000,
  });
  try {
    await transport.sendMail({ from: 'noreply@voxium.test', to: 'someone@voxium.test', subject: 's', text: 't' });
    return null;
  } catch (err) {
    return err;
  } finally {
    transport.close();
  }
}

describe('failedBeforeAnyRecipient — on the errors nodemailer really raises', () => {
  it('a refused connection is proof: nothing was ever connected', async () => {
    const port = await smtpServer(() => {});
    await new Promise<void>((r) => servers.pop()!.close(() => r()));

    const err = await sendThrough(port);

    expect(err).toMatchObject({ code: 'ESOCKET', command: 'CONN', originalCode: 'ECONNREFUSED' });
    expect(failedBeforeAnyRecipient(err)).toBe(true);
  });

  it('a greeting that never comes is proof', async () => {
    const port = await smtpServer(() => {}, { greet: false });

    const err = await sendThrough(port, { greetingTimeout: 150 });

    expect(err).toMatchObject({ code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'GREETING_TIMEOUT' });
    expect(failedBeforeAnyRecipient(err)).toBe(true);
  });

  it('a refused greeting is proof', async () => {
    const port = await smtpServer((socket, line) => {
      if (/^(EHLO|HELO)/i.test(line)) socket.write('550 go away\r\n');
    });

    const err = await sendThrough(port);

    expect(err).toMatchObject({ command: expect.stringMatching(/^(EHLO|HELO)$/) });
    expect(failedBeforeAnyRecipient(err)).toBe(true);
  });

  it('a refused recipient is NOT proof', async () => {
    const port = await smtpServer(acceptUntilData(() => {}, '550 5.1.1 no such user'));

    const err = await sendThrough(port);

    expect(err).toMatchObject({ code: 'EENVELOPE', command: 'RCPT TO' });
    expect(failedBeforeAnyRecipient(err)).toBe(false);
  });

  it('a connection closed during DATA is NOT proof, though nodemailer reports it as ECONNECTION on CONN', async () => {
    const port = await smtpServer(acceptUntilData((socket) => { socket.destroy(); }));

    const err = await sendThrough(port);

    expect(err).toMatchObject({ code: 'ECONNECTION', command: 'CONN' });
    expect(failedBeforeAnyRecipient(err)).toBe(false);
  });

  it('a timeout during DATA is NOT proof, though nodemailer reports it on CONN', async () => {
    const port = await smtpServer(acceptUntilData(() => { /* the relay goes silent */ }));

    const err = await sendThrough(port, { socketTimeout: 200 });

    expect(err).toMatchObject({ code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'SOCKET_TIMEOUT' });
    expect(failedBeforeAnyRecipient(err)).toBe(false);
  });

  it('a mail the relay refuses after DATA is NOT proof', async () => {
    const port = await smtpServer(acceptUntilData((socket, line) => {
      if (line === '.') socket.write('554 rejected\r\n');
    }));

    const err = await sendThrough(port);

    expect(err).toMatchObject({ command: 'DATA' });
    expect(failedBeforeAnyRecipient(err)).toBe(false);
  });
});

describe('failedBeforeAnyRecipient — shapes with no server to produce them', () => {
  it.each([
    ['a DNS failure', { code: 'EDNS', command: 'CONN', originalCode: 'ENOTFOUND' }, true],
    ['a connect timeout', { code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'CONNECT_TIMEOUT' }, true],
    ['a TLS handshake timeout', { code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'UPGRADE_TIMEOUT' }, true],
    ['STARTTLS', { code: 'ETLS', command: 'STARTTLS' }, true],
    ['a refused login', { code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535 }, true],
    ['missing credentials', { code: 'EAUTH', command: 'API' }, true],
    ['a reset socket', { code: 'ESOCKET', command: 'CONN', originalCode: 'ECONNRESET' }, false],
    ['a refused sender', { code: 'EENVELOPE', command: 'MAIL FROM', responseCode: 553 }, false],
    ['a timeout naming no phase', { code: 'ETIMEDOUT' }, false],
    ['no code, no command', {}, false],
    ['not an object', 'boom', false],
  ])('%s → %s', (_what, fields, expected) => {
    const err = typeof fields === 'string' ? fields : Object.assign(new Error('x'), fields);
    expect(failedBeforeAnyRecipient(err)).toBe(expected);
  });
});
