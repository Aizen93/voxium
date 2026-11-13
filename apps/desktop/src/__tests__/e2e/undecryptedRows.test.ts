// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { buildMegolmEnvelope } from '@voxium/shared';
import type { Message } from '@voxium/shared';
import {
  PENDING_FAILURES_MAX,
  SESSION_ARRIVALS_MAX,
  arrivalMark,
  noteSessionsAvailable,
  noteUndecrypted,
  syncWithView,
  hasDueRows,
  takeDueRows,
  retryLater,
  setViewScopeSource,
  noteQuoteAwaiting,
  quoteAwaits,
  resetUndecryptedRows,
} from '../../services/e2e/undecryptedRows';

/**
 * The held rows behind the retry on key arrival: a failure is held once the
 * view shows that version of the row, which rows are due, and that the bounds
 * protect the rows on screen.
 */

const peer = { id: 'peer', username: 'peer', displayName: 'Peer' };
/** The row as the gate received it (ciphertext in `content`). */
const wire = (id: string, sid: string, over: Partial<Message> = {}): Message =>
  ({
    id, content: buildMegolmEnvelope(sid, 'Y2lwaGVy'), encrypted: true, conversationId: 'c1', channelId: null,
    author: peer, editedAt: null, ...over,
  }) as unknown as Message;
/** The same row as the view shows it after a refusal (no text). */
const shown = (row: Message): Message => ({ ...row, content: '' });
const ids = (rows: Message[]) => rows.map((m) => m.id);

beforeEach(() => {
  resetUndecryptedRows();
  setViewScopeSource(null);
});

describe('rows held to be decrypted again', () => {
  it('holds a failure once the view shows that version, due when its own session is announced after its decrypt began', () => {
    const m1 = wire('m1', 'c2lkQQ');
    noteUndecrypted(m1, 'c1', arrivalMark());
    noteSessionsAvailable('c1', ['c2lkQQ']);
    // not in the view yet: nothing is held
    expect(hasDueRows('c1')).toBe(false);

    syncWithView('c1', [shown(m1)]);
    expect(hasDueRows('c1')).toBe(true);
    expect(ids(takeDueRows('c1'))).toEqual(['m1']);
    // taken: tried once per announcement
    expect(hasDueRows('c1')).toBe(false);
    noteSessionsAvailable('c2', ['c2lkQQ']);
    noteSessionsAvailable('c1', ['c2lkQg']);
    expect(hasDueRows('c1')).toBe(false);
    noteSessionsAvailable('c1', ['c2lkQQ']);
    expect(ids(takeDueRows('c1'))).toEqual(['m1']);
  });

  it('a session announced before the decrypt began does not make the row due', () => {
    noteSessionsAvailable('c1', ['c2lkQQ']);
    const m1 = wire('m1', 'c2lkQQ');
    noteUndecrypted(m1, 'c1', arrivalMark());
    syncWithView('c1', [shown(m1)]);
    expect(hasDueRows('c1')).toBe(false);
  });

  it('holds the version the view shows, under the newest failure for it', () => {
    const v1 = wire('m1', 'c2lkQQ');
    const v2 = wire('m1', 'c2lkQg', { editedAt: '2026-11-01T11:00:00.000Z' });
    noteUndecrypted(v1, 'c1', arrivalMark());
    syncWithView('c1', [shown(v1)]);
    noteUndecrypted(v2, 'c1', arrivalMark());
    // the view still shows v1: v2's failure waits, v1 stays held
    noteSessionsAvailable('c1', ['c2lkQQ', 'c2lkQg']);
    expect(takeDueRows('c1').map((m) => m.editedAt)).toEqual([null]);

    // a later failure of v1 itself (a try that failed) replaces it, under its own mark
    noteUndecrypted(v1, 'c1', arrivalMark());
    syncWithView('c1', [shown(v1)]);
    noteSessionsAvailable('c1', ['c2lkQg']);
    expect(hasDueRows('c1')).toBe(false);

    // the view moves to v2: v1 is let go, v2 held and due
    syncWithView('c1', [shown(v2)]);
    expect(takeDueRows('c1').map((m) => m.editedAt)).toEqual(['2026-11-01T11:00:00.000Z']);
  });

  it('lets go of a row the view no longer shows refused: deleted, opened, or another scope on screen', () => {
    const m1 = wire('m1', 'c2lkQQ');
    const m2 = wire('m2', 'c2lkQQ');
    const m3 = wire('m3', 'c2lkQQ');
    for (const m of [m1, m2, m3]) noteUndecrypted(m, 'c1', arrivalMark());
    syncWithView('c1', [shown(m1), shown(m2), shown(m3)]);
    // m1 deleted, m2 opened with its text
    syncWithView('c1', [{ ...m2, content: 'its text' } as Message, shown(m3)]);
    noteSessionsAvailable('c1', ['c2lkQQ']);
    expect(ids(takeDueRows('c1'))).toEqual(['m3']);

    noteSessionsAvailable('c1', ['c2lkQQ']);
    syncWithView('c2', []);
    expect(hasDueRows('c1')).toBe(false);
    syncWithView('c1', [shown(m3)]);
    expect(hasDueRows('c1')).toBe(false);
  });

  it('matches a row by the scope on screen: a conversation row by its conversation, a channel row by its channel', () => {
    // a conversation row that also names a channel is still the conversation's
    const dm = wire('m1', 'c2lkQQ', { channelId: 'ch9' } as Partial<Message>);
    noteUndecrypted(dm, 'c1', arrivalMark());
    const inChannel = wire('m2', 'c2lkQQ', { channelId: 'ch1', conversationId: null } as Partial<Message>);
    noteUndecrypted(inChannel, 'ch:ch1', arrivalMark());
    noteSessionsAvailable('c1', ['c2lkQQ']);
    noteSessionsAvailable('ch:ch1', ['c2lkQQ']);
    syncWithView('c1', [shown(dm)]);
    expect(ids(takeDueRows('c1'))).toEqual(['m1']);
    syncWithView('ch:ch1', [shown(inChannel)]);
    expect(ids(takeDueRows('ch:ch1'))).toEqual(['m2']);
  });

  it('keeps the failure of each scope apart when an id is used in two', () => {
    const here = wire('m1', 'c2lkQQ');
    const elsewhere = wire('m1', 'c2lkQg', { conversationId: 'c2' });
    noteUndecrypted(here, 'c1', arrivalMark());
    noteUndecrypted(elsewhere, 'c2', arrivalMark());
    noteSessionsAvailable('c1', ['c2lkQQ']);
    syncWithView('c1', [shown(here)]);
    expect(takeDueRows('c1').map((m) => m.content)).toEqual([here.content]);
  });

  it('does not note a failure of a scope that is not on screen', () => {
    setViewScopeSource(() => 'c1');
    const elsewhere = wire('x1', 'c2lkQQ', { conversationId: 'c2' });
    noteUndecrypted(elsewhere, 'c2', arrivalMark());
    noteSessionsAvailable('c2', ['c2lkQQ']);
    syncWithView('c2', [shown(elsewhere)]);
    expect(hasDueRows('c2')).toBe(false);
  });

  it('holds only a Megolm row', () => {
    const olm = { ...wire('m1', 'c2lkQQ'), content: '{"v":1,"e":"olm1","t":1,"b":"Y2lwaGVy"}' } as Message;
    const garbage = { ...wire('m2', 'c2lkQQ'), content: 'not an envelope' } as Message;
    noteUndecrypted(olm, 'c1', arrivalMark());
    noteUndecrypted(garbage, 'c1', arrivalMark());
    noteSessionsAvailable('c1', ['c2lkQQ']);
    syncWithView('c1', [shown(olm), shown(garbage)]);
    expect(hasDueRows('c1')).toBe(false);
  });

  it('a try that ended in an error stays held and due, for the same version only', () => {
    const m1 = wire('m1', 'c2lkQQ');
    noteUndecrypted(m1, 'c1', arrivalMark());
    syncWithView('c1', [shown(m1)]);
    noteSessionsAvailable('c1', ['c2lkQQ']);
    const [taken] = takeDueRows('c1');
    retryLater(taken);
    expect(ids(takeDueRows('c1'))).toEqual(['m1']);
    retryLater({ ...taken, editedAt: '2026-11-01T11:00:00.000Z' } as Message);
    expect(hasDueRows('c1')).toBe(false);
  });

  it(`never counts the rows the view shows against the ${PENDING_FAILURES_MAX} failures waiting for it`, () => {
    // rows on screen in c1, held
    const kept = [wire('k1', 'c2lkQQ'), wire('k2', 'c2lkQQ')];
    for (const m of kept) noteUndecrypted(m, 'c1', arrivalMark());
    syncWithView('c1', kept.map(shown));
    // a flood of failures noted after them (no watcher reads the scope on screen here)
    for (let i = 0; i <= PENDING_FAILURES_MAX; i++) noteUndecrypted(wire(`x${i}`, 'c2lkQQ', { conversationId: 'c2' }), 'c2', arrivalMark());
    noteSessionsAvailable('c1', ['c2lkQQ']);
    syncWithView('c1', kept.map(shown));
    expect(ids(takeDueRows('c1')).sort()).toEqual(['k1', 'k2']);
  });

  it(`keeps at most ${PENDING_FAILURES_MAX} failures waiting for the view, dropping the oldest`, () => {
    const flood = Array.from({ length: PENDING_FAILURES_MAX + 1 }, (_, i) => wire(`f${i}`, 'c2lkQg'));
    for (const m of flood) noteUndecrypted(m, 'c1', arrivalMark());
    noteSessionsAvailable('c1', ['c2lkQg']);
    syncWithView('c1', flood.map(shown));
    const due = ids(takeDueRows('c1'));
    expect(due).toHaveLength(PENDING_FAILURES_MAX);
    expect(due).not.toContain('f0');
    expect(due).toContain(`f${PENDING_FAILURES_MAX}`);
  });

  it(`remembers at most ${SESSION_ARRIVALS_MAX} announced sessions, dropping the oldest`, () => {
    const mark = arrivalMark();
    noteSessionsAvailable('c1', ['b2xkZXN0']);
    noteSessionsAvailable('c1', Array.from({ length: SESSION_ARRIVALS_MAX }, (_, i) => `c2lk${i}`));
    const m1 = wire('m1', 'b2xkZXN0');
    const m2 = wire('m2', 'c2lk0');
    noteUndecrypted(m1, 'c1', mark);
    noteUndecrypted(m2, 'c1', mark);
    syncWithView('c1', [shown(m1), shown(m2)]);
    expect(ids(takeDueRows('c1'))).toEqual(['m2']);
  });

  it('a quote waits as the very object the gate left empty, in its scope, for the row and author it names', () => {
    const quote = { id: 'q1', author: peer, encrypted: true, content: '' } as NonNullable<Message['replyTo']>;
    noteQuoteAwaiting(quote, 'c1');
    expect(quoteAwaits(quote, 'c1', 'q1')).toBe(true);
    expect(quoteAwaits(quote, 'c2', 'q1')).toBe(false);
    expect(quoteAwaits(quote, 'c1', 'q2')).toBe(false);
    // an equal quote that is another object never waited (a locked one, a row gated again)
    expect(quoteAwaits({ ...quote }, 'c1', 'q1')).toBe(false);
    // filled, or naming another author since, it no longer waits
    expect(quoteAwaits({ ...quote, content: 'x' } as NonNullable<Message['replyTo']>, 'c1', 'q1')).toBe(false);
    const renamed = quote as { author: { id: string } };
    renamed.author = { ...peer, id: 'someone-else' };
    expect(quoteAwaits(quote, 'c1', 'q1')).toBe(false);
  });

  it('notes a waiting quote only for the scope on screen', () => {
    setViewScopeSource(() => 'c1');
    const elsewhere = { id: 'q1', author: peer, encrypted: true, content: '' } as NonNullable<Message['replyTo']>;
    noteQuoteAwaiting(elsewhere, 'c2');
    expect(quoteAwaits(elsewhere, 'c2', 'q1')).toBe(false);
    const here = { ...elsewhere };
    noteQuoteAwaiting(here, 'c1');
    expect(quoteAwaits(here, 'c1', 'q1')).toBe(true);
  });

  it('a reset drops failures, held rows, announcements and waiting quotes', () => {
    const m1 = wire('m1', 'c2lkQQ');
    const mark = arrivalMark();
    noteSessionsAvailable('c1', ['c2lkQQ']);
    noteUndecrypted(m1, 'c1', mark);
    const quote = { id: 'm1', author: peer, encrypted: true, content: '' } as NonNullable<Message['replyTo']>;
    noteQuoteAwaiting(quote, 'c1');
    resetUndecryptedRows();
    syncWithView('c1', [shown(m1)]);
    expect(hasDueRows('c1')).toBe(false);
    expect(quoteAwaits(quote, 'c1', 'm1')).toBe(false);
  });
});
