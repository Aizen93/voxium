import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { THEME_COLOR_KEYS } from '@voxium/shared';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', username: 'alice', role: 'user', tokenVersion: 0, emailVerified: true };
    next();
  },
  requireVerifiedEmail: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../middleware/requireSuperAdmin', () => ({
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  requireSuperAdmin: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../middleware/rateLimiter', () => ({
  rateLimitThemeManage: (_req: any, _res: any, next: any) => next(),
  rateLimitThemeBrowse: (_req: any, _res: any, next: any) => next(),
  rateLimitGeneral: (_req: any, _res: any, next: any) => next(),
}));

const mockEmit = vi.fn();
const mockTo = vi.fn().mockReturnValue({ emit: mockEmit });

vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({
    emit: mockEmit,
    to: mockTo,
  })),
}));

const prismaMock: Record<string, any> = {
  communityTheme: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  },
};

vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, {
    get(_target, prop) {
      return prismaMock[prop as string];
    },
  }),
}));

vi.mock('../../utils/sanitize', () => ({
  sanitizeText: (text: string) => text,
}));

// ─── Setup ──────────────────────────────────────────────────────────────────

import { themeRouter } from '../../routes/themes';
import { errorHandler } from '../../middleware/errorHandler';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/themes', themeRouter);
  app.use(errorHandler);
  return app;
}

function makeValidColors(): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const key of THEME_COLOR_KEYS) {
    if (key === 'selection-bg') {
      colors[key] = 'rgba(91, 91, 247, 0.3)';
    } else if (key === 'selection-text') {
      colors[key] = '#e4e6eb';
    } else {
      colors[key] = '#1a1a2e';
    }
  }
  return colors;
}

function makeThemeRow(overrides: Record<string, any> = {}) {
  return {
    id: 'theme-1',
    name: 'Test Theme',
    description: 'A test theme',
    tags: ['dark', 'cool'],
    colors: makeValidColors(),
    patterns: null,
    version: 1,
    status: 'draft',
    installCount: 0,
    authorId: 'user-1',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    author: { username: 'alice', displayName: 'Alice' },
    ...overrides,
  };
}

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  vi.clearAllMocks();
  app = createApp();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Themes API', () => {
  // ─── GET / (Browse) ─────────────────────────────────────────────────────

  describe('GET /api/v1/themes', () => {
    it('returns paginated published themes', async () => {
      const themes = [makeThemeRow({ status: 'published' })];
      prismaMock.communityTheme.findMany.mockResolvedValue(themes);
      prismaMock.communityTheme.count.mockResolvedValue(1);

      const res = await request(app).get('/api/v1/themes');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.total).toBe(1);
      expect(res.body.hasMore).toBe(false);
    });

    it('filters by search term', async () => {
      prismaMock.communityTheme.findMany.mockResolvedValue([]);
      prismaMock.communityTheme.count.mockResolvedValue(0);

      await request(app).get('/api/v1/themes?search=neon');

      expect(prismaMock.communityTheme.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'published',
            name: { contains: 'neon', mode: 'insensitive' },
          }),
        }),
      );
    });

    it('filters by tag', async () => {
      prismaMock.communityTheme.findMany.mockResolvedValue([]);
      prismaMock.communityTheme.count.mockResolvedValue(0);

      await request(app).get('/api/v1/themes?tag=dark');

      expect(prismaMock.communityTheme.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'published',
            tags: { has: 'dark' },
          }),
        }),
      );
    });

    it('sorts by popular', async () => {
      prismaMock.communityTheme.findMany.mockResolvedValue([]);
      prismaMock.communityTheme.count.mockResolvedValue(0);

      await request(app).get('/api/v1/themes?sort=popular');

      expect(prismaMock.communityTheme.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { installCount: 'desc' },
        }),
      );
    });

    it('sorts by name', async () => {
      prismaMock.communityTheme.findMany.mockResolvedValue([]);
      prismaMock.communityTheme.count.mockResolvedValue(0);

      await request(app).get('/api/v1/themes?sort=name');

      expect(prismaMock.communityTheme.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { name: 'asc' },
        }),
      );
    });

    it('defaults to newest sort', async () => {
      prismaMock.communityTheme.findMany.mockResolvedValue([]);
      prismaMock.communityTheme.count.mockResolvedValue(0);

      await request(app).get('/api/v1/themes');

      expect(prismaMock.communityTheme.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { createdAt: 'desc' },
        }),
      );
    });

    it('respects pagination', async () => {
      prismaMock.communityTheme.findMany.mockResolvedValue([]);
      prismaMock.communityTheme.count.mockResolvedValue(50);

      const res = await request(app).get('/api/v1/themes?page=2&limit=10');

      expect(res.body.hasMore).toBe(true);
      expect(prismaMock.communityTheme.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 10,
          take: 10,
        }),
      );
    });
  });

  // ─── GET /mine ──────────────────────────────────────────────────────────

  describe('GET /api/v1/themes/mine', () => {
    it('returns all themes for current user', async () => {
      const themes = [makeThemeRow(), makeThemeRow({ id: 'theme-2', status: 'published' })];
      prismaMock.communityTheme.findMany.mockResolvedValue(themes);

      const res = await request(app).get('/api/v1/themes/mine');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(prismaMock.communityTheme.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { authorId: 'user-1' },
        }),
      );
    });
  });

  // ─── GET /:themeId ──────────────────────────────────────────────────────

  describe('GET /api/v1/themes/:themeId', () => {
    it('returns a published theme', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(makeThemeRow({ status: 'published' }));

      const res = await request(app).get('/api/v1/themes/theme-1');

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe('theme-1');
    });

    it('returns own draft theme', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(makeThemeRow({ status: 'draft', authorId: 'user-1' }));

      const res = await request(app).get('/api/v1/themes/theme-1');

      expect(res.status).toBe(200);
    });

    it('returns 404 for non-published theme by other user', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(makeThemeRow({ status: 'draft', authorId: 'user-2' }));

      const res = await request(app).get('/api/v1/themes/theme-1');

      expect(res.status).toBe(404);
    });

    it('returns 404 for non-existent theme', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(null);

      const res = await request(app).get('/api/v1/themes/nonexistent');

      expect(res.status).toBe(404);
    });
  });

  // ─── POST / (Create) ───────────────────────────────────────────────────

  describe('POST /api/v1/themes', () => {
    it('creates a theme successfully', async () => {
      prismaMock.communityTheme.count.mockResolvedValue(0);
      prismaMock.communityTheme.create.mockResolvedValue(makeThemeRow());

      const res = await request(app)
        .post('/api/v1/themes')
        .send({ name: 'Test Theme', description: 'A test theme', tags: ['dark'], colors: makeValidColors() });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Test Theme');
    });

    it('rejects missing name', async () => {
      const res = await request(app)
        .post('/api/v1/themes')
        .send({ colors: makeValidColors() });

      expect(res.status).toBe(400);
    });

    it('rejects name too short', async () => {
      const res = await request(app)
        .post('/api/v1/themes')
        .send({ name: 'A', colors: makeValidColors() });

      expect(res.status).toBe(400);
    });

    it('rejects name too long', async () => {
      const res = await request(app)
        .post('/api/v1/themes')
        .send({ name: 'A'.repeat(51), colors: makeValidColors() });

      expect(res.status).toBe(400);
    });

    it('rejects description too long', async () => {
      const res = await request(app)
        .post('/api/v1/themes')
        .send({ name: 'Test', description: 'A'.repeat(501), colors: makeValidColors() });

      expect(res.status).toBe(400);
    });

    it('rejects too many tags', async () => {
      const res = await request(app)
        .post('/api/v1/themes')
        .send({ name: 'Test', tags: ['a', 'b', 'c', 'd', 'e', 'f'], colors: makeValidColors() });

      expect(res.status).toBe(400);
    });

    it('rejects invalid tag characters', async () => {
      const res = await request(app)
        .post('/api/v1/themes')
        .send({ name: 'Test', tags: ['<script>alert(1)</script>'], colors: makeValidColors() });

      expect(res.status).toBe(400);
    });

    it('rejects missing colors', async () => {
      const res = await request(app)
        .post('/api/v1/themes')
        .send({ name: 'Test' });

      expect(res.status).toBe(400);
    });

    it('rejects invalid color values', async () => {
      const colors = makeValidColors();
      colors['bg-primary'] = 'not-a-color';

      const res = await request(app)
        .post('/api/v1/themes')
        .send({ name: 'Test', colors });

      expect(res.status).toBe(400);
    });

    it('rejects incomplete colors (missing keys)', async () => {
      const colors = makeValidColors();
      delete (colors as any)['bg-primary'];

      const res = await request(app)
        .post('/api/v1/themes')
        .send({ name: 'Test', colors });

      expect(res.status).toBe(400);
    });

    it('rejects when user has too many themes', async () => {
      prismaMock.communityTheme.count.mockResolvedValue(10);

      const res = await request(app)
        .post('/api/v1/themes')
        .send({ name: 'Test', colors: makeValidColors() });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('maximum');
    });

    it('creates theme without optional fields', async () => {
      prismaMock.communityTheme.count.mockResolvedValue(0);
      prismaMock.communityTheme.create.mockResolvedValue(makeThemeRow({ description: '', tags: [] }));

      const res = await request(app)
        .post('/api/v1/themes')
        .send({ name: 'Test', colors: makeValidColors() });

      expect(res.status).toBe(201);
    });
  });

  // ─── PATCH /:themeId (Update) ───────────────────────────────────────────

  describe('PATCH /api/v1/themes/:themeId', () => {
    it('updates name', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(makeThemeRow());
      prismaMock.communityTheme.update.mockResolvedValue(makeThemeRow({ name: 'New Name' }));

      const res = await request(app)
        .patch('/api/v1/themes/theme-1')
        .send({ name: 'New Name' });

      expect(res.status).toBe(200);
      expect(prismaMock.communityTheme.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ name: 'New Name' }),
        }),
      );
    });

    it('updates colors', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(makeThemeRow());
      const newColors = makeValidColors();
      newColors['bg-primary'] = '#ff0000';
      prismaMock.communityTheme.update.mockResolvedValue(makeThemeRow({ colors: newColors }));

      const res = await request(app)
        .patch('/api/v1/themes/theme-1')
        .send({ colors: newColors });

      expect(res.status).toBe(200);
    });

    it('rejects update by non-owner', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(makeThemeRow({ authorId: 'user-2' }));

      const res = await request(app)
        .patch('/api/v1/themes/theme-1')
        .send({ name: 'Hijacked' });

      expect(res.status).toBe(403);
    });

    it('returns 404 for non-existent theme', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .patch('/api/v1/themes/nonexistent')
        .send({ name: 'New' });

      expect(res.status).toBe(404);
    });

    it('emits socket event when updating published theme', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(makeThemeRow({ status: 'published' }));
      prismaMock.communityTheme.update.mockResolvedValue(makeThemeRow({ status: 'published', name: 'Updated' }));

      await request(app)
        .patch('/api/v1/themes/theme-1')
        .send({ name: 'Updated' });

      expect(mockEmit).toHaveBeenCalledWith('theme:updated', expect.objectContaining({ name: 'Updated' }));
    });

    it('does not emit socket event when updating draft theme', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(makeThemeRow({ status: 'draft' }));
      prismaMock.communityTheme.update.mockResolvedValue(makeThemeRow({ status: 'draft', name: 'Updated' }));

      await request(app)
        .patch('/api/v1/themes/theme-1')
        .send({ name: 'Updated' });

      expect(mockEmit).not.toHaveBeenCalled();
    });
  });

  // ─── DELETE /:themeId ───────────────────────────────────────────────────

  describe('DELETE /api/v1/themes/:themeId', () => {
    it('deletes own theme', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(makeThemeRow());
      prismaMock.communityTheme.delete.mockResolvedValue(makeThemeRow());

      const res = await request(app).delete('/api/v1/themes/theme-1');

      expect(res.status).toBe(200);
      expect(prismaMock.communityTheme.delete).toHaveBeenCalledWith({ where: { id: 'theme-1' } });
    });

    it('rejects delete by non-owner', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(makeThemeRow({ authorId: 'user-2' }));

      const res = await request(app).delete('/api/v1/themes/theme-1');

      expect(res.status).toBe(403);
    });

    it('emits theme:removed when deleting published theme', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(makeThemeRow({ status: 'published' }));
      prismaMock.communityTheme.delete.mockResolvedValue(makeThemeRow());

      await request(app).delete('/api/v1/themes/theme-1');

      expect(mockEmit).toHaveBeenCalledWith('theme:removed', { themeId: 'theme-1' });
    });

    it('does not emit when deleting draft theme', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(makeThemeRow({ status: 'draft' }));
      prismaMock.communityTheme.delete.mockResolvedValue(makeThemeRow());

      await request(app).delete('/api/v1/themes/theme-1');

      expect(mockEmit).not.toHaveBeenCalled();
    });
  });

  // ─── POST /:themeId/publish ─────────────────────────────────────────────

  describe('POST /api/v1/themes/:themeId/publish', () => {
    it('publishes a draft theme', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(makeThemeRow({ status: 'draft' }));
      prismaMock.communityTheme.update.mockResolvedValue(makeThemeRow({ status: 'published' }));

      const res = await request(app).post('/api/v1/themes/theme-1/publish');

      expect(res.status).toBe(200);
      expect(mockEmit).toHaveBeenCalledWith('theme:published', expect.objectContaining({ id: 'theme-1' }));
    });

    it('rejects publishing already published theme', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(makeThemeRow({ status: 'published' }));

      const res = await request(app).post('/api/v1/themes/theme-1/publish');

      expect(res.status).toBe(400);
    });

    it('rejects publishing removed theme', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(makeThemeRow({ status: 'removed' }));

      const res = await request(app).post('/api/v1/themes/theme-1/publish');

      expect(res.status).toBe(403);
    });

    it('rejects publish by non-owner', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(makeThemeRow({ status: 'draft', authorId: 'user-2' }));

      const res = await request(app).post('/api/v1/themes/theme-1/publish');

      expect(res.status).toBe(403);
    });
  });

  // ─── POST /:themeId/unpublish ───────────────────────────────────────────

  describe('POST /api/v1/themes/:themeId/unpublish', () => {
    it('unpublishes a published theme', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(makeThemeRow({ status: 'published' }));
      prismaMock.communityTheme.update.mockResolvedValue(makeThemeRow({ status: 'draft' }));

      const res = await request(app).post('/api/v1/themes/theme-1/unpublish');

      expect(res.status).toBe(200);
      expect(mockEmit).toHaveBeenCalledWith('theme:removed', { themeId: 'theme-1' });
    });

    it('rejects unpublishing non-published theme', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(makeThemeRow({ status: 'draft' }));

      const res = await request(app).post('/api/v1/themes/theme-1/unpublish');

      expect(res.status).toBe(400);
    });
  });

  // ─── POST /:themeId/install ─────────────────────────────────────────────

  describe('POST /api/v1/themes/:themeId/install', () => {
    it('increments install count', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue({ id: 'theme-1', status: 'published' });
      prismaMock.communityTheme.update.mockResolvedValue({});

      const res = await request(app).post('/api/v1/themes/theme-1/install');

      expect(res.status).toBe(200);
      expect(prismaMock.communityTheme.update).toHaveBeenCalledWith({
        where: { id: 'theme-1' },
        data: { installCount: { increment: 1 } },
      });
    });

    it('rejects install of non-published theme', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue({ id: 'theme-1', status: 'draft' });

      const res = await request(app).post('/api/v1/themes/theme-1/install');

      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent theme', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(null);

      const res = await request(app).post('/api/v1/themes/nonexistent/install');

      expect(res.status).toBe(404);
    });
  });

  // ─── POST /:themeId/uninstall ───────────────────────────────────────────

  describe('POST /api/v1/themes/:themeId/uninstall', () => {
    it('decrements install count', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue({ id: 'theme-1', status: 'published', installCount: 5 });
      prismaMock.communityTheme.updateMany.mockResolvedValue({ count: 1 });

      const res = await request(app).post('/api/v1/themes/theme-1/uninstall');

      expect(res.status).toBe(200);
      expect(prismaMock.communityTheme.updateMany).toHaveBeenCalledWith({
        where: { id: 'theme-1', installCount: { gt: 0 } },
        data: { installCount: { decrement: 1 } },
      });
    });

    it('does not decrement below zero', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue({ id: 'theme-1', status: 'published', installCount: 0 });

      const res = await request(app).post('/api/v1/themes/theme-1/uninstall');

      expect(res.status).toBe(200);
      expect(prismaMock.communityTheme.update).not.toHaveBeenCalled();
    });
  });

  // ─── POST /:themeId/remove (Admin) ──────────────────────────────────────

  describe('POST /api/v1/themes/:themeId/remove', () => {
    it('admin removes a theme', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(makeThemeRow({ status: 'published' }));
      prismaMock.communityTheme.update.mockResolvedValue(makeThemeRow({ status: 'removed' }));

      const res = await request(app).post('/api/v1/themes/theme-1/remove');

      expect(res.status).toBe(200);
      expect(prismaMock.communityTheme.update).toHaveBeenCalledWith({
        where: { id: 'theme-1' },
        data: { status: 'removed' },
      });
      expect(mockEmit).toHaveBeenCalledWith('theme:removed', { themeId: 'theme-1' });
    });

    it('returns 404 for non-existent theme', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(null);

      const res = await request(app).post('/api/v1/themes/nonexistent/remove');

      expect(res.status).toBe(404);
    });
  });

  // ─── Response format ───────────────────────────────────────────────────

  describe('Response format', () => {
    it('includes all expected fields in theme response', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(makeThemeRow({ status: 'published' }));

      const res = await request(app).get('/api/v1/themes/theme-1');

      const theme = res.body.data;
      expect(theme).toHaveProperty('id');
      expect(theme).toHaveProperty('name');
      expect(theme).toHaveProperty('description');
      expect(theme).toHaveProperty('tags');
      expect(theme).toHaveProperty('colors');
      expect(theme).toHaveProperty('version');
      expect(theme).toHaveProperty('status');
      expect(theme).toHaveProperty('installCount');
      expect(theme).toHaveProperty('authorId');
      expect(theme).toHaveProperty('authorUsername');
      expect(theme).toHaveProperty('authorDisplayName');
      expect(theme).toHaveProperty('createdAt');
      expect(theme).toHaveProperty('updatedAt');
    });

    it('serializes dates as ISO strings', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(makeThemeRow({ status: 'published' }));

      const res = await request(app).get('/api/v1/themes/theme-1');

      expect(res.body.data.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(res.body.data.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    });
  });

  // ─── Patterns validation ──────────────────────────────────────────────

  describe('Patterns validation', () => {
    it('creates theme with valid patterns', async () => {
      prismaMock.communityTheme.count.mockResolvedValue(0);
      prismaMock.communityTheme.create.mockResolvedValue(makeThemeRow({
        patterns: { sidebar: { type: 'stripes', color: '#ff0000', opacity: 0.05, size: 20, angle: -45 } },
      }));

      const res = await request(app)
        .post('/api/v1/themes')
        .send({
          name: 'Test',
          colors: makeValidColors(),
          patterns: { sidebar: { type: 'stripes', color: '#ff0000', opacity: 0.05, size: 20, angle: -45 } },
        });

      expect(res.status).toBe(201);
    });

    it('creates theme without patterns', async () => {
      prismaMock.communityTheme.count.mockResolvedValue(0);
      prismaMock.communityTheme.create.mockResolvedValue(makeThemeRow());

      const res = await request(app)
        .post('/api/v1/themes')
        .send({ name: 'Test', colors: makeValidColors() });

      expect(res.status).toBe(201);
    });

    it('rejects invalid pattern type', async () => {
      const res = await request(app)
        .post('/api/v1/themes')
        .send({
          name: 'Test',
          colors: makeValidColors(),
          patterns: { sidebar: { type: 'invalid', color: '#ff0000', opacity: 0.05 } },
        });

      expect(res.status).toBe(400);
    });

    it('rejects invalid pattern area', async () => {
      const res = await request(app)
        .post('/api/v1/themes')
        .send({
          name: 'Test',
          colors: makeValidColors(),
          patterns: { footer: { type: 'stripes', color: '#ff0000', opacity: 0.05 } },
        });

      expect(res.status).toBe(400);
    });

    it('rejects opacity out of range', async () => {
      const res = await request(app)
        .post('/api/v1/themes')
        .send({
          name: 'Test',
          colors: makeValidColors(),
          patterns: { sidebar: { type: 'stripes', color: '#ff0000', opacity: 1.5 } },
        });

      expect(res.status).toBe(400);
    });

    it('rejects custom-svg without svgData', async () => {
      const res = await request(app)
        .post('/api/v1/themes')
        .send({
          name: 'Test',
          colors: makeValidColors(),
          patterns: { chat: { type: 'custom-svg', color: '#ff0000', opacity: 0.05 } },
        });

      expect(res.status).toBe(400);
    });

    it('rejects oversized SVG data', async () => {
      const res = await request(app)
        .post('/api/v1/themes')
        .send({
          name: 'Test',
          colors: makeValidColors(),
          patterns: { chat: { type: 'custom-svg', color: '#ff0000', opacity: 0.05, svgData: '<svg>' + 'x'.repeat(11000) + '</svg>' } },
        });

      expect(res.status).toBe(400);
    });

    it('rejects SVG with script tags', async () => {
      const res = await request(app)
        .post('/api/v1/themes')
        .send({
          name: 'Test',
          colors: makeValidColors(),
          patterns: { chat: { type: 'custom-svg', color: '#ff0000', opacity: 0.05, svgData: '<svg><script>alert(1)</script></svg>' } },
        });

      expect(res.status).toBe(400);
    });

    it('accepts valid custom SVG', async () => {
      prismaMock.communityTheme.count.mockResolvedValue(0);
      prismaMock.communityTheme.create.mockResolvedValue(makeThemeRow());

      const res = await request(app)
        .post('/api/v1/themes')
        .send({
          name: 'Test',
          colors: makeValidColors(),
          patterns: { chat: { type: 'custom-svg', color: '#ff0000', opacity: 0.04, svgData: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10L90 90"/></svg>' } },
        });

      expect(res.status).toBe(201);
    });

    it('updates patterns on existing theme', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(makeThemeRow());
      prismaMock.communityTheme.update.mockResolvedValue(makeThemeRow({
        patterns: { sidebar: { type: 'grid', color: '#00ff00', opacity: 0.02 } },
      }));

      const res = await request(app)
        .patch('/api/v1/themes/theme-1')
        .send({ patterns: { sidebar: { type: 'grid', color: '#00ff00', opacity: 0.02 } } });

      expect(res.status).toBe(200);
    });

    it('clears patterns with null', async () => {
      prismaMock.communityTheme.findUnique.mockResolvedValue(makeThemeRow({
        patterns: { sidebar: { type: 'stripes', color: '#ff0000', opacity: 0.05 } },
      }));
      prismaMock.communityTheme.update.mockResolvedValue(makeThemeRow({ patterns: null }));

      const res = await request(app)
        .patch('/api/v1/themes/theme-1')
        .send({ patterns: null });

      expect(res.status).toBe(200);
    });
  });
});
