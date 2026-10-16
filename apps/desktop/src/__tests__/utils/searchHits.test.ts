import { describe, it, expect } from 'vitest';
import { withoutSecureChannelHits } from '../../utils/searchHits';

describe('withoutSecureChannelHits — server search never shows a secure channel', () => {
  const channels = [{ id: 'open', secure: false }, { id: 'vault', secure: true }];

  it('drops hits from a channel the client knows is secure, and any hit flagged encrypted', () => {
    const hits = [
      { id: 'a', channelId: 'open', content: 'fine' },
      { id: 'b', channelId: 'vault', content: 'server-asserted text from a secure channel' },
      { id: 'c', channelId: 'other', content: 'ciphertext', encrypted: true },
      { id: 'd', channelId: 'other', content: 'unknown channel, plaintext' },
    ];
    expect(withoutSecureChannelHits(hits, channels).map((h) => h.id)).toEqual(['a', 'd']);
  });

  it('keeps everything when the channel list is not loaded (nothing to judge by)', () => {
    expect(withoutSecureChannelHits([{ id: 'a', channelId: 'vault' }], undefined)).toHaveLength(1);
  });
});
