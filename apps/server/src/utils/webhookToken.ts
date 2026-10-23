import crypto from 'crypto';

/**
 * The incoming-webhook token: 32 random bytes as base64url (43 characters),
 * stored only as its SHA-256. Minted by the management routes
 * (routes/webhooks.ts), checked by the public execute route
 * (routes/webhookExecute.ts); both sides hash through here, so the stored
 * form and the compared form can never drift apart.
 */
export function newWebhookToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** SHA-256 of a token as the execute route compares it (32 bytes). */
export function hashWebhookToken(token: string): Buffer {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

/** SHA-256 of a token as the database stores it (64 hex characters). */
export function hashWebhookTokenHex(token: string): string {
  return hashWebhookToken(token).toString('hex');
}
