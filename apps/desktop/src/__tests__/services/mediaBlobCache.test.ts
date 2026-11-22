import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCachedMedia,
  rememberMedia,
  resetMediaCache,
  MEDIA_CACHE_MAX_ENTRIES,
  MEDIA_CACHE_MAX_BYTES,
} from '../../services/mediaBlobCache';

const small = () => new Blob(['x']);

describe('mediaBlobCache', () => {
  beforeEach(resetMediaCache);

  it('evicts the least recently used entry past the entry bound', () => {
    for (let i = 0; i < MEDIA_CACHE_MAX_ENTRIES + 1; i++) rememberMedia(`k${i}`, small());
    expect(getCachedMedia('k0')).toBeNull();
    expect(getCachedMedia('k1')).not.toBeNull();
    expect(getCachedMedia(`k${MEDIA_CACHE_MAX_ENTRIES}`)).not.toBeNull();
  });

  it('does not evict an entry that was just read', () => {
    for (let i = 0; i < MEDIA_CACHE_MAX_ENTRIES; i++) rememberMedia(`k${i}`, small());
    expect(getCachedMedia('k0')).not.toBeNull();
    rememberMedia('extra', small());
    expect(getCachedMedia('k0')).not.toBeNull();
    expect(getCachedMedia('k1')).toBeNull();
  });

  it('does not cache a blob over the size bound', () => {
    rememberMedia('kept', small());
    rememberMedia('big', { size: MEDIA_CACHE_MAX_BYTES + 1 } as Blob);
    expect(getCachedMedia('big')).toBeNull();
    // An oversize blob is refused outright: it does not push others out
    expect(getCachedMedia('kept')).not.toBeNull();
  });

  it('evicts by total bytes', () => {
    const half = { size: MEDIA_CACHE_MAX_BYTES / 2 + 1 } as Blob;
    rememberMedia('a', half);
    rememberMedia('b', half);
    expect(getCachedMedia('a')).toBeNull();
    expect(getCachedMedia('b')).not.toBeNull();
  });

  it('is emptied by resetMediaCache', () => {
    rememberMedia('a', small());
    resetMediaCache();
    expect(getCachedMedia('a')).toBeNull();
  });
});
