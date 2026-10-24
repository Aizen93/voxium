import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findEveryoneMentions, mentionsEveryone, PERMISSION_LIST, Permissions } from '@voxium/shared';

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

  it('findEveryoneMentions reports where each token starts — the ONE scan the server flags with and the renderer segments with', () => {
    expect(findEveryoneMentions('hey @everyone')).toEqual([4]);
    // right after a user mention: the server flags it, the renderer draws it
    expect(findEveryoneMentions('@[clx1]@everyone')).toEqual([7]);
    expect(findEveryoneMentions('@everyone twice: @everyone')).toEqual([0, 17]);
    expect(findEveryoneMentions('@everyone')).toEqual([0]);
    // inside a user mention it is part of the mention, not a token
    expect(findEveryoneMentions('@[@everyone] hi')).toEqual([]);
    expect(findEveryoneMentions('me@everyone @everyones @everyone-ish @@everyone')).toEqual([]);
    expect(findEveryoneMentions('')).toEqual([]);
  });

  it('the shared module compiles no lookbehind: the oldest WebKit the desktop app runs on rejects one at PARSE time, taking the whole bundle down', () => {
    const source = readFileSync(resolve(__dirname, '../../../../../packages/shared/src/constants.ts'), 'utf8');
    expect(source).not.toMatch(/\(\?<[!=]/);
  });

  it('the permission the token is gated on is a channel-level text flag', () => {
    const entry = PERMISSION_LIST.find((p) => p.key === 'MENTION_EVERYONE');
    expect(entry).toBeDefined();
    expect(entry?.flag).toBe(Permissions.MENTION_EVERYONE);
    expect(entry?.category).toBe('text');
  });
});
