import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock PrismaClient and PrismaPg with proper constructors
vi.mock('../../generated/prisma/client', () => ({
  PrismaClient: vi.fn(function (this: Record<string, unknown>) {
    this.$connect = vi.fn();
    this.$disconnect = vi.fn();
    this.$queryRaw = vi.fn();
    this.user = { findMany: vi.fn() };
  }),
}));

vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: vi.fn(function () {
    // no-op constructor
  }),
}));

describe('utils/prisma — lazy initialization', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('importing the module does NOT throw even with no DATABASE_URL set', async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    const mod = await import('../../utils/prisma');
    expect(mod.prisma).toBeDefined();

    if (saved !== undefined) process.env.DATABASE_URL = saved;
  });

  it('the exported prisma is a Proxy object (not a raw PrismaClient)', async () => {
    const mod = await import('../../utils/prisma');
    expect(mod.prisma).toBeDefined();
    expect(typeof mod.prisma).toBe('object');
  });

  it('PrismaClient is NOT instantiated at import time', async () => {
    const { PrismaClient } = await import('../../generated/prisma/client');
    vi.mocked(PrismaClient).mockClear();

    await import('../../utils/prisma');
    expect(PrismaClient).not.toHaveBeenCalled();
  });

  it('PrismaClient IS instantiated on first property access through the proxy', async () => {
    const { PrismaClient } = await import('../../generated/prisma/client');
    vi.mocked(PrismaClient).mockClear();

    const mod = await import('../../utils/prisma');
    void mod.prisma.user;
    expect(PrismaClient).toHaveBeenCalledTimes(1);
  });

  it('PrismaClient is only instantiated once (singleton)', async () => {
    const { PrismaClient } = await import('../../generated/prisma/client');
    vi.mocked(PrismaClient).mockClear();

    const mod = await import('../../utils/prisma');
    void mod.prisma.user;
    void mod.prisma.$connect;
    void mod.prisma.$disconnect;
    expect(PrismaClient).toHaveBeenCalledTimes(1);
  });
});

describe('utils/prisma — the pool size reaches the adapter', () => {
  const saved = {
    url: process.env.DATABASE_URL,
    max: process.env.DATABASE_POOL_MAX,
    idle: process.env.DATABASE_POOL_IDLE_TIMEOUT_MS,
    connect: process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
  };

  beforeEach(() => {
    vi.resetModules();
    process.env.DATABASE_URL = 'postgresql://u:p@db.invalid:5432/voxium';
    delete process.env.DATABASE_POOL_IDLE_TIMEOUT_MS;
    delete process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS;
  });

  afterEach(() => {
    for (const [name, value] of [
      ['DATABASE_URL', saved.url],
      ['DATABASE_POOL_MAX', saved.max],
      ['DATABASE_POOL_IDLE_TIMEOUT_MS', saved.idle],
      ['DATABASE_POOL_CONNECTION_TIMEOUT_MS', saved.connect],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.restoreAllMocks();
  });

  async function adapterOptions(): Promise<unknown> {
    const { PrismaPg } = await import('@prisma/adapter-pg');
    vi.mocked(PrismaPg).mockClear();
    const mod = await import('../../utils/prisma');
    void mod.prisma.user;
    expect(PrismaPg).toHaveBeenCalledTimes(1);
    return vi.mocked(PrismaPg).mock.calls[0][0];
  }

  it('passes DATABASE_POOL_MAX as the pool\'s max, next to the connection string', async () => {
    process.env.DATABASE_POOL_MAX = '25';
    expect(await adapterOptions()).toEqual({ connectionString: 'postgresql://u:p@db.invalid:5432/voxium', max: 25 });
  });

  it('passes the default of 10 when the setting is unset', async () => {
    delete process.env.DATABASE_POOL_MAX;
    expect(await adapterOptions()).toEqual({ connectionString: 'postgresql://u:p@db.invalid:5432/voxium', max: 10 });
  });

  it('passes the default of 10, with one warning, for a value it cannot use', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.DATABASE_POOL_MAX = 'many';
    expect(await adapterOptions()).toEqual({ connectionString: 'postgresql://u:p@db.invalid:5432/voxium', max: 10 });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('passes the two timeouts as the pool own options, and nothing when they are unset', async () => {
    process.env.DATABASE_POOL_MAX = '25';
    process.env.DATABASE_POOL_IDLE_TIMEOUT_MS = '30000';
    process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS = '5000';
    expect(await adapterOptions()).toEqual({
      connectionString: 'postgresql://u:p@db.invalid:5432/voxium',
      max: 25,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  });

  it('leaves both timeout options out of the adapter options when they are unset or unusable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.DATABASE_POOL_IDLE_TIMEOUT_MS = 'soon';
    const options = (await adapterOptions()) as Record<string, unknown>;
    expect(Object.keys(options).sort()).toEqual(['connectionString', 'max']);
  });
});

describe('databasePoolMax', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('reads 10, node-postgres\'s own default, when the setting is unset or empty', async () => {
    const { databasePoolMax, DEFAULT_DATABASE_POOL_MAX } = await import('../../utils/prisma');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(DEFAULT_DATABASE_POOL_MAX).toBe(10);
    for (const raw of [undefined, '', '   ']) expect(databasePoolMax(raw), String(raw)).toBe(10);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads a whole number from 1 to 1000, surrounding blanks allowed', async () => {
    const { databasePoolMax, MAX_DATABASE_POOL_MAX } = await import('../../utils/prisma');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(MAX_DATABASE_POOL_MAX).toBe(1000);
    expect(databasePoolMax('1')).toBe(1);
    expect(databasePoolMax('25')).toBe(25);
    expect(databasePoolMax(' 40 ')).toBe(40);
    expect(databasePoolMax('1000')).toBe(1000);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['0', '1001', '10000', '-5', '2.5', '1e1', '0x10', '+20', '20 connections', 'ten'])(
    'reads 10 for %j, with a warning naming the setting and the rule',
    async (raw) => {
      const { databasePoolMax } = await import('../../utils/prisma');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(databasePoolMax(raw)).toBe(10);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('DATABASE_POOL_MAX');
      expect(warn.mock.calls[0][0]).toContain('1-1000');
    },
  );

  it('never prints the value of an unusable setting', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await import('../../utils/prisma');
    mod.databasePoolMax('s3cr3t-pasted-by-mistake');
    mod.databasePoolIdleTimeoutMs('s3cr3t-pasted-by-mistake');
    mod.databasePoolConnectionTimeoutMs('s3cr3t-pasted-by-mistake');
    expect(warn).toHaveBeenCalledTimes(3);
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain('s3cr3t');
  });
});

describe('the pool timeouts', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([
    ['databasePoolIdleTimeoutMs', 'DATABASE_POOL_IDLE_TIMEOUT_MS', 3_600_000],
    ['databasePoolConnectionTimeoutMs', 'DATABASE_POOL_CONNECTION_TIMEOUT_MS', 600_000],
  ] as const)('%s reads undefined (the pool default) when unset or empty', async (fn, _name, _max) => {
    const mod = await import('../../utils/prisma');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const raw of [undefined, '', '  ']) expect(mod[fn](raw), String(raw)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['databasePoolIdleTimeoutMs', 3_600_000],
    ['databasePoolConnectionTimeoutMs', 600_000],
  ] as const)('%s reads a whole number from 0 to its largest value', async (fn, largest) => {
    const mod = await import('../../utils/prisma');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mod[fn]('0')).toBe(0);
    expect(mod[fn](' 2500 ')).toBe(2500);
    expect(mod[fn](String(largest))).toBe(largest);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['databasePoolIdleTimeoutMs', 'DATABASE_POOL_IDLE_TIMEOUT_MS', '3600001'],
    ['databasePoolConnectionTimeoutMs', 'DATABASE_POOL_CONNECTION_TIMEOUT_MS', '600001'],
  ] as const)('%s reads undefined for a value out of range, with one warning naming the setting', async (fn, name, tooBig) => {
    const mod = await import('../../utils/prisma');
    for (const raw of [tooBig, '-1', '1.5', '1e3', '0x10', '+5', '5s', 'soon']) {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(mod[fn](raw), raw).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(name);
      expect(warn.mock.calls[0][0]).toContain('whole number 0-');
      warn.mockRestore();
    }
  });
});
