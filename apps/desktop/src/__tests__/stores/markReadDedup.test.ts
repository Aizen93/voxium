import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

/**
 * A repeated mark-read of the same channel or conversation is skipped inside
 * a short window. The window is read on the device's clock, and a clock set
 * back since the last mark never counts as inside it.
 */

vi.mock('../../services/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() },
}));
vi.mock('../../stores/toastStore', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('../../services/e2e/dmCrypto', () => ({ resolveEncryptedPreview: vi.fn() }));

import { api } from '../../services/api';
import { useDMStore } from '../../stores/dmStore';
import { useServerStore } from '../../stores/serverStore';

const post = api.post as unknown as Mock;
const START = new Date('2026-01-01T12:00:00.000Z').getTime();

const cases = [
  {
    name: 'DM conversation',
    mark: (id: string) => useDMStore.getState().markConversationRead(id),
    url: (id: string) => `/dm/${id}/read`,
    id: (n: string) => `conv-${n}`,
  },
  {
    name: 'channel',
    mark: (id: string) => useServerStore.getState().markChannelRead(id, 'srv-1'),
    url: (id: string) => `/servers/srv-1/channels/${id}/read`,
    id: (n: string) => `ch-${n}`,
  },
];

describe.each(cases)('mark-read of a $name', ({ mark, url, id }) => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    post.mockReset().mockResolvedValue({ data: {} });
  });
  afterEach(() => vi.useRealTimers());

  const sent = (target: string) => post.mock.calls.filter(([u]) => u === url(target)).length;

  it('skips a second mark inside the window', () => {
    const a = id('inside');
    mark(a);
    vi.setSystemTime(START + 1999);
    mark(a);
    expect(sent(a)).toBe(1);
  });

  it('sends a mark after the window', () => {
    const a = id('after');
    mark(a);
    vi.setSystemTime(START + 2000);
    mark(a);
    expect(sent(a)).toBe(2);
  });

  it('sends a mark at once after the clock was set back', () => {
    const a = id('back');
    mark(a);
    vi.setSystemTime(START - 3_600_000);
    mark(a);
    expect(sent(a)).toBe(2);
  });

  it('never skips another target inside the window', () => {
    const a = id('one');
    const b = id('two');
    mark(a);
    mark(b);
    expect(sent(a)).toBe(1);
    expect(sent(b)).toBe(1);
  });
});
