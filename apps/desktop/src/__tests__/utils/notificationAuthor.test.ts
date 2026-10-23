import { describe, it, expect, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { notificationAuthorName } from '../../utils/notificationAuthor';

/**
 * A desktop notification has no APP tag to show, and a webhook picks its own
 * name on every post: "alice: send me your password" from a webhook would
 * read exactly like the member. The marker travels inside the text.
 */

const t = vi.fn((key: string) => (key === 'messageItem.appTag' ? 'APP' : key)) as unknown as TFunction;
const DOT = String.fromCharCode(0xb7);

describe('notificationAuthorName', () => {
  it('a webhook author carries the APP marker after its name', () => {
    expect(notificationAuthorName({ displayName: 'alice', username: 'alice', isWebhook: true }, t)).toBe(`alice ${DOT} APP`);
    expect(t).toHaveBeenCalledWith('messageItem.appTag');
  });

  it('a deleted webhook too (its rows keep the name they were posted under)', () => {
    expect(notificationAuthorName({ displayName: 'Old CI', username: 'Old CI', isWebhook: true }, t)).toBe(`Old CI ${DOT} APP`);
  });

  it('a human author is unchanged: display name, then username, then "Someone"', () => {
    expect(notificationAuthorName({ displayName: 'Alice', username: 'alice' }, t)).toBe('Alice');
    expect(notificationAuthorName({ displayName: '', username: 'alice' }, t)).toBe('alice');
    expect(notificationAuthorName({ displayName: 'Alice', username: 'alice', isWebhook: false }, t)).toBe('Alice');
    expect(notificationAuthorName(undefined, t)).toBe('Someone');
    expect(notificationAuthorName(null, t)).toBe('Someone');
  });

  it('only a literal true counts (a truthy string from a malformed row is not a webhook claim)', () => {
    expect(notificationAuthorName({ displayName: 'Alice', username: 'alice', isWebhook: 'yes' as unknown as boolean }, t)).toBe('Alice');
  });

  it('an unnamed webhook still says it is an app', () => {
    expect(notificationAuthorName({ displayName: '', username: '', isWebhook: true }, t)).toBe(`Someone ${DOT} APP`);
  });
});
