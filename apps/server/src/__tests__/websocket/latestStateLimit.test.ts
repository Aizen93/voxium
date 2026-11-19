import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { applyLatestState, SPEAKING_EVENTS_PER_MINUTE, SPEAKING_INDICATOR_EVENTS_PER_MINUTE } from '../../websocket/latestStateLimit';

/**
 * The latest-wins limiter behind voice:speaking and dm:voice:speaking: within
 * the budget a state applies at once; over it the LATEST state is held and
 * applied when the window ends, never dropped (#90).
 */
describe('applyLatestState', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the indicator budget is what an honest speaker sends (~360 a minute); the producer and the relay keep 600', () => {
    expect(SPEAKING_INDICATOR_EVENTS_PER_MINUTE).toBe(360);
    expect(SPEAKING_EVENTS_PER_MINUTE).toBe(600);
  });

  it('applies at once within the budget', () => {
    const socket = {};
    const applied: number[] = [];
    for (let i = 0; i < 3; i++) applyLatestState(socket, 'e', 3, () => applied.push(i));
    expect(applied).toEqual([0, 1, 2]);
  });

  it('over the budget holds only the latest state, and applies it once when the window ends', async () => {
    const socket = {};
    const applied: string[] = [];
    for (const v of ['a', 'b', 'c', 'd']) applyLatestState(socket, 'e', 2, () => applied.push(v));
    expect(applied).toEqual(['a', 'b']);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(applied).toEqual(['a', 'b']);
    await vi.advanceTimersByTimeAsync(1);
    expect(applied).toEqual(['a', 'b', 'd']);
    // The held one was charged to the new window: one more fits, then holds again
    applyLatestState(socket, 'e', 2, () => applied.push('e'));
    applyLatestState(socket, 'e', 2, () => applied.push('f'));
    expect(applied).toEqual(['a', 'b', 'd', 'e']);
  });

  it('a newer state accepted in the next window drops the held one, even when the timer runs late', async () => {
    const socket = {};
    const applied: string[] = [];
    applyLatestState(socket, 'e', 1, () => applied.push('a'));
    applyLatestState(socket, 'e', 1, () => applied.push('stale'));
    vi.setSystemTime(Date.now() + 60_001); // the window ended, its timer has not run
    applyLatestState(socket, 'e', 1, () => applied.push('new'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(applied).toEqual(['a', 'new']);
  });

  it('keeps one window per socket and per name', () => {
    const [s1, s2] = [{}, {}];
    const applied: string[] = [];
    applyLatestState(s1, 'x', 1, () => applied.push('s1x'));
    applyLatestState(s1, 'x', 1, () => applied.push('s1x-held'));
    applyLatestState(s1, 'y', 1, () => applied.push('s1y'));
    applyLatestState(s2, 'x', 1, () => applied.push('s2x'));
    expect(applied).toEqual(['s1x', 's1y', 's2x']);
  });

  it('a held state that throws is logged, never thrown into the timer', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const socket = {};
    applyLatestState(socket, 'e', 1, () => {});
    applyLatestState(socket, 'e', 1, () => { throw new Error('boom'); });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('held e state'), expect.any(Error));
    error.mockRestore();
  });
});
