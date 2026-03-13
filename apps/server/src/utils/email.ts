import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
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

const SENDER_FROM = {
  name: process.env.SMTP_FROM_NAME || 'Voxium',
  address: process.env.SMTP_FROM || 'noreply@voxium.app',
};

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
  const from = SENDER_FROM;
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

  await transporter.sendMail({
    from,
    to,
    subject: `[Voxium] Cleanup Report — ${report.filesExpired} file${report.filesExpired !== 1 ? 's' : ''} expired`,
    text,
    html,
  });
}

export async function sendVerificationEmail(to: string, token: string): Promise<void> {
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:8080';
  const verifyUrl = `${clientUrl}/verify-email/${token}`;

  await transporter.sendMail({
    from: SENDER_FROM,
    to,
    subject: 'Verify your Voxium email address',
    text: `Welcome to Voxium! Please verify your email address by clicking the link below:\n\n${verifyUrl}\n\nThis link expires in 24 hours. If you did not create an account, ignore this email.`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #5865f2;">Welcome to Voxium!</h2>
        <p>Please verify your email address to get started:</p>
        <a href="${verifyUrl}" style="display: inline-block; background: #5865f2; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 16px 0;">
          Verify Email
        </a>
        <p style="font-size: 13px; color: #666;">This link expires in 24 hours. If you did not create this account, you can safely ignore this email.</p>
      </div>
    `,
  });
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<void> {
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:8080';
  const resetUrl = `${clientUrl}/reset-password/${token}`;

  await transporter.sendMail({
    from: SENDER_FROM,
    to,
    subject: 'Reset your Voxium password',
    text: `You requested a password reset. Click the link below to set a new password:\n\n${resetUrl}\n\nThis link expires in 1 hour. If you did not request this, ignore this email.`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #5865f2;">Voxium Password Reset</h2>
        <p>You requested a password reset. Click the button below to set a new password:</p>
        <a href="${resetUrl}" style="display: inline-block; background: #5865f2; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 16px 0;">
          Reset Password
        </a>
        <p style="font-size: 13px; color: #666;">This link expires in 1 hour. If you did not request this, you can safely ignore this email.</p>
      </div>
    `,
  });
}
