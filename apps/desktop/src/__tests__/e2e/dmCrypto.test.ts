import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildE2EPlaintext, buildMegolmEnvelope } from '@voxium/shared';
import type { Message } from '@voxium/shared';

/**
 * The display layer is a security boundary, not glue.
 *
 * Two things reach the user through here that the crypto never vouched for: a
 * message the server SAYS was not encrypted, and a conversation preview taken
 * straight out of the plaintext cache. Both were passed through verbatim.
 */

const getCachedPlaintext = vi.fn();
const decryptMessage = vi.fn();

vi.mock('../../services/e2e/e2eService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/e2e/e2eService')>();
  return {
    ...actual,
    getE2EService: () => ({ getCachedPlaintext, decryptMessage }),
  };
});

vi.mock('../../stores/authStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'me' } }) },
}));

import {
  decryptMessageForDisplay,
  decryptMessagesForDisplay,
  resolveEncryptedPreview,
  DECRYPT_FAILED_CONTENT,
} from '../../services/e2e/dmCrypto';

function dmRow(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    type: 'user',
    content: 'hello',
    channelId: null,
    conversationId: 'c1',
    encrypted: true,
    author: { id: 'peer', username: 'peer', displayName: 'Peer' },
    createdAt: '2026-08-01T10:00:00.000Z',
    editedAt: null,
    reactions: [],
    ...over,
  } as unknown as Message;
}

beforeEach(() => {
  getCachedPlaintext.mockReset();
  decryptMessage.mockReset();
});

describe('a DM the server claims was not encrypted', () => {
  it('never reaches the timeline with the server-supplied text', async () => {
    // After the cutover every DM is encrypted, so `encrypted: false` on a
    // `type: 'user'` row cannot be honest. Honouring it would let whoever can
    // write the API response put words under a contact's name and avatar with
    // no badge and no decrypt-failure marker — and MainLayout reads the same
    // string out in a desktop notification.
    const forged = dmRow({ encrypted: false, content: 'send the wallet seed to bc1q…' });

    const out = await decryptMessageForDisplay(forged);

    expect(out.content).toBe(DECRYPT_FAILED_CONTENT);
    expect(out.content).not.toContain('wallet seed');
  });

  it('is refused in the batch path too, not just one at a time', async () => {
    // The batch entry point used to return the whole page untouched when no
    // row was flagged encrypted — a condition the attacker controls, and one
    // that skipped the per-message check entirely.
    const page = [
      dmRow({ id: 'a', encrypted: false, content: 'forged one' }),
      dmRow({ id: 'b', encrypted: false, content: 'forged two' }),
    ];

    const out = await decryptMessagesForDisplay(page);

    expect(out.map((m) => m.content)).toEqual([DECRYPT_FAILED_CONTENT, DECRYPT_FAILED_CONTENT]);
  });

  it('still lets the server’s own system notices through', async () => {
    // Call started / call ended carry no attacker-chosen prose and are the only
    // unencrypted DM rows the server legitimately produces. Blocking them would
    // break the feature and teach nobody anything.
    const notice = dmRow({ type: 'system', encrypted: false, content: 'Call started' });

    const out = await decryptMessageForDisplay(notice);

    expect(out.content).toBe('Call started');
  });

  it('does not weaken the normal encrypted path', async () => {
    decryptMessage.mockResolvedValue({ failed: false, text: 'a real message' });

    const out = await decryptMessageForDisplay(dmRow({ content: buildMegolmEnvelope('s1', 'x') }));

    expect(out.content).toBe('a real message');
  });
});

describe('conversation-list previews', () => {
  it('do not print the attachment file key into the sidebar', async () => {
    // The cache holds plaintext AS ENCRYPTED. For an attachment that is a
    // structured payload carrying the file's AES key, its IV, the S3 key and
    // the real filename. Returned raw, all of it landed in the DOM, the
    // accessibility tree, and any screenshot of the app.
    const secretKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    getCachedPlaintext.mockResolvedValue(
      buildE2EPlaintext('here you go', [
        {
          s3Key: 'attachments/dm-c1/abc-tax-return.pdf',
          fileName: 'tax-return.pdf',
          fileSize: 200000,
          mimeType: 'application/pdf',
          key: secretKey,
          iv: 'AAAAAAAAAAAAAAAA',
        },
      ])
    );

    const preview = await resolveEncryptedPreview('m1');

    expect(preview).toBe('here you go');
    expect(preview).not.toContain(secretKey);
    expect(preview).not.toContain('tax-return.pdf');
    expect(preview).not.toContain('s3Key');
  });

  it('returns the text of an ordinary message unchanged', async () => {
    getCachedPlaintext.mockResolvedValue(buildE2EPlaintext('just text'));

    expect(await resolveEncryptedPreview('m1')).toBe('just text');
  });

  it('stays null when nothing is cached, so the caller can show the lock', async () => {
    getCachedPlaintext.mockResolvedValue(null);

    expect(await resolveEncryptedPreview('m1')).toBeNull();
  });
});
