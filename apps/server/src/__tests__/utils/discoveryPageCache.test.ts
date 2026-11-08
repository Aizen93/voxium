import { describe, it, expect, vi, beforeEach } from 'vitest';

// The Explore page cache's generation: part of every page key, bumped by the
// writes that change a card or the listing, so the next open of Explore after
// a change recomputes instead of reading a page cached before it.

const redis = vi.hoisted(() => ({ get: vi.fn(), incr: vi.fn() }));
vi.mock('../../utils/redis', () => ({ getRedis: () => redis }));

import { discoveryPageGeneration, bumpDiscoveryPageCache, DISCOVERY_PAGE_GENERATION_KEY } from '../../utils/discoveryPageCache';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('discoveryPageGeneration', () => {
  it('reads the generation key and answers "0" before any bump', async () => {
    redis.get.mockResolvedValue(null);
    await expect(discoveryPageGeneration()).resolves.toBe('0');
    expect(redis.get).toHaveBeenCalledWith(DISCOVERY_PAGE_GENERATION_KEY);
    expect(DISCOVERY_PAGE_GENERATION_KEY).toBe('discovery:page:gen');
  });

  it('answers the stored generation as a string', async () => {
    redis.get.mockResolvedValue('17');
    await expect(discoveryPageGeneration()).resolves.toBe('17');
  });

  it('throws when Redis does not answer, so the route serves that request uncached', async () => {
    redis.get.mockRejectedValue(new Error('redis down'));
    await expect(discoveryPageGeneration()).rejects.toThrow('redis down');
  });
});

describe('bumpDiscoveryPageCache', () => {
  it('increments the generation (every page cached under the old one is now unreachable)', async () => {
    redis.incr.mockResolvedValue(18);
    await bumpDiscoveryPageCache('server update');
    expect(redis.incr).toHaveBeenCalledWith(DISCOVERY_PAGE_GENERATION_KEY);
  });

  it('never throws: a failed bump is logged with its reason and the 60 s TTL still bounds the staleness', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    redis.incr.mockRejectedValue(new Error('redis down'));

    await expect(bumpDiscoveryPageCache('admin discovery curation')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not invalidated after admin discovery curation'), 'redis down');
    warn.mockRestore();
  });
});
