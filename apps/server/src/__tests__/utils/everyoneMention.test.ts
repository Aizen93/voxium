import { describe, it, expect } from 'vitest';
import { EVERYONE_MENTION_RE, mentionsEveryone, PERMISSION_LIST, Permissions } from '@voxium/shared';

// The MENTION_EVERYONE flag existed with nothing checking it. The token the
// permission gates is this one; whether it PINGS is the server's decision at
// send time (routes/messages.ts), stored on the row.

describe('mentionsEveryone — the @everyone token', () => {
  it('matches the token on its own, at the start, after whitespace or punctuation, in any case of surrounding text', () => {
    for (const text of ['@everyone', '@everyone meeting in 5', 'hey @everyone', 'ping: @everyone!', 'line one\n@everyone', '(@everyone)']) {
      expect(mentionsEveryone(text), text).toBe(true);
    }
  });

  it('does not match a longer word, a user mention, an e-mail-like run or a doubled @', () => {
    for (const text of ['@everyone2', '@everyone-else', '@everyones', 'me@everyone', '@@everyone', '@[everyone]', 'everyone', '@Everyone']) {
      expect(mentionsEveryone(text), text).toBe(false);
    }
  });

  it('is case-sensitive on purpose: the token is a fixed spelling, like a command', () => {
    expect(mentionsEveryone('@EVERYONE')).toBe(false);
  });

  it('the shared regex matches the token alone (a lookbehind), so the server and the renderer agree on where it starts', () => {
    const re = new RegExp(EVERYONE_MENTION_RE.source, EVERYONE_MENTION_RE.flags);
    const match = re.exec('hey @everyone');
    expect(match?.[0]).toBe('@everyone');
    expect(match?.index).toBe(4);
    // right after a user mention — the renderer's combined regex sees the same token
    expect(mentionsEveryone('@[clx1]@everyone')).toBe(true);
    expect(new RegExp(EVERYONE_MENTION_RE.source).exec('@[clx1]@everyone')?.index).toBe(7);
  });

  it('the permission the token is gated on is a channel-level text flag', () => {
    const entry = PERMISSION_LIST.find((p) => p.key === 'MENTION_EVERYONE');
    expect(entry).toBeDefined();
    expect(entry?.flag).toBe(Permissions.MENTION_EVERYONE);
    expect(entry?.category).toBe('text');
  });
});
