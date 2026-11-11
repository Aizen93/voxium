import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 20261111130000_channel_members_follow_server_membership deletes the
 * ChannelMember rows whose user is not a member of the channel's space (a
 * secure channel's access is derived from the row alone). Its behaviour was
 * exercised against the development database inside a transaction that was
 * rolled back: a row of a non-member deleted, a member's row kept, a second
 * run deleting nothing. What this pins is the SHAPE that made it safe: data
 * only, one statement, keyed on the membership of the channel's own space.
 */

const MIGRATION = resolve(
  __dirname,
  '../../../prisma/migrations/20261111130000_channel_members_follow_server_membership/migration.sql',
);
const sql = readFileSync(MIGRATION, 'utf8');
/** The statements, comments stripped. */
const statements = sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

describe('the channel_members migration', () => {
  it('is one DELETE on channel_members and nothing else: no schema change, no other table written', () => {
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^DELETE FROM "channel_members" cm\b/);
    expect(statements.join('\n')).not.toMatch(/\b(ALTER|CREATE|DROP|TRUNCATE|UPDATE|INSERT)\b/i);
  });

  it('deletes exactly the rows whose user is not a member of the channel\'s OWN space', () => {
    const [del] = statements;
    // the channel's space, through the channel row
    expect(del).toMatch(/USING "channels" c\s+WHERE c\."id" = cm\."channel_id"/);
    // no membership of that space for that user
    expect(del).toMatch(
      /AND NOT EXISTS \(\s*SELECT 1 FROM "server_members" sm\s+WHERE sm\."user_id" = cm\."user_id"\s+AND sm\."server_id" = c\."server_id"\s*\)$/,
    );
  });

  it('is idempotent: its only condition is the state it produces, so a second run matches nothing', () => {
    // No time window, no id list, no flag a run would flip: what it deletes
    // is defined by the membership tables alone
    expect(statements[0]).not.toMatch(/\b(now\(\)|interval|IN \(')/i);
  });
});
