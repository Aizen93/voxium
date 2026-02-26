import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'localhost',
  port: parseInt(process.env.SMTP_PORT || '1025', 10),
  secure: false,
  ...(process.env.SMTP_USER && process.env.SMTP_PASS
    ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } }
    : {}),
});

export async function sendPasswordResetEmail(to: string, token: string): Promise<void> {
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:8080';
  const resetUrl = `${clientUrl}/reset-password/${token}`;

  await transporter.sendMail({
    from: process.env.SMTP_FROM || 'noreply@voxium.app',
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
