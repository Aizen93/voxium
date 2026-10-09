import { describe, it, expect } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

import { encodeDiscoveryCursor, decodeDiscoveryCursor, hashDiscoveryQuery } from '../../utils/discoveryCursor';

const EXPECT = { sort: 'active' as const, tag: 'gaming', q: hashDiscoveryQuery('voxium') };

describe('discovery cursors — signed, bound, bounded', () => {
  it('round-trips through encode/decode', () => {
    const token = encodeDiscoveryCursor({ ...EXPECT, id: 'srv-24', page: 2 });
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(decodeDiscoveryCursor(token, EXPECT)).toEqual({ ...EXPECT, id: 'srv-24', page: 2 });
  });

  it('rejects a tampered payload or signature', () => {
    const token = encodeDiscoveryCursor({ ...EXPECT, id: 'srv-24', page: 2 });
    const [payload, mac] = token.split('.');
    // edit the page inside the payload, keep the old signature
    const edited = Buffer.from(JSON.stringify({ ...EXPECT, id: 'srv-24', page: 3 })).toString('base64url');
    expect(decodeDiscoveryCursor(`${edited}.${mac}`, EXPECT)).toBeNull();
    // damage the signature
    const flipped = mac.endsWith('A') ? mac.slice(0, -1) + 'B' : mac.slice(0, -1) + 'A';
    expect(decodeDiscoveryCursor(`${payload}.${flipped}`, EXPECT)).toBeNull();
    // a signature of the wrong length never reaches timingSafeEqual
    expect(decodeDiscoveryCursor(`${payload}.${mac}x`, EXPECT)).toBeNull();
  });

  it('rejects a cursor issued for another sort, tag or query — it must not be borrowed across listings', () => {
    const token = encodeDiscoveryCursor({ ...EXPECT, id: 'srv-24', page: 2 });
    expect(decodeDiscoveryCursor(token, { ...EXPECT, sort: 'members' })).toBeNull();
    expect(decodeDiscoveryCursor(token, { ...EXPECT, tag: '' })).toBeNull();
    expect(decodeDiscoveryCursor(token, { ...EXPECT, q: '' })).toBeNull();
  });

  it('rejects malformed, oversized and structurally wrong tokens', () => {
    expect(decodeDiscoveryCursor('', EXPECT)).toBeNull();
    expect(decodeDiscoveryCursor('nodot', EXPECT)).toBeNull();
    expect(decodeDiscoveryCursor('.sig', EXPECT)).toBeNull();
    expect(decodeDiscoveryCursor('x'.repeat(600), EXPECT)).toBeNull();
    expect(decodeDiscoveryCursor(encodeDiscoveryCursor({ ...EXPECT, id: '', page: 2 }), EXPECT)).toBeNull();
    expect(decodeDiscoveryCursor(encodeDiscoveryCursor({ ...EXPECT, id: 'srv-1', page: 1 }), EXPECT)).toBeNull();
    expect(decodeDiscoveryCursor(encodeDiscoveryCursor({ ...EXPECT, id: 'srv-1', page: 2.5 }), EXPECT)).toBeNull();
    // a validly signed non-cursor JSON
    const junk = Buffer.from('"just a string"').toString('base64url');
    const signedJunk = encodeDiscoveryCursor({ ...EXPECT, id: 'srv-1', page: 2 }).split('.')[1];
    expect(decodeDiscoveryCursor(`${junk}.${signedJunk}`, EXPECT)).toBeNull();
  });

  it('hashes the query (sha1 hex) and never carries its text; the empty query hashes to the empty string', () => {
    expect(hashDiscoveryQuery('')).toBe('');
    expect(hashDiscoveryQuery('voxium')).toMatch(/^[0-9a-f]{40}$/);
    const token = encodeDiscoveryCursor({ ...EXPECT, id: 'srv-1', page: 2 });
    expect(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')).not.toContain('voxium');
  });
});
