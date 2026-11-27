import { describe, it, expect, beforeEach } from 'vitest';
import { lazyStatement } from '../helpers/lazyStatement';
import { settleReportsOfDeletedAccounts } from '../../utils/reportSettlement';

/**
 * The step that keeps the reports of a deleted account (#48). Its
 * statements are recorded when they RUN (a raw statement is sent only when
 * it is awaited), with their text and parameters; what PostgreSQL makes of
 * them (the locks granted in id order, the CASE arms reading the old row) was
 * not run against a database here.
 */

interface Ran { name: string; sql: string; values: unknown[] }

const ran: string[] = [];
const statements: Ran[] = [];
let reportRows: Array<{ id: string }> = [];

function sqlOf(strings: TemplateStringsArray): string {
  return strings.join('?').replace(/\s+/g, ' ').trim();
}

const tx = {
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = sqlOf(strings);
    const name = /^SELECT m\.id FROM messages/.test(sql) ? 'lock: the messages' : 'lock: the reports';
    statements.push({ name, sql, values });
    return lazyStatement(ran, name, name === 'lock: the messages' ? [] : reportRows);
  },
  $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push({ name: 'update: the reports', sql: sqlOf(strings), values });
    return lazyStatement(ran, 'update: the reports', reportRows.length);
  },
};

const settle = (ids: string[]) => settleReportsOfDeletedAccounts(tx as never, ids);
const statement = (name: string) => statements.find((s) => s.name === name)!;

beforeEach(() => {
  ran.length = 0;
  statements.length = 0;
  reportRows = [{ id: 'rep-1' }, { id: 'rep-2' }];
});

describe('settleReportsOfDeletedAccounts', () => {
  it('locks the messages the reports name, then the reports, then updates them: three statements, each run', async () => {
    const kept = await settle(['u-1']);

    expect(ran).toEqual(['lock: the messages', 'lock: the reports', 'update: the reports']);
    expect(kept).toBe(2);
  });

  it('takes the messages FOR NO KEY UPDATE in id order, only those the accounts\' reports name', async () => {
    await settle(['u-1']);
    const { sql, values } = statement('lock: the messages');

    expect(sql).toBe(
      'SELECT m.id FROM messages m WHERE m.id IN ( SELECT r.message_id FROM reports r '
      + 'WHERE (r.reporter_id = ANY(?::text[]) OR r.reported_user_id = ANY(?::text[])) AND r.message_id IS NOT NULL ) '
      + 'ORDER BY m.id FOR NO KEY UPDATE OF m',
    );
    expect(values).toEqual([['u-1'], ['u-1']]);
  });

  it('takes the reports by or about the accounts FOR UPDATE in id order', async () => {
    await settle(['u-1', 'u-2']);
    const { sql, values } = statement('lock: the reports');

    expect(sql).toBe('SELECT id FROM reports WHERE reporter_id = ANY(?::text[]) OR reported_user_id = ANY(?::text[]) ORDER BY id FOR UPDATE');
    expect(values).toEqual([['u-1', 'u-2'], ['u-1', 'u-2']]);
  });

  describe('the one update', () => {
    let sql: string;
    let values: unknown[];
    beforeEach(async () => {
      await settle(['u-1', 'u-2']);
      ({ sql, values } = statement('update: the reports'));
    });

    it('updates exactly the rows it locked', () => {
      expect(sql).toMatch(/ WHERE r\.id = ANY\(\?::text\[\]\)$/);
      expect(values[values.length - 1]).toEqual(['rep-1', 'rep-2']);
      // every other parameter is the account list
      for (const value of values.slice(0, -1)) expect(value).toEqual(['u-1', 'u-2']);
    });

    it('the reported side: unlinked, its deletion marked on the database clock in UTC, its message link dropped, its username kept (taken from the account when the report has none)', () => {
      expect(sql).toContain('reported_user_id = CASE WHEN r.reported_user_id = ANY(?::text[]) THEN NULL ELSE r.reported_user_id END');
      expect(sql).toContain("reported_user_deleted_at = CASE WHEN r.reported_user_id = ANY(?::text[]) THEN (now() AT TIME ZONE 'UTC')::timestamp(3) ELSE r.reported_user_deleted_at END");
      expect(sql).toContain('message_id = CASE WHEN r.reported_user_id = ANY(?::text[]) THEN NULL WHEN ');
      expect(sql).toContain('reported_username = CASE WHEN r.reported_user_id = ANY(?::text[]) THEN COALESCE(r.reported_username, (SELECT u.username FROM users u WHERE u.id = r.reported_user_id)) ELSE r.reported_username END');
    });

    it('the reporter side: unlinked and its deletion marked', () => {
      expect(sql).toContain('reporter_id = CASE WHEN r.reporter_id = ANY(?::text[]) THEN NULL ELSE r.reporter_id END');
      expect(sql).toContain("reporter_deleted_at = CASE WHEN r.reporter_id = ANY(?::text[]) THEN (now() AT TIME ZONE 'UTC')::timestamp(3) ELSE r.reporter_deleted_at END");
    });

    // No report row is written twice in the deletion's transaction: a later
    // write of a row this one wrote would make PostgreSQL check its keys
    // again, key-sharing the other person's account row (utils/accountDeletion.ts)
    it('leaves no message link a later conversation delete of the transaction would set NULL: the reported side always loses it, the reporter side for a message of a direct conversation, and only then', () => {
      expect(sql).toContain(
        'message_id = CASE WHEN r.reported_user_id = ANY(?::text[]) THEN NULL '
        + 'WHEN EXISTS (SELECT 1 FROM messages m WHERE m.id = r.message_id AND m.conversation_id IS NOT NULL) THEN NULL '
        + 'ELSE r.message_id END',
      );
      expect(sql.match(/message_id =/g)).toHaveLength(1);
    });

    it('leaves no resolver link the user delete would set NULL: the deleted account as the resolver goes in the same update', () => {
      expect(sql).toContain('resolved_by_id = CASE WHEN r.resolved_by_id = ANY(?::text[]) THEN NULL ELSE r.resolved_by_id END');
      expect(sql.match(/resolved_by_id = CASE/g)).toHaveLength(1);
    });

    it('a report whose two sides are both deleted here is settled once: both sides in the one statement, each decided on the row as it was', () => {
      expect(statements.filter((s) => s.name === 'update: the reports')).toHaveLength(1);
      // in an UPDATE every right-hand side reads the row as it was, so each
      // CASE tests the side's old value whatever the order of the assignments
      expect(sql).toMatch(/^UPDATE reports r SET /);
      expect(sql.match(/CASE WHEN r\.reported_user_id = ANY/g)).toHaveLength(4);
      expect(sql.match(/CASE WHEN r\.reporter_id = ANY/g)).toHaveLength(2);
    });

    it('never touches the copy of the reported content', () => {
      expect(sql).not.toMatch(/message_content|content_source/);
    });
  });

  it('no report of the accounts: the two locks run, no update', async () => {
    reportRows = [];

    expect(await settle(['u-1'])).toBe(0);
    expect(ran).toEqual(['lock: the messages', 'lock: the reports']);
  });

  it('no account: no statement at all', async () => {
    expect(await settle([])).toBe(0);
    expect(ran).toEqual([]);
  });
});
