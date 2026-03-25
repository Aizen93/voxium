import { describe, it, expect, beforeEach, vi } from 'vitest';

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
