import { describe, it, expect } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

import { encodeMemberCursor, decodeMemberCursor, hashMemberQuery, memberRoleRank, type MemberCursor } from '../../utils/memberCursor';
import { encodeSignedCursor, decodeSignedCursor } from '../../utils/signedCursor';

// The member directory's cursor: signed, bound to the server / query / filter /
// page size it was issued for, carrying the last row's (rank, joinedAt, id).

const cursor: MemberCursor = { serverId: 'srv-1', q: hashMemberQuery('al'), role: 'role-1', limit: 100, rank: 2, joinedAt: '2026-10-02T00:00:00.000Z', id: 'user-2' };
const expected = { serverId: 'srv-1', q: hashMemberQuery('al'), role: 'role-1', limit: 100 };

describe('memberCursor', () => {
  it('round-trips through an opaque signed token', () => {
    const token = encodeMemberCursor(cursor);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(token).not.toContain('user-2');
    expect(decodeMemberCursor(token, expected)).toEqual(cursor);
  });

  it('refuses a tampered payload, a tampered signature and garbage', () => {
    const token = encodeMemberCursor(cursor);
    const [payload, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...cursor, id: 'user-1' }), 'utf8').toString('base64url');
    expect(decodeMemberCursor(`${forged}.${mac}`, expected)).toBeNull();
    expect(decodeMemberCursor(`${payload}.${mac.slice(0, -1)}A`, expected)).toBeNull();
    for (const bad of ['', 'x', 'a.b.c', 'é.é', 'a'.repeat(600), 42, null, undefined, {}]) {
      expect(decodeMemberCursor(bad, expected)).toBeNull();
    }
  });

  it('is bound to the server, the hashed query, the role filter and the page size', () => {
    const token = encodeMemberCursor(cursor);
    expect(decodeMemberCursor(token, { ...expected, serverId: 'srv-2' })).toBeNull();
    expect(decodeMemberCursor(token, { ...expected, q: hashMemberQuery('bo') })).toBeNull();
    expect(decodeMemberCursor(token, { ...expected, role: '' })).toBeNull();
    expect(decodeMemberCursor(token, { ...expected, limit: 50 })).toBeNull();
  });

  it('rejects a payload whose fields are out of shape even when the signature is good', () => {
    const signed = (c: object) => encodeSignedCursor('members', c);
    expect(decodeMemberCursor(signed({ ...cursor, rank: 3 }), expected)).toBeNull();
    expect(decodeMemberCursor(signed({ ...cursor, rank: 1.5 }), expected)).toBeNull();
    expect(decodeMemberCursor(signed({ ...cursor, joinedAt: 'not a date' }), expected)).toBeNull();
    expect(decodeMemberCursor(signed({ ...cursor, id: '' }), expected)).toBeNull();
    expect(decodeMemberCursor(signed({ ...cursor, limit: 101 }), { ...expected, limit: 101 })).toBeNull();
    expect(decodeMemberCursor(signed({ ...cursor, limit: 0 }), { ...expected, limit: 0 })).toBeNull();
    expect(decodeMemberCursor(signed([1, 2]), expected)).toBeNull();
  });

  it('a cursor signed under another listing\'s scope is not ours', () => {
    const borrowed = encodeSignedCursor('discovery', cursor);
    expect(decodeMemberCursor(borrowed, expected)).toBeNull();
    expect(decodeSignedCursor('discovery', borrowed)).toEqual(cursor);
    expect(decodeSignedCursor('members', borrowed)).toBeNull();
  });

  it('ranks owner before admins before everyone, and hashes a query without keeping its text', () => {
    expect([memberRoleRank('owner'), memberRoleRank('admin'), memberRoleRank('member'), memberRoleRank('anything')]).toEqual([0, 1, 2, 2]);
    expect(hashMemberQuery('')).toBe('');
    expect(hashMemberQuery('al')).toMatch(/^[0-9a-f]{40}$/);
    expect(hashMemberQuery('al')).not.toContain('al');
  });
});
