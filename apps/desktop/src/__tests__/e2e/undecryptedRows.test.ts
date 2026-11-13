// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { buildMegolmEnvelope } from '@voxium/shared';
import type { Message } from '@voxium/shared';
import {
  UNDECRYPTED_ROWS_MAX,
  SESSION_ARRIVALS_MAX,
  arrivalMark,
  noteSessionsAvailable,
  holdUndecrypted,
  forgetUndecrypted,
  hasDueRows,
  takeDueRows,
  clearUndecryptedRows,
  resetUndecryptedRows,
} from '../../services/e2e/undecryptedRows';

/**
 * The held rows behind the retry on key arrival: which rows are due, for how
 * long they are held, and that the bounds hold.
 */

const row = (id: string, sid: string): Message =>
  ({ id, content: buildMegolmEnvelope(sid, 'Y2lwaGVy'), encrypted: true, conversationId: 'c1' }) as unknown as Message;
const all = () => true;

beforeEach(() => {
  resetUndecryptedRows();
});

describe('rows held to be decrypted again', () => {
  it('a row becomes due once its own session is announced in its own scope after its decrypt began', () => {
    holdUndecrypted(row('m1', 'c2lkQQ'), 'c1', arrivalMark());
    expect(hasDueRows('c1')).toBe(false);
    noteSessionsAvailable('c2', ['c2lkQQ']);
    noteSessionsAvailable('c1', ['c2lkQg']);
    expect(hasDueRows('c1')).toBe(false);
    noteSessionsAvailable('c1', ['c2lkQQ']);
    expect(hasDueRows('c1')).toBe(true);
    expect(takeDueRows('c1', all).map((m) => m.id)).toEqual(['m1']);
    // taken: tried once per announcement
    expect(hasDueRows('c1')).toBe(false);
  });

  it('a session announced before the decrypt began does not make the row due', () => {
    noteSessionsAvailable('c1', ['c2lkQQ']);
    holdUndecrypted(row('m1', 'c2lkQQ'), 'c1', arrivalMark());
    expect(hasDueRows('c1')).toBe(false);
  });

  it('a due row the view does not show yet stays due for when it lands', () => {
    holdUndecrypted(row('m1', 'c2lkQQ'), 'c1', arrivalMark());
    noteSessionsAvailable('c1', ['c2lkQQ']);
    expect(takeDueRows('c1', () => false)).toEqual([]);
    expect(hasDueRows('c1')).toBe(true);
    expect(takeDueRows('c1', all).map((m) => m.id)).toEqual(['m1']);
  });

  it('a forgotten or cleared row is no longer held, and a reset drops the announcements too', () => {
    holdUndecrypted(row('m1', 'c2lkQQ'), 'c1', arrivalMark());
    holdUndecrypted(row('m2', 'c2lkQQ'), 'c1', arrivalMark());
    forgetUndecrypted('m1');
    noteSessionsAvailable('c1', ['c2lkQQ']);
    expect(takeDueRows('c1', all).map((m) => m.id)).toEqual(['m2']);

    holdUndecrypted(row('m3', 'c2lkQw'), 'c1', arrivalMark());
    noteSessionsAvailable('c1', ['c2lkQw']);
    clearUndecryptedRows();
    expect(hasDueRows('c1')).toBe(false);

    // held while its decrypt ran, the session announced meanwhile: due, unless a reset came between
    const mark = arrivalMark();
    noteSessionsAvailable('c1', ['c2lkRA']);
    resetUndecryptedRows();
    holdUndecrypted(row('m4', 'c2lkRA'), 'c1', mark);
    expect(hasDueRows('c1')).toBe(false);
  });

  it('holds only a Megolm row', () => {
    const olm = { ...row('m1', 'c2lkQQ'), content: '{"v":1,"e":"olm1","t":1,"b":"Y2lwaGVy"}' } as Message;
    holdUndecrypted(olm, 'c1', arrivalMark());
    holdUndecrypted({ ...row('m2', 'c2lkQQ'), content: 'not an envelope' } as Message, 'c1', arrivalMark());
    noteSessionsAvailable('c1', ['c2lkQQ']);
    expect(hasDueRows('c1')).toBe(false);
  });

  it(`holds at most ${UNDECRYPTED_ROWS_MAX} rows, dropping the oldest`, () => {
    const mark = arrivalMark();
    for (let i = 0; i <= UNDECRYPTED_ROWS_MAX; i++) holdUndecrypted(row(`m${i}`, 'c2lkQQ'), 'c1', mark);
    noteSessionsAvailable('c1', ['c2lkQQ']);
    const due = takeDueRows('c1', all).map((m) => m.id);
    expect(due).toHaveLength(UNDECRYPTED_ROWS_MAX);
    expect(due).not.toContain('m0');
    expect(due).toContain(`m${UNDECRYPTED_ROWS_MAX}`);
  });

  it(`remembers at most ${SESSION_ARRIVALS_MAX} announced sessions, dropping the oldest`, () => {
    const mark = arrivalMark();
    noteSessionsAvailable('c1', ['b2xkZXN0']);
    noteSessionsAvailable('c1', Array.from({ length: SESSION_ARRIVALS_MAX }, (_, i) => `c2lk${i}`));
    // the oldest announcement is gone: a row held after it is not due for it
    holdUndecrypted(row('m1', 'b2xkZXN0'), 'c1', mark);
    holdUndecrypted(row('m2', 'c2lk0'), 'c1', mark);
    expect(takeDueRows('c1', all).map((m) => m.id)).toEqual(['m2']);
  });
});
