import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { SMTPTransportOptions } from 'nodemailer/lib/smtp-transport';
import { isMailSuppressed, mailBlockUrl } from './mailSuppression';

/**
 * How the connection to the SMTP relay is secured. The mail carries
 * single-use account links (verification, password reset, sign-up codes)
 * and the session carries the SMTP credentials, so under a production
 * configuration nothing goes out in clear text because a relay did not
 * offer STARTTLS:
 *
 * - `SMTP_SECURE=true`: implicit TLS from the first byte (port 465 usually).
 * - `SMTP_REQUIRE_TLS=true`: STARTTLS, and no mail at all to a relay that
 *   does not complete it.
 * - `SMTP_REQUIRE_TLS=false`: STARTTLS when the relay offers it, plain text
 *   otherwise (a relay on a network the operator trusts, a local catcher).
 * - neither (unset or empty): required under `NODE_ENV=production`,
 *   opportunistic otherwise, so development against a plain local catcher
 *   (port 1025) keeps working with no setting.
 * - any other SMTP_REQUIRE_TLS value (`1`, `yes`, `TRUE`: only the exact
 *   `true` and `false` are recognised): reported at start; read as `false`
 *   outside production, as it always was, but as REQUIRED under
 *   `NODE_ENV=production`, where reading a misspelt "yes" as "no" would send
 *   the login in clear to a relay without STARTTLS, weaker than leaving the
 *   setting out.
 *
 * Only the exact `true` turns SMTP_SECURE or SMTP_REQUIRE_TLS on, as before.
 * What a production deployment gets from a setting that is absent or empty
 * is what changed: `SMTP_SECURE=false` alone (it only turns implicit TLS
 * off) and an explicitly empty `SMTP_REQUIRE_TLS=` now require STARTTLS,
 * and so does an unrecognised SMTP_REQUIRE_TLS value. Every other explicit
 * combination behaves as it did.
 */
export type SmtpSecurity =
  | { mode: 'implicit-tls'; source: 'explicit' }
  | { mode: 'starttls-required'; source: 'explicit' | 'production-default' | 'unrecognised' }
  | { mode: 'starttls-opportunistic'; source: 'explicit' | 'unrecognised' | 'development-default' };

type SmtpEnv = Partial<Record<'NODE_ENV' | 'SMTP_SECURE' | 'SMTP_REQUIRE_TLS', string>>;

export function smtpSecurity(env: SmtpEnv): SmtpSecurity {
  if (env.SMTP_SECURE === 'true') return { mode: 'implicit-tls', source: 'explicit' };
  const requireTls = env.SMTP_REQUIRE_TLS;
  if (requireTls === 'true') return { mode: 'starttls-required', source: 'explicit' };
  if (requireTls !== undefined && requireTls.trim() !== '') {
    if (requireTls === 'false') return { mode: 'starttls-opportunistic', source: 'explicit' };
    // Neither true nor false: required in production, where the safe reading
    // of a value nobody can interpret is the strict one
    return env.NODE_ENV === 'production'
      ? { mode: 'starttls-required', source: 'unrecognised' }
      : { mode: 'starttls-opportunistic', source: 'unrecognised' };
  }
  return env.NODE_ENV === 'production'
    ? { mode: 'starttls-required', source: 'production-default' }
    : { mode: 'starttls-opportunistic', source: 'development-default' };
}

/** The nodemailer transport options the SMTP_* settings describe. */
export function smtpTransportOptions(env: NodeJS.ProcessEnv): SMTPTransportOptions {
  const security = smtpSecurity(env);
  return {
    host: env.SMTP_HOST || 'localhost',
    port: parseInt(env.SMTP_PORT || '1025', 10),
    secure: security.mode === 'implicit-tls',
    // nodemailer sends STARTTLS even when the relay does not advertise it,
    // and fails the send (ETLS) when the upgrade does not happen
    ...(security.mode === 'starttls-required' ? { requireTLS: true } : {}),
    ...(env.SMTP_USER && env.SMTP_PASS
      ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } }
      : {}),
  };
}

/**
 * One line at start saying which security the mail transport uses, a
 * warning when mail may cross the network in clear text under a production
 * configuration or a setting is not understood. Names no host, user or
 * address: the line goes to the process log.
 */
export function logSmtpSecurity(env: NodeJS.ProcessEnv = process.env): SmtpSecurity {
  const security = smtpSecurity(env);
  const plain = 'STARTTLS when the relay offers it, plain text otherwise';
  if (env.SMTP_SECURE !== undefined && env.SMTP_SECURE.trim() !== '' && env.SMTP_SECURE !== 'true' && env.SMTP_SECURE !== 'false') {
    console.warn('[Email] SMTP_SECURE is neither true nor false and reads as false (no implicit TLS)');
  }
  switch (security.mode) {
    case 'implicit-tls':
      console.log('[Email] SMTP connection security: implicit TLS (SMTP_SECURE=true)');
      break;
    case 'starttls-required':
      if (security.source === 'unrecognised') {
        console.warn('[Email] SMTP_REQUIRE_TLS is neither true nor false and is treated as required under NODE_ENV=production: STARTTLS required, no mail goes to a relay that does not complete it. Set true or false.');
      } else {
        console.log(security.source === 'explicit'
          ? '[Email] SMTP connection security: STARTTLS required (SMTP_REQUIRE_TLS=true); no mail goes to a relay that does not complete it'
          : '[Email] SMTP connection security: STARTTLS required (the default under NODE_ENV=production; SMTP_REQUIRE_TLS=false allows a relay without TLS)');
      }
      break;
    case 'starttls-opportunistic':
      if (security.source === 'unrecognised') {
        console.warn(`[Email] SMTP_REQUIRE_TLS is neither true nor false and reads as false: ${plain}. Set true or false.`);
      } else if (security.source === 'development-default') {
        console.log(`[Email] SMTP connection security: ${plain} (the default outside production)`);
      } else if (env.NODE_ENV === 'production') {
        console.warn(`[Email] SMTP connection security: ${plain} (SMTP_REQUIRE_TLS=false): account links and the SMTP credentials can cross the network unencrypted`);
      } else {
        console.log(`[Email] SMTP connection security: ${plain} (SMTP_REQUIRE_TLS=false)`);
      }
      break;
  }
  return security;
}

// Lazy-initialized to avoid reading env vars at module scope (ES import hoisting)
let _transporter: Transporter | null = null;
function getTransporter(): Transporter {
  if (!_transporter) {
    _transporter = nodemailer.createTransport(smtpTransportOptions(process.env));
  }
  return _transporter;
}

/**
 * Production only, and only when a relay is configured: ask the relay once at
 * start whether it accepts the configured connection security and login, so a
 * relay that refuses STARTTLS shows up in the log at boot instead of at the
 * first sign-up. Never awaited, never throws, never rejects unhandled: the
 * start does not wait for the relay and does not fail on it. The failure is
 * described by `describeEmailError` only (a machine code, never the error
 * object, the host, the user or an address).
 */
export function verifySmtpRelayAtStart(): void {
  if (process.env.NODE_ENV !== 'production' || !process.env.SMTP_HOST) return;
  const failed = (err: unknown) => {
    console.warn(`[Email] SMTP relay check failed (${describeEmailError(err)}): mail will fail until the relay accepts the configured connection security and login`);
  };
  try {
    getTransporter().verify().then(
      () => console.log('[Email] SMTP relay check passed: the relay accepts the configured connection security and login'),
      failed,
    );
  } catch (err) {
    failed(err);
  }
}

function getSenderFrom() {
  return {
    name: process.env.SMTP_FROM_NAME || 'Voxium',
    address: process.env.SMTP_FROM || 'noreply@voxium.app',
  };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * Log-safe summary of a send failure. SMTP servers embed the recipient
 * address in free-text responses (e.g. "550 5.1.1 <user@x.com>: rejected"),
 * and nodemailer copies that into err.message — so for SMTP errors log the
 * machine codes instead, and fall back to the message only for non-SMTP
 * errors (ECONNREFUSED etc. carry no PII).
 */
export function describeEmailError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; responseCode?: unknown; command?: unknown };
    if (typeof e.code === 'string') {
      return typeof e.responseCode === 'number' ? `${e.code} (SMTP ${e.responseCode})` : e.code;
    }
    // An SMTP reply without a code still quotes the server, address included
    if (typeof e.responseCode === 'number') return `SMTP ${e.responseCode}`;
    if (typeof e.command === 'string') return `SMTP error (${e.command})`;
    if (err instanceof Error) return err.message;
  }
  return String(err);
}

/** SMTP commands that are only ever in flight before the envelope: the greeting, STARTTLS, the login. */
const PRE_ENVELOPE_COMMAND_RE = /^(?:EHLO|HELO|LHLO|STARTTLS|AUTH(?: .+)?)$/;
/** nodemailer codes raised only while resolving, securing or logging in to the relay. */
const PRE_ENVELOPE_CODES = new Set(['EDNS', 'ETLS', 'EAUTH']);
/** nodemailer's timeoutType of the setup phases (a SOCKET_TIMEOUT can strike at any point, DATA included). */
const SETUP_TIMEOUTS = new Set(['CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT']);
/**
 * System errors that mean no connection was ever established. Not
 * EHOSTUNREACH or ENETUNREACH: an established session's socket can raise
 * them too (a route lost mid-transfer, DATA included), and nodemailer gives
 * that the same ESOCKET/CONN shape as a failed connect.
 */
const NEVER_CONNECTED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * Whether a send failure PROVES no recipient was reached: the relay could not
 * be resolved, connected to, greeted, secured or logged in to. Read from what
 * nodemailer actually sets (smtp-connection): its `command` is a fixed 'CONN'
 * for every socket error, close and inactivity timeout, whatever phase the
 * session was in, so 'CONN' proves nothing by itself, and neither does
 * ECONNECTION, which a connection closed during DATA also carries. What does
 * prove it: a command only sent before the envelope (EHLO, HELO, LHLO,
 * STARTTLS, AUTH …), a code only raised during setup (EDNS, ETLS, EAUTH), a
 * setup-phase `timeoutType`, or a system error meaning the TCP connection was
 * never made. Everything else, a refused recipient or sender, anything during
 * or after DATA, a socket timeout, a dropped connection, is no proof.
 */
export function failedBeforeAnyRecipient(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { code, command, timeoutType, originalCode } = err as {
    code?: unknown; command?: unknown; timeoutType?: unknown; originalCode?: unknown;
  };
  if (typeof command === 'string' && PRE_ENVELOPE_COMMAND_RE.test(command)) return true;
  if (typeof code !== 'string') return false;
  if (PRE_ENVELOPE_CODES.has(code)) return true;
  if (code === 'ETIMEDOUT') return typeof timeoutType === 'string' && SETUP_TIMEOUTS.has(timeoutType);
  if (code === 'ESOCKET') return typeof originalCode === 'string' && NEVER_CONNECTED.has(originalCode);
  return false;
}

export interface CleanupReport {
  startedAt: Date;
  finishedAt: Date;
  filesExpired: number;
  sizeFreed: number;
  retentionDays: number;
  remainingActive: number;
  totalExpiredRecords: number;
  error: string | null;
}

export async function sendCleanupReport(to: string, report: CleanupReport): Promise<void> {
  const from = getSenderFrom();
  const duration = formatDuration(report.finishedAt.getTime() - report.startedAt.getTime());
  const status = report.error ? 'Completed with errors' : report.filesExpired > 0 ? 'Completed' : 'No action needed';
  const date = report.startedAt.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const rows = [
    ['Status', status],
    ['Date', date],
    ['Duration', duration],
    ['Retention policy', `${report.retentionDays} days`],
    ['Files expired', String(report.filesExpired)],
    ['Storage freed', formatBytes(report.sizeFreed)],
    ['Active attachments', String(report.remainingActive)],
    ['Total expired records', String(report.totalExpiredRecords)],
  ];

  if (report.error) {
    rows.push(['Error', report.error]);
  }

  const textRows = rows.map(([label, value]) => `${label}: ${value}`).join('\n');
  const text = `Voxium Attachment Cleanup Report\n\n${textRows}`;

  const htmlRows = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding: 8px 12px; border-bottom: 1px solid #eee; color: #666; font-size: 13px;">${label}</td><td style="padding: 8px 12px; border-bottom: 1px solid #eee; font-weight: 600; font-size: 13px;">${value}</td></tr>`,
    )
    .join('');

  const statusColor = report.error ? '#e74c3c' : report.filesExpired > 0 ? '#2ecc71' : '#95a5a6';

  const html = `
    <div style="font-family: sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #5865f2; margin-bottom: 4px;">Attachment Cleanup Report</h2>
      <p style="margin-top: 0; font-size: 13px; color: #666;">${date}</p>
      <div style="display: inline-block; background: ${statusColor}; color: #fff; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: 600; margin-bottom: 16px;">
        ${status}
      </div>
      <table style="width: 100%; border-collapse: collapse; margin-top: 8px;">
        ${htmlRows}
      </table>
      <p style="font-size: 11px; color: #999; margin-top: 24px;">This is an automated report from your Voxium server.</p>
    </div>
  `;

  await getTransporter().sendMail({
    from,
    to,
    subject: `[Voxium] Cleanup Report — ${report.filesExpired} file${report.filesExpired !== 1 ? 's' : ''} expired`,
    text,
    html,
  });
}

/**
 * The address asked us never to mail it (`utils/mailSuppression.ts`). Thrown
 * by every user-facing sender BEFORE anything is handed to the transport;
 * callers that cannot answer differently (registration, password reset) log
 * it at warn level and move on, the resend route answers it as a 400.
 */
export class MailSuppressedError extends Error {
  constructor() {
    super('Mail to this address is blocked');
    this.name = 'MailSuppressedError';
  }
}

export const MAIL_BLOCK_PROMPT = 'Not you? Block Voxium mail to this address';

interface UserMailContent {
  subject: string;
  text: string;
  html: string;
}

/**
 * The ONE path every e-mail to a USER-TYPED address takes. It refuses a
 * suppressed mailbox and hands the template the block link to print, so no
 * account e-mail can leave without the way to stop the next one. Operator
 * mail (`sendCleanupReport`, `sendAdminAlert`) goes to a configured address
 * and does not come through here.
 */
async function sendUserMail(to: string, content: (blockUrl: string) => UserMailContent): Promise<void> {
  if (await isMailSuppressed(to)) throw new MailSuppressedError();
  await getTransporter().sendMail({ from: getSenderFrom(), to, ...content(mailBlockUrl(to)) });
}

function blockFooterText(blockUrl: string): string {
  return `${MAIL_BLOCK_PROMPT}:\n${blockUrl}`;
}

function blockFooterHtml(blockUrl: string): string {
  return `<p style="font-size: 12px; color: #999; margin-top: 24px; border-top: 1px solid #eee; padding-top: 12px;">${MAIL_BLOCK_PROMPT}: <a href="${blockUrl}" style="color: #666;">block this address</a></p>`;
}

/**
 * The 6-digit code that completes a sign-up (verify-first registration). A code,
 * never a link: mail security gateways open every link in incoming mail to scan
 * it, and a link that completed anything on load would complete it for them.
 */
export async function sendSignupCodeEmail(to: string, code: string, minutes: number): Promise<void> {
  await sendUserMail(to, (blockUrl) => ({
    subject: `${code} is your Voxium sign-up code`,
    text: `Your Voxium sign-up code is ${code}\n\nType it in the Voxium window where you are creating your account. It expires in ${minutes} minutes.\n\nIf you did not try to create a Voxium account, ignore this email: no account exists for this address, and nothing happens without the code.\n\n${blockFooterText(blockUrl)}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #5865f2;">Your Voxium sign-up code</h2>
        <p style="font-size: 32px; font-weight: 700; letter-spacing: 8px; margin: 16px 0;">${code}</p>
        <p>Type it in the Voxium window where you are creating your account. It expires in ${minutes} minutes.</p>
        <p style="font-size: 13px; color: #666;">If you did not try to create a Voxium account, ignore this email: no account exists for this address, and nothing happens without the code.</p>
        ${blockFooterHtml(blockUrl)}
      </div>
    `,
  }));
}

/**
 * Sent instead of a code when the address already has a verified account: the
 * person may have forgotten it. The API answers the same either way.
 */
export async function sendSignupExistingAccountEmail(to: string): Promise<void> {
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:8080';
  await sendUserMail(to, (blockUrl) => ({
    subject: 'Someone tried to create a Voxium account with your address',
    text: `Someone tried to create a new Voxium account with this address, which already has one.\n\nIf it was you, sign in instead (${clientUrl}/login), or reset your password from the sign-in page if you forgot it.\n\nIf it was not you, ignore this email: nothing changed on your account.\n\n${blockFooterText(blockUrl)}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #5865f2;">You already have a Voxium account</h2>
        <p>Someone tried to create a new Voxium account with this address, which already has one.</p>
        <p>If it was you, <a href="${clientUrl}/login">sign in</a> instead, or reset your password from the sign-in page if you forgot it.</p>
        <p style="font-size: 13px; color: #666;">If it was not you, ignore this email: nothing changed on your account.</p>
        ${blockFooterHtml(blockUrl)}
      </div>
    `,
  }));
}

export async function sendVerificationEmail(to: string, token: string): Promise<void> {
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:8080';
  const verifyUrl = `${clientUrl}/verify-email/${token}`;

  await sendUserMail(to, (blockUrl) => ({
    subject: 'Verify your Voxium email address',
    text: `Welcome to Voxium! Please verify your email address by clicking the link below:\n\n${verifyUrl}\n\nThis link expires in 24 hours. If you did not create an account, ignore this email.\n\n${blockFooterText(blockUrl)}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #5865f2;">Welcome to Voxium!</h2>
        <p>Please verify your email address to get started:</p>
        <a href="${verifyUrl}" style="display: inline-block; background: #5865f2; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 16px 0;">
          Verify Email
        </a>
        <p style="font-size: 13px; color: #666;">This link expires in 24 hours. If you did not create this account, you can safely ignore this email.</p>
        ${blockFooterHtml(blockUrl)}
      </div>
    `,
  }));
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<void> {
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:8080';
  const resetUrl = `${clientUrl}/reset-password/${token}`;

  await sendUserMail(to, (blockUrl) => ({
    subject: 'Reset your Voxium password',
    text: `You requested a password reset. Click the link below to set a new password:\n\n${resetUrl}\n\nThis link expires in 1 hour. If you did not request this, ignore this email.\n\n${blockFooterText(blockUrl)}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #5865f2;">Voxium Password Reset</h2>
        <p>You requested a password reset. Click the button below to set a new password:</p>
        <a href="${resetUrl}" style="display: inline-block; background: #5865f2; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 16px 0;">
          Reset Password
        </a>
        <p style="font-size: 13px; color: #666;">This link expires in 1 hour. If you did not request this, you can safely ignore this email.</p>
        ${blockFooterHtml(blockUrl)}
      </div>
    `,
  }));
}

/** Plain operational alert to the configured admin address (spike warnings,
 *  hygiene anomalies). Text-first: these are read in a hurry. */
export async function sendAdminAlert(to: string, subject: string, lines: string[]): Promise<void> {
  await getTransporter().sendMail({
    from: getSenderFrom(),
    to,
    subject: `[Voxium] ${subject}`,
    text: lines.join('\n'),
    html: `<div style="font-family: monospace; padding: 16px;">${lines.map((l) => `<p style="margin: 4px 0;">${l}</p>`).join('')}</div>`,
  });
}
