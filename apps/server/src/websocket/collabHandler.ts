import type { Server as SocketServer, Socket } from 'socket.io';
import * as Y from 'yjs';
import type { ServerToClientEvents, ClientToServerEvents } from '@voxium/shared';
import { LIMITS } from '@voxium/shared';
import { prisma } from '../utils/prisma';
import { socketRateLimit } from '../middleware/rateLimiter';
import { hasChannelPermission } from '../utils/permissionCalculator';
import { Permissions } from '@voxium/shared';

// ─── In-memory caches ──────────────────────────────────────────────────────

// Code channels: Yjs document cache
interface CachedDoc {
  doc: Y.Doc;
  lastActivity: number;
  dirty: boolean;
}

const collabDocs = new Map<string, CachedDoc>();

// Canvas channels: tldraw snapshot cache (JSON string)
interface CachedCanvas {
  snapshot: string; // JSON string of tldraw store records
  lastActivity: number;
  dirty: boolean;
}

const canvasSnapshots = new Map<string, CachedCanvas>();

// Channel type cache (avoids repeated DB lookups)
const channelTypeCache = new Map<string, 'canvas' | 'code'>();

async function getChannelType(channelId: string): Promise<'canvas' | 'code' | null> {
  const cached = channelTypeCache.get(channelId);
  if (cached) return cached;

  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { type: true },
  });
  if (!channel || (channel.type !== 'canvas' && channel.type !== 'code')) return null;
  channelTypeCache.set(channelId, channel.type as 'canvas' | 'code');
  return channel.type as 'canvas' | 'code';
}

// ─── Code channel (Yjs) helpers ────────────────────────────────────────────

// Prevent concurrent getOrCreateDoc calls from creating duplicate Y.Docs
const docLoadingPromises = new Map<string, Promise<Y.Doc>>();

/** Load or create an in-memory Yjs document for a code channel. */
async function getOrCreateDoc(channelId: string): Promise<Y.Doc> {
  const cached = collabDocs.get(channelId);
  if (cached) {
    cached.lastActivity = Date.now();
    return cached.doc;
  }

  // Deduplicate concurrent loads for the same channel
  const existing = docLoadingPromises.get(channelId);
  if (existing) return existing;

  const loadPromise = (async () => {
    // Re-check cache after awaiting (another call may have resolved first)
    const rechecked = collabDocs.get(channelId);
    if (rechecked) {
      rechecked.lastActivity = Date.now();
      return rechecked.doc;
    }

    const doc = new Y.Doc();

    const record = await prisma.channelDocument.findUnique({
      where: { channelId },
      select: { snapshot: true },
    });
    if (record?.snapshot) {
      try {
        Y.applyUpdate(doc, new Uint8Array(record.snapshot));
      } catch (err) {
        console.warn(`[Collab] Failed to apply Yjs snapshot for channel ${channelId}:`, err instanceof Error ? err.message : err);
      }
    }

    collabDocs.set(channelId, { doc, lastActivity: Date.now(), dirty: false });
    return doc;
  })();

  docLoadingPromises.set(channelId, loadPromise);
  try {
    return await loadPromise;
  } finally {
    docLoadingPromises.delete(channelId);
  }
}

async function persistCodeDoc(channelId: string): Promise<void> {
  const cached = collabDocs.get(channelId);
  if (!cached || !cached.dirty) return;

  try {
    const snapshot = Buffer.from(Y.encodeStateAsUpdate(cached.doc));
    await prisma.channelDocument.update({
      where: { channelId },
      data: { snapshot },
    });
    cached.dirty = false;
  } catch (err) {
    console.error(`[Collab] Failed to persist code doc for ${channelId}:`, err instanceof Error ? err.message : err);
  }
}

// ─── Canvas channel (tldraw) helpers ───────────────────────────────────────

async function getCanvasSnapshot(channelId: string): Promise<string> {
  const cached = canvasSnapshots.get(channelId);
  if (cached) {
    cached.lastActivity = Date.now();
    return cached.snapshot;
  }

  const record = await prisma.channelDocument.findUnique({
    where: { channelId },
    select: { snapshot: true },
  });

  // Canvas snapshots are stored as base64 in the cache (matching the wire format).
  // DB stores raw bytes (the decoded JSON), so re-encode to base64 on load.
  const snapshotBase64 = record?.snapshot
    ? Buffer.from(record.snapshot).toString('base64')
    : Buffer.from('{}').toString('base64');
  canvasSnapshots.set(channelId, { snapshot: snapshotBase64, lastActivity: Date.now(), dirty: false });
  return snapshotBase64;
}

async function persistCanvasSnapshot(channelId: string): Promise<void> {
  const cached = canvasSnapshots.get(channelId);
  if (!cached || !cached.dirty) return;

  try {
    // cached.snapshot is base64; decode to raw bytes for DB storage
    await prisma.channelDocument.update({
      where: { channelId },
      data: { snapshot: Buffer.from(cached.snapshot, 'base64') },
    });
    cached.dirty = false;
  } catch (err) {
    console.error(`[Collab] Failed to persist canvas snapshot for ${channelId}:`, err instanceof Error ? err.message : err);
  }
}

// ─── Shared maintenance ────────────────────────────────────────────────────

async function evictIdle(): Promise<void> {
  const now = Date.now();
  const IDLE_THRESHOLD = 5 * 60 * 1000;

  for (const [channelId, cached] of collabDocs) {
    if (now - cached.lastActivity > IDLE_THRESHOLD) {
      await persistCodeDoc(channelId);
      cached.doc.destroy();
      collabDocs.delete(channelId);
    }
  }

  for (const [channelId, cached] of canvasSnapshots) {
    if (now - cached.lastActivity > IDLE_THRESHOLD) {
      await persistCanvasSnapshot(channelId);
      canvasSnapshots.delete(channelId);
    }
  }
}

async function persistAllDirty(): Promise<void> {
  for (const [channelId] of collabDocs) {
    await persistCodeDoc(channelId);
  }
  for (const [channelId] of canvasSnapshots) {
    await persistCanvasSnapshot(channelId);
  }
}

let persistInterval: ReturnType<typeof setInterval> | null = null;
let evictInterval: ReturnType<typeof setInterval> | null = null;

function startMaintenanceTimers() {
  if (!persistInterval) {
    persistInterval = setInterval(() => {
      persistAllDirty().catch((err) =>
        console.error('[Collab] Periodic persist failed:', err instanceof Error ? err.message : err)
      );
    }, 60_000);
  }
  if (!evictInterval) {
    evictInterval = setInterval(() => {
      evictIdle().catch((err) =>
        console.error('[Collab] Eviction failed:', err instanceof Error ? err.message : err)
      );
    }, 120_000);
  }
}

// ─── Socket event handler ──────────────────────────────────────────────────

export function handleCollabEvents(
  io: SocketServer<ClientToServerEvents, ServerToClientEvents>,
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
) {
  const userId = socket.data.userId as string;

  startMaintenanceTimers();

  // ─── collab:join ─────────────────────────────────────────────────────
  socket.on('collab:join', async (channelId: string) => {
    if (!socketRateLimit(socket, 'collab:join', 30)) return;
    if (typeof channelId !== 'string' || !channelId) return;

    try {
      const channel = await prisma.channel.findUnique({
        where: { id: channelId },
        select: { type: true, serverId: true },
      });
      if (!channel || (channel.type !== 'canvas' && channel.type !== 'code')) return;

      const canView = await hasChannelPermission(userId, channelId, channel.serverId, Permissions.VIEW_CHANNEL);
      if (!canView) return;

      channelTypeCache.set(channelId, channel.type as 'canvas' | 'code');
      socket.join(`collab:${channelId}`);

      if (channel.type === 'code') {
        // Send Yjs state
        const doc = await getOrCreateDoc(channelId);
        const state = Y.encodeStateAsUpdate(doc);
        const encoded = Buffer.from(state).toString('base64');
        socket.emit('collab:sync', { channelId, update: encoded });
      } else {
        // Send tldraw snapshot — already stored as base64 in the cache
        // (the client sends base64-encoded JSON, which we store as-is)
        const snapshot = await getCanvasSnapshot(channelId);
        socket.emit('collab:sync', { channelId, update: snapshot });
      }

      console.log(`[Collab] ${userId} joined collab:${channelId} (${channel.type})`);
    } catch (err) {
      console.error(`[Collab] collab:join failed for ${userId}:`, err instanceof Error ? err.message : err);
    }
  });

  // ─── collab:leave ────────────────────────────────────────────────────
  socket.on('collab:leave', async (channelId: string) => {
    if (!socketRateLimit(socket, 'collab:leave', 30)) return;
    if (typeof channelId !== 'string' || !channelId) return;
    if (!socket.rooms.has(`collab:${channelId}`)) return;

    socket.leave(`collab:${channelId}`);

    const sockets = await io.in(`collab:${channelId}`).fetchSockets();
    if (sockets.length === 0) {
      const type = await getChannelType(channelId);
      if (type === 'code') {
        await persistCodeDoc(channelId);
        const cached = collabDocs.get(channelId);
        if (cached) { cached.doc.destroy(); collabDocs.delete(channelId); }
      } else if (type === 'canvas') {
        await persistCanvasSnapshot(channelId);
        canvasSnapshots.delete(channelId);
      }
    }

    console.log(`[Collab] ${userId} left collab:${channelId}`);
  });

  // ─── collab:update ───────────────────────────────────────────────────
  socket.on('collab:update', async (data: { channelId: string; update: string }) => {
    if (!socketRateLimit(socket, 'collab:update', 180)) return;
    if (!data || typeof data.channelId !== 'string' || typeof data.update !== 'string') return;
    if (data.update.length > LIMITS.MAX_COLLAB_UPDATE_SIZE) return;
    if (!socket.rooms.has(`collab:${data.channelId}`)) return;

    try {
      const type = await getChannelType(data.channelId);

      if (type === 'code') {
        // Apply Yjs update to server-side doc
        const updateBytes = new Uint8Array(Buffer.from(data.update, 'base64'));
        const doc = await getOrCreateDoc(data.channelId);
        Y.applyUpdate(doc, updateBytes);
        const cached = collabDocs.get(data.channelId);
        if (cached) { cached.dirty = true; cached.lastActivity = Date.now(); }
      } else if (type === 'canvas') {
        // For canvas, store the latest snapshot (full state from client)
        let cached = canvasSnapshots.get(data.channelId);
        if (!cached) {
          // Re-initialize cache entry if evicted by idle timer while client still connected
          cached = { snapshot: '{}', lastActivity: Date.now(), dirty: false };
          canvasSnapshots.set(data.channelId, cached);
        }
        cached.lastActivity = Date.now();
        cached.snapshot = data.update; // Store the full snapshot from client
        cached.dirty = true;
      }

      // Broadcast to other clients
      socket.to(`collab:${data.channelId}`).emit('collab:sync', {
        channelId: data.channelId,
        update: data.update,
      });
    } catch (err) {
      console.warn(`[Collab] collab:update failed for ${userId}:`, err instanceof Error ? err.message : err);
    }
  });

  // ─── collab:awareness ────────────────────────────────────────────────
  socket.on('collab:awareness', (data: { channelId: string; states: string }) => {
    if (!socketRateLimit(socket, 'collab:awareness', 120)) return;
    if (!data || typeof data.channelId !== 'string' || typeof data.states !== 'string') return;
    if (data.states.length > 8192) return;
    if (!socket.rooms.has(`collab:${data.channelId}`)) return;

    socket.to(`collab:${data.channelId}`).emit('collab:awareness', {
      channelId: data.channelId,
      states: data.states,
    });
  });
}

// ─── Cleanup on shutdown ────────────────────────────────────────────────────

export async function shutdownCollab(): Promise<void> {
  if (persistInterval) clearInterval(persistInterval);
  if (evictInterval) clearInterval(evictInterval);
  persistInterval = null;
  evictInterval = null;

  await persistAllDirty();
  for (const [, cached] of collabDocs) {
    cached.doc.destroy();
  }
  collabDocs.clear();
  canvasSnapshots.clear();
  channelTypeCache.clear();
}

// Export for testing
export { collabDocs, canvasSnapshots, getOrCreateDoc, persistCodeDoc as persistDoc };
