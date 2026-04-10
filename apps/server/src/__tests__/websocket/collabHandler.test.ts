import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../utils/permissionCalculator', () => ({
  hasChannelPermission: vi.fn().mockResolvedValue(true),
  hasServerPermission: vi.fn().mockResolvedValue(true),
}));

const prismaMock: Record<string, any> = {
  channel: { findUnique: vi.fn() },
  channelDocument: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
};

vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, {
    get(_t, p) { return prismaMock[p as string]; },
  }),
}));

vi.mock('../../middleware/rateLimiter', () => ({
  socketRateLimit: vi.fn().mockReturnValue(true),
}));

import { handleCollabEvents, collabDocs, canvasSnapshots, shutdownCollab } from '../../websocket/collabHandler';
import { hasChannelPermission } from '../../utils/permissionCalculator';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockSocket() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const rooms = new Set<string>();
  const emitted: Array<{ event: string; data: any }> = [];

  return {
    data: { userId: 'user-1', username: 'testuser' },
    rooms,
    on: (event: string, handler: (...args: any[]) => any) => {
      handlers.set(event, handler);
    },
    join: vi.fn((room: string) => rooms.add(room)),
    leave: vi.fn((room: string) => rooms.delete(room)),
    emit: vi.fn((event: string, data: any) => {
      emitted.push({ event, data });
    }),
    to: vi.fn(() => ({
      emit: vi.fn((event: string, data: any) => {
        emitted.push({ event: `to:${event}`, data });
      }),
    })),
    // Test helpers
    _handlers: handlers,
    _emitted: emitted,
    trigger: async (event: string, ...args: any[]) => {
      const handler = handlers.get(event);
      if (handler) await handler(...args);
    },
  };
}

function createMockIO() {
  return {
    in: vi.fn(() => ({
      fetchSockets: vi.fn().mockResolvedValue([]),
    })),
    to: vi.fn(() => ({
      emit: vi.fn(),
    })),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Collab Handler', () => {
  let mockSocket: ReturnType<typeof createMockSocket>;
  let mockIO: ReturnType<typeof createMockIO>;

  beforeEach(() => {
    vi.clearAllMocks();
    collabDocs.clear();
    canvasSnapshots.clear();
    mockSocket = createMockSocket();
    mockIO = createMockIO();
    handleCollabEvents(mockIO as any, mockSocket as any);
  });

  afterEach(async () => {
    await shutdownCollab();
  });

  describe('collab:join', () => {
    it('joins a canvas channel and receives initial sync', async () => {
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-1', type: 'canvas', serverId: 'srv-1',
      });
      prismaMock.channelDocument.findUnique.mockResolvedValue(null);

      await mockSocket.trigger('collab:join', 'ch-1');

      expect(mockSocket.join).toHaveBeenCalledWith('collab:ch-1');
      expect(mockSocket.emit).toHaveBeenCalledWith('collab:sync', expect.objectContaining({
        channelId: 'ch-1',
        update: expect.any(String), // base64 encoded tldraw snapshot
      }));
      // Canvas snapshot should be cached (not Yjs doc)
      expect(canvasSnapshots.has('ch-1')).toBe(true);
    });

    it('joins a code channel', async () => {
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-2', type: 'code', serverId: 'srv-1',
      });
      prismaMock.channelDocument.findUnique.mockResolvedValue(null);

      await mockSocket.trigger('collab:join', 'ch-2');

      expect(mockSocket.join).toHaveBeenCalledWith('collab:ch-2');
      expect(collabDocs.has('ch-2')).toBe(true);
    });

    it('loads existing snapshot from DB', async () => {
      const doc = new Y.Doc();
      const text = doc.getText('content');
      text.insert(0, 'Hello World');
      const snapshot = Buffer.from(Y.encodeStateAsUpdate(doc));
      doc.destroy();

      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-3', type: 'code', serverId: 'srv-1',
      });
      prismaMock.channelDocument.findUnique.mockResolvedValue({
        channelId: 'ch-3', snapshot,
      });

      await mockSocket.trigger('collab:join', 'ch-3');

      // The cached doc should contain the text
      const cached = collabDocs.get('ch-3');
      expect(cached).toBeDefined();
      const content = cached!.doc.getText('content').toString();
      expect(content).toBe('Hello World');
    });

    it('rejects text channel', async () => {
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-text', type: 'text', serverId: 'srv-1',
      });

      await mockSocket.trigger('collab:join', 'ch-text');

      expect(mockSocket.join).not.toHaveBeenCalled();
    });

    it('rejects without VIEW_CHANNEL permission', async () => {
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-1', type: 'canvas', serverId: 'srv-1',
      });
      vi.mocked(hasChannelPermission).mockResolvedValueOnce(false);

      await mockSocket.trigger('collab:join', 'ch-1');

      expect(mockSocket.join).not.toHaveBeenCalled();
    });

    it('rejects invalid channelId', async () => {
      await mockSocket.trigger('collab:join', '');
      await mockSocket.trigger('collab:join', 123);

      expect(mockSocket.join).not.toHaveBeenCalled();
    });
  });

  describe('collab:leave', () => {
    it('leaves the collab room', async () => {
      // First join
      mockSocket.rooms.add('collab:ch-1');
      collabDocs.set('ch-1', { doc: new Y.Doc(), lastActivity: Date.now(), dirty: false });

      await mockSocket.trigger('collab:leave', 'ch-1');

      expect(mockSocket.leave).toHaveBeenCalledWith('collab:ch-1');
    });

    it('persists and evicts when last user leaves', async () => {
      const doc = new Y.Doc();
      const text = doc.getText('content');
      text.insert(0, 'Test');
      collabDocs.set('ch-1', { doc, lastActivity: Date.now(), dirty: true });
      mockSocket.rooms.add('collab:ch-1');

      // Mock channel type lookup (for getChannelType)
      prismaMock.channel.findUnique.mockResolvedValue({ type: 'code' });
      prismaMock.channelDocument.update.mockResolvedValue({});

      await mockSocket.trigger('collab:leave', 'ch-1');

      expect(prismaMock.channelDocument.update).toHaveBeenCalledWith({
        where: { channelId: 'ch-1' },
        data: { snapshot: expect.any(Buffer) },
      });
      expect(collabDocs.has('ch-1')).toBe(false);
    });

    it('ignores if not in room', async () => {
      await mockSocket.trigger('collab:leave', 'ch-missing');

      expect(mockSocket.leave).not.toHaveBeenCalled();
    });
  });

  describe('collab:update', () => {
    it('applies update and broadcasts to others', async () => {
      // Set up: user is in the room, doc is cached
      const doc = new Y.Doc();
      collabDocs.set('ch-1', { doc, lastActivity: Date.now(), dirty: false });
      mockSocket.rooms.add('collab:ch-1');
      // Mock channel type lookup (for getChannelType)
      prismaMock.channel.findUnique.mockResolvedValue({ type: 'code' });

      // Create a Yjs update
      const clientDoc = new Y.Doc();
      const text = clientDoc.getText('content');
      text.insert(0, 'Hello');
      const update = Y.encodeStateAsUpdate(clientDoc);
      const encoded = Buffer.from(update).toString('base64');
      clientDoc.destroy();

      await mockSocket.trigger('collab:update', { channelId: 'ch-1', update: encoded });

      // Doc should have the content
      const content = doc.getText('content').toString();
      expect(content).toBe('Hello');

      // Should be marked dirty
      expect(collabDocs.get('ch-1')!.dirty).toBe(true);

      // Should broadcast
      expect(mockSocket.to).toHaveBeenCalledWith('collab:ch-1');
    });

    it('rejects oversized updates', async () => {
      mockSocket.rooms.add('collab:ch-1');
      collabDocs.set('ch-1', { doc: new Y.Doc(), lastActivity: Date.now(), dirty: false });

      const oversized = 'A'.repeat(512 * 1024 + 1);
      await mockSocket.trigger('collab:update', { channelId: 'ch-1', update: oversized });

      // Should not have been applied (no broadcast)
      expect(mockSocket.to).not.toHaveBeenCalled();
    });

    it('rejects if not in room', async () => {
      const encoded = Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())).toString('base64');

      await mockSocket.trigger('collab:update', { channelId: 'ch-1', update: encoded });

      expect(mockSocket.to).not.toHaveBeenCalled();
    });

    it('rejects invalid payload', async () => {
      mockSocket.rooms.add('collab:ch-1');

      await mockSocket.trigger('collab:update', { channelId: 'ch-1' });
      await mockSocket.trigger('collab:update', { channelId: 123, update: 'abc' });
      await mockSocket.trigger('collab:update', null);

      expect(mockSocket.to).not.toHaveBeenCalled();
    });
  });

  describe('collab:awareness', () => {
    it('broadcasts awareness to room', async () => {
      mockSocket.rooms.add('collab:ch-1');

      await mockSocket.trigger('collab:awareness', { channelId: 'ch-1', states: '{"cursor":{}}' });

      expect(mockSocket.to).toHaveBeenCalledWith('collab:ch-1');
    });

    it('rejects oversized awareness (>8KB)', async () => {
      mockSocket.rooms.add('collab:ch-1');
      const big = 'A'.repeat(8193);

      await mockSocket.trigger('collab:awareness', { channelId: 'ch-1', states: big });

      expect(mockSocket.to).not.toHaveBeenCalled();
    });

    it('rejects if not in room', async () => {
      await mockSocket.trigger('collab:awareness', { channelId: 'ch-1', states: '{}' });

      expect(mockSocket.to).not.toHaveBeenCalled();
    });
  });
});
