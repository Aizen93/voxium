import { expect, type Locator } from '@playwright/test';

/**
 * Waits on the message list's scroll position instead of sleeping.
 *
 * A virtualized list (Virtuoso) keeps adjusting itself for a few frames after
 * anything changes: it measures rows, corrects its estimates, re-applies a
 * scroll it was asked for. A check made in the middle of that is a check of a
 * state the user never sees. "Settled" here means the condition holds AND the
 * scroller's metrics (scrollTop, scrollHeight, clientHeight) did not change
 * across every one of `frames` consecutive animation frames, all read inside
 * the page. A list that is still moving keeps the poll going; one that comes
 * to rest returns at once, however slow the machine.
 */

export interface ScrollSample {
  /** The metrics never changed across the frames sampled */
  steady: boolean;
  /** Pixels between the bottom of the viewport and the end of the list */
  gap: number;
  scrollTop: number;
  scrollHeight: number;
}

/** Samples the scroller over `frames` animation frames. */
export function sampleScroll(scroller: Locator, frames: number): Promise<ScrollSample> {
  return scroller.evaluate(
    (el, n) =>
      new Promise<ScrollSample>((resolve) => {
        const read = () => `${el.scrollTop}|${el.scrollHeight}|${el.clientHeight}`;
        const first = read();
        let steady = true;
        let left = n;
        const tick = () => {
          if (read() !== first) steady = false;
          if (--left > 0) {
            requestAnimationFrame(tick);
            return;
          }
          resolve({
            steady,
            gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
          });
        };
        requestAnimationFrame(tick);
      }),
    frames,
  );
}

/** What a poll below answers once its condition holds; until then it answers the last sample. */
const SETTLED = 'settled';

/**
 * Waits until the list rests with `accept(sample)` true, and returns that
 * sample. On a timeout the failure shows the last sample as the received value.
 */
export async function untilSettled(
  scroller: Locator,
  label: string,
  accept: (s: ScrollSample) => boolean,
  frames = 10,
): Promise<ScrollSample> {
  let last: ScrollSample | null = null;
  await expect
    .poll(
      async () => {
        const sample = await sampleScroll(scroller, frames);
        last = sample;
        return sample.steady && accept(sample) ? SETTLED : JSON.stringify(sample);
      },
      { message: label },
    )
    .toBe(SETTLED);
  return last!;
}

/** Waits until the list rests at its very bottom. */
export function untilSettledAtBottom(scroller: Locator, label: string, maxGap = 2): Promise<ScrollSample> {
  return untilSettled(scroller, `${label}: list at rest at the bottom`, (s) => s.gap <= maxGap);
}

/**
 * Reads scrollTop on every one of `frames` animation frames and returns the
 * lowest and highest value seen, and where the list ended. This is a measured
 * time window, not a wait on a condition: it is for checking that something
 * does NOT happen (a reading position that must not move), which no event can
 * signal. Every frame is read, so a move that is undone within the window is
 * still seen.
 */
export function watchScrollTop(
  scroller: Locator,
  frames: number,
): Promise<{ min: number; max: number; gap: number }> {
  return scroller.evaluate(
    (el, n) =>
      new Promise<{ min: number; max: number; gap: number }>((resolve) => {
        let min = el.scrollTop;
        let max = el.scrollTop;
        let left = n;
        const tick = () => {
          min = Math.min(min, el.scrollTop);
          max = Math.max(max, el.scrollTop);
          if (--left > 0) {
            requestAnimationFrame(tick);
            return;
          }
          resolve({ min, max, gap: el.scrollHeight - el.scrollTop - el.clientHeight });
        };
        requestAnimationFrame(tick);
      }),
    frames,
  );
}

/**
 * Waits until the message row `messageId` rests fully inside the scroller's
 * viewport (2 px of tolerance): its box and the scroller's metrics unchanged
 * across `frames` consecutive frames, and inside on every one of them.
 */
export async function untilRowRestsInView(scroller: Locator, messageId: string, label: string, frames: number) {
  type Sample = { steady: boolean; inside: boolean; row: string | null };
  await expect
    .poll(
      async () => {
        const sample = await scroller.evaluate(
          (el, [id, n]) =>
            new Promise<Sample>((resolve) => {
              const read = () => {
                const row = document.querySelector(`[data-message-id="${id}"]`);
                if (!row) return { key: 'missing', inside: false, row: null };
                const r = row.getBoundingClientRect();
                const s = el.getBoundingClientRect();
                const inside = r.top >= s.top - 2 && r.bottom <= s.bottom + 2;
                const box = `${Math.round(r.top)}..${Math.round(r.bottom)} in ${Math.round(s.top)}..${Math.round(s.bottom)}`;
                return { key: `${box}|${el.scrollTop}|${el.scrollHeight}`, inside, row: box };
              };
              const first = read();
              let steady = true;
              let inside = first.inside;
              let left = n as number;
              const tick = () => {
                const now = read();
                if (now.key !== first.key) steady = false;
                inside = inside && now.inside;
                if (--left > 0) {
                  requestAnimationFrame(tick);
                  return;
                }
                resolve({ steady, inside, row: now.row });
              };
              requestAnimationFrame(tick);
            }),
          [messageId, frames] as const,
        );
        return sample.steady && sample.inside ? SETTLED : JSON.stringify(sample);
      },
      { message: `${label}: row at rest inside the viewport` },
    )
    .toBe(SETTLED);
}
