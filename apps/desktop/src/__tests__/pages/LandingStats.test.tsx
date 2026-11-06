import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The landing page's live figures poll `/stats` every 30 s. A failure is not
 * the visitor's problem (the cards keep their last figures, or the dash), but
 * it is logged, once per run of failures: an endpoint that is down must not
 * write to the console every 30 s, and must not be swallowed either.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }) };
});

import { StatsSection } from '../../pages/LandingPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const POLL_MS = 30_000;
const LOG_PREFIX = '[Landing] Failed to fetch stats:';

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let warn: MockInstance<typeof console.warn>;

class FakeObserver {
  observe() {}
  disconnect() {}
}

const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data }) });
const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };
const statsWarnings = () => warn.mock.calls.filter(([first]) => first === LOG_PREFIX);

async function mount() {
  await act(async () => { root.render(<StatsSection />); });
  await flush();
}
async function nextPoll() {
  await act(async () => { vi.advanceTimersByTime(POLL_MS); });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  warn.mockRestore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('landing stats: a failed fetch is logged, once per run of failures', () => {
  it('logs a network failure once, keeps polling, and the cards show the dash', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    await mount();
    await nextPoll();
    await nextPoll();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/stats$/));
    expect(statsWarnings()).toEqual([[LOG_PREFIX, 'network down']]);
    expect(container.textContent!.split('—').length - 1).toBe(3);
  });

  it('a non-OK answer is a failure too, logged with its status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve({}) });

    await mount();

    expect(statsWarnings()).toEqual([[LOG_PREFIX, 'HTTP 503']]);
    expect(container.textContent!.split('—').length - 1).toBe(3);
  });

  it('logs again after a fetch has succeeded in between', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('first outage'))
      .mockImplementationOnce(() => ok({ users: 3, servers: 2, messages: 10 }))
      .mockRejectedValueOnce(new Error('second outage'));

    await mount();
    await nextPoll();
    await nextPoll();

    expect(statsWarnings()).toEqual([[LOG_PREFIX, 'first outage'], [LOG_PREFIX, 'second outage']]);
  });

  it('a successful fetch logs nothing and replaces the dash', async () => {
    fetchMock.mockImplementation(() => ok({ users: 3, servers: 2, messages: 10 }));

    await mount();

    expect(statsWarnings()).toEqual([]);
    expect(container.textContent).not.toContain('—');
  });
});
