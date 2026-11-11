import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { isMailSuppressed, mailBlockUrl } from './mailSuppression';

// Lazy-initialized to avoid reading env vars at module scope (ES import hoisting)
let _transporter: Transporter | null = null;
function getTransporter(): Transporter {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'localhost',
      port: parseInt(process.env.SMTP_PORT || '1025', 10),
      secure: process.env.SMTP_SECURE === 'true',
      ...(process.env.SMTP_SECURE !== 'true' && process.env.SMTP_REQUIRE_TLS === 'true'
        ? { requireTLS: true }
        : {}),
      ...(process.env.SMTP_USER && process.env.SMTP_PASS
        ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } }
        : {}),
    });
  }
  return _transporter;
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

/** nodemailer's `command` before any recipient is named: the connection, the greeting, TLS, the login. */
const PRE_RECIPIENT_COMMAND_RE = /^(?:CONN|EHLO|HELO|LHLO|STARTTLS|AUTH(?: .*)?)$/;
/** nodemailer's codes for a failure to reach or log in to the relay at all. */
const PRE_RECIPIENT_CODES = new Set(['EDNS', 'EAUTH', 'ECONNECTION']);

/**
 * Whether a send failure PROVES no recipient was reached: the relay could not
 * be resolved, connected to, greeted, secured or logged in to. When the error
 * names the SMTP command it failed on, the command decides (a connection drop
 * during DATA may still have delivered); only without one does the code. A
 * refused recipient (RCPT TO, EENVELOPE), anything during or after DATA, and
 * an error carrying neither are not proof.
 */
export function failedBeforeAnyRecipient(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { code, command } = err as { code?: unknown; command?: unknown };
  if (typeof command === 'string') return PRE_RECIPIENT_COMMAND_RE.test(command);
  return typeof code === 'string' && PRE_RECIPIENT_CODES.has(code);
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
