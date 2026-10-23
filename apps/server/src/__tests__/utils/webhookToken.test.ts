import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { newWebhookToken, hashWebhookToken, hashWebhookTokenHex } from '../../utils/webhookToken';

describe('webhookToken', () => {
  it('mints 32 random bytes as 43 base64url characters, never the same twice', () => {
    const a = newWebhookToken();
    const b = newWebhookToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
  });

  it('hashes with SHA-256 over the UTF-8 bytes: the stored hex IS the compared digest', () => {
    const token = 'tok_Zm9vYmFy';
    const digest = hashWebhookToken(token);
    expect(digest).toEqual(crypto.createHash('sha256').update(token, 'utf8').digest());
    expect(digest).toHaveLength(32);
    expect(hashWebhookTokenHex(token)).toBe(digest.toString('hex'));
    expect(hashWebhookTokenHex(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});
