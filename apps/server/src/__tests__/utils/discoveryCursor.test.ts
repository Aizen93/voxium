import { describe, it, expect } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

import { encodeDiscoveryCursor, decodeDiscoveryCursor, hashDiscoveryQuery } from '../../utils/discoveryCursor';

const EXPECT = { sort: 'active' as const, tag: 'gaming', q: hashDiscoveryQuery('voxium'), limit: 24 };
const CUR = { ...EXPECT, id: 'srv-24', key: 240, page: 2 };

describe('discovery cursors — signed, bound, bounded', () => {
  it('round-trips through encode/decode, sort key included', () => {
    const token = encodeDiscoveryCursor(CUR);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(decodeDiscoveryCursor(token, EXPECT)).toEqual(CUR);
    const named = { ...CUR, sort: 'name' as const, key: 'Lingua Lounge' };
    expect(decodeDiscoveryCursor(encodeDiscoveryCursor(named), { ...EXPECT, sort: 'name' })).toEqual(named);
    const newest = { ...CUR, sort: 'newest' as const, key: '2026-10-09T12:00:00.000Z' };
    expect(decodeDiscoveryCursor(encodeDiscoveryCursor(newest), { ...EXPECT, sort: 'newest' })).toEqual(newest);
  });

  it('rejects a tampered payload or signature', () => {
    const token = encodeDiscoveryCursor(CUR);
    const [payload, mac] = token.split('.');
    // edit the page inside the payload, keep the old signature
    const edited = Buffer.from(JSON.stringify({ ...CUR, page: 3 })).toString('base64url');
    expect(decodeDiscoveryCursor(`${edited}.${mac}`, EXPECT)).toBeNull();
    // damage the signature
    const flipped = mac.endsWith('A') ? mac.slice(0, -1) + 'B' : mac.slice(0, -1) + 'A';
    expect(decodeDiscoveryCursor(`${payload}.${flipped}`, EXPECT)).toBeNull();
    // a signature of the wrong length never reaches timingSafeEqual
    expect(decodeDiscoveryCursor(`${payload}.${mac}x`, EXPECT)).toBeNull();
  });

  it('a signature with the right CHARACTER length but a multi-byte character is refused, not a RangeError', () => {
    const token = encodeDiscoveryCursor(CUR);
    const [payload, mac] = token.split('.');
    const multibyte = 'é' + mac.slice(1); // same .length, one more byte
    expect(multibyte.length).toBe(mac.length);
    expect(() => decodeDiscoveryCursor(`${payload}.${multibyte}`, EXPECT)).not.toThrow();
    expect(decodeDiscoveryCursor(`${payload}.${multibyte}`, EXPECT)).toBeNull();
  });

  it('rejects a cursor issued for another sort, tag, query or page size — it must not be borrowed across listings', () => {
    const token = encodeDiscoveryCursor(CUR);
    expect(decodeDiscoveryCursor(token, { ...EXPECT, sort: 'members' })).toBeNull();
    expect(decodeDiscoveryCursor(token, { ...EXPECT, tag: '' })).toBeNull();
    expect(decodeDiscoveryCursor(token, { ...EXPECT, q: '' })).toBeNull();
    expect(decodeDiscoveryCursor(token, { ...EXPECT, limit: 48 })).toBeNull();
  });

  it('rejects malformed, oversized and structurally wrong tokens, including a key of the wrong type for the sort', () => {
    expect(decodeDiscoveryCursor('', EXPECT)).toBeNull();
    expect(decodeDiscoveryCursor('nodot', EXPECT)).toBeNull();
    expect(decodeDiscoveryCursor('.sig', EXPECT)).toBeNull();
    expect(decodeDiscoveryCursor('x'.repeat(600), EXPECT)).toBeNull();
    expect(decodeDiscoveryCursor(encodeDiscoveryCursor({ ...CUR, id: '' }), EXPECT)).toBeNull();
    expect(decodeDiscoveryCursor(encodeDiscoveryCursor({ ...CUR, page: 1 }), EXPECT)).toBeNull();
    expect(decodeDiscoveryCursor(encodeDiscoveryCursor({ ...CUR, page: 2.5 }), EXPECT)).toBeNull();
    expect(decodeDiscoveryCursor(encodeDiscoveryCursor({ ...CUR, limit: 0 }), { ...EXPECT, limit: 0 })).toBeNull();
    expect(decodeDiscoveryCursor(encodeDiscoveryCursor({ ...CUR, limit: 49 }), { ...EXPECT, limit: 49 })).toBeNull();
    // the key must be an integer for the score/count sorts, a date for newest, a string for name
    expect(decodeDiscoveryCursor(encodeDiscoveryCursor({ ...CUR, key: 'high' }), EXPECT)).toBeNull();
    expect(decodeDiscoveryCursor(encodeDiscoveryCursor({ ...CUR, key: 1.5 }), EXPECT)).toBeNull();
    expect(decodeDiscoveryCursor(encodeDiscoveryCursor({ ...CUR, sort: 'newest', key: 'not a date' }), { ...EXPECT, sort: 'newest' })).toBeNull();
    expect(decodeDiscoveryCursor(encodeDiscoveryCursor({ ...CUR, sort: 'name', key: 7 }), { ...EXPECT, sort: 'name' })).toBeNull();
    expect(decodeDiscoveryCursor(encodeDiscoveryCursor({ ...CUR, sort: 'name', key: 'x'.repeat(300) }), { ...EXPECT, sort: 'name' })).toBeNull();
    // a validly signed non-cursor JSON
    const junk = Buffer.from('"just a string"').toString('base64url');
    const signedJunk = encodeDiscoveryCursor(CUR).split('.')[1];
    expect(decodeDiscoveryCursor(`${junk}.${signedJunk}`, EXPECT)).toBeNull();
  });

  it('hashes the query (sha1 hex) and never carries its text; the empty query hashes to the empty string', () => {
    expect(hashDiscoveryQuery('')).toBe('');
    expect(hashDiscoveryQuery('voxium')).toMatch(/^[0-9a-f]{40}$/);
    const token = encodeDiscoveryCursor(CUR);
    expect(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')).not.toContain('voxium');
  });
});
