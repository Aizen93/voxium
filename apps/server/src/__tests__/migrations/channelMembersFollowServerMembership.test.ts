import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 20261111130000_channel_members_follow_server_membership deletes the
 * ChannelMember rows no membership of the channel's space backs (the user is
 * not a member, or their membership began after the row was written), then
 * the channel-scope key shares whose recipient holds no row in that channel.
 * Its behaviour was exercised against the development database inside a
 * transaction that was rolled back, one fixture per predicate, and a second
 * run deleting nothing. What this pins is the SHAPE that made it safe: data
 * only, two statements in that order, no channel deleted, keyed on the
 * membership of the channel's own space.
 */

const MIGRATION = resolve(
  __dirname,
  '../../../prisma/migrations/20261111130000_channel_members_follow_server_membership/migration.sql',
);
const sql = readFileSync(MIGRATION, 'utf8');
const commentLines = sql.split(/\r?\n/).filter((line) => line.trim().startsWith('--'));
/** The statements, comments stripped. */
const statements = sql
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

describe('the channel_members migration', () => {
  it('is two DELETEs, the rows first and the key shares second, and nothing else: no schema change, no channel deleted', () => {
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^DELETE FROM "channel_members" cm\b/);
    expect(statements[1]).toMatch(/^DELETE FROM "e2e_key_shares" ks\b/);
    expect(statements.join('\n')).not.toMatch(/\b(ALTER|CREATE|DROP|TRUNCATE|UPDATE|INSERT)\b/i);
    expect(statements.join('\n')).not.toMatch(/DELETE FROM "channels"/);
    // ...and it says so, for the channel a departed creator left behind
    expect(commentLines.join('\n')).toMatch(/No channel is deleted/);
  });

  it('deletes a row unless a membership of the channel\'s OWN space that began no later than the row backs it', () => {
    const [rows] = statements;
    expect(rows).toMatch(/USING "channels" c\s+WHERE c\."id" = cm\."channel_id"/);
    expect(rows).toMatch(
      /AND NOT EXISTS \(\s*SELECT 1 FROM "server_members" sm\s+WHERE sm\."user_id" = cm\."user_id"\s+AND sm\."server_id" = c\."server_id"\s+AND sm\."joined_at" <= cm\."added_at"\s*\)$/,
    );
  });

  it('deletes a channel-scope key share whose recipient holds no row in that channel, and touches no other scope', () => {
    const [, shares] = statements;
    // `ch:` only: `chv:` (voice) and bare DM ids do not match the prefix
    expect(shares).toMatch(/WHERE ks\."conversation_id" LIKE 'ch:%'/);
    expect(shares).toMatch(
      /AND NOT EXISTS \(\s*SELECT 1 FROM "channel_members" cm\s+WHERE cm\."channel_id" = substr\(ks\."conversation_id", 4\)\s+AND cm\."user_id" = ks\."recipient_user_id"\s*\)$/,
    );
  });

  it('says what its time predicate rests on: the application\'s clock, one instance, and what a clock step costs', () => {
    const comments = commentLines.join('\n');
    expect(comments).toMatch(/APPLICATION's clock/);
    expect(comments).toMatch(/single-instance deployment/);
    expect(comments).toMatch(/clock\s+--\s+stepped backwards|clock stepped backwards/);
    expect(comments).toMatch(/only ever removes access/);
  });

  it('is idempotent: its only conditions are the state it produces, so a second run matches nothing', () => {
    // No time window relative to now, no id list, no flag a run would flip
    expect(statements.join('\n')).not.toMatch(/\b(now\(\)|interval|IN \(')/i);
  });

  it('ends with the read-only counts an operator can run before applying it, as comments only', () => {
    const tail = commentLines.join('\n');
    for (const what of [
      'Rows whose user is not a member',
      'Rows older than their user\'s current membership',
      'Secure channels whose creator is not a member',
      'Channel-scope key shares statement 2 will remove',
    ]) {
      expect(tail).toContain(what);
    }
    expect((tail.match(/SELECT count\(\*\)/g) ?? []).length).toBe(4);
    // never as statements
    expect(statements.join('\n')).not.toMatch(/SELECT count/);
  });
});
