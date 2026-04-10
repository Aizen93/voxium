import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import type { Socket } from 'socket.io-client';
import type { ServerToClientEvents, ClientToServerEvents } from '@voxium/shared';
import { handleCollabLanguageChanged } from '../stores/collabStore';

type VoxSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * A Yjs sync provider that uses the existing Socket.IO connection
 * instead of a separate WebSocket (y-websocket).
 *
 * Reuses auth, reconnect, and room infrastructure.
 */
export class SocketIOCollabProvider {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  private channelId: string;
  private socket: VoxSocket;
  private synced = false;
  private destroying = false;

  constructor(channelId: string, doc: Y.Doc, socket: VoxSocket) {
    this.channelId = channelId;
    this.doc = doc;
    this.socket = socket;
    this.awareness = new Awareness(doc);

    // ── Outgoing: local doc changes → server ────────────────────────
    this.doc.on('update', this.handleDocUpdate);

    // ── Outgoing: local awareness changes → server ──────────────────
    this.awareness.on('update', this.handleAwarenessUpdate);

    // ── Incoming: server broadcasts → local doc ─────────────────────
    this.socket.on('collab:sync', this.handleRemoteSync);
    this.socket.on('collab:awareness', this.handleRemoteAwareness);
    this.socket.on('collab:language_changed', this.handleLanguageChanged);

    // ── Join the collab room on the server ──────────────────────────
    this.socket.emit('collab:join', channelId);
  }

  // ── Outgoing handlers ──────────────────────────────────────────────────

  /** Convert a Uint8Array to a base64 string without stack overflow on large arrays. */
  private static toBase64(bytes: Uint8Array): string {
    // Process in chunks to avoid exceeding the max arguments limit of String.fromCharCode
    const CHUNK = 8192;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
      binary += String.fromCharCode(...slice);
    }
    return btoa(binary);
  }

  private handleDocUpdate = (update: Uint8Array, origin: unknown) => {
    // Don't re-broadcast updates that came from the server
    if (origin === this || this.destroying) return;
    const encoded = SocketIOCollabProvider.toBase64(update);
    this.socket.emit('collab:update', {
      channelId: this.channelId,
      update: encoded,
    });
  };

  private handleAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    if (this.destroying) return;
    const changedClients = added.concat(updated, removed);
    const encodedUpdate = encodeAwarenessUpdate(this.awareness, changedClients);
    const encoded = SocketIOCollabProvider.toBase64(encodedUpdate);
    this.socket.emit('collab:awareness', {
      channelId: this.channelId,
      states: encoded,
    });
  };

  // ── Incoming handlers ──────────────────────────────────────────────────

  private handleRemoteSync = (data: { channelId: string; update: string }) => {
    if (data.channelId !== this.channelId || this.destroying) return;
    try {
      const binary = Uint8Array.from(atob(data.update), (c) => c.charCodeAt(0));
      Y.applyUpdate(this.doc, binary, this); // origin = this to prevent re-broadcast
      if (!this.synced) {
        this.synced = true;
      }
    } catch (err) {
      console.warn('[CollabProvider] Failed to apply remote sync:', err);
    }
  };

  private handleRemoteAwareness = (data: { channelId: string; states: string }) => {
    if (data.channelId !== this.channelId || this.destroying) return;
    try {
      const binary = Uint8Array.from(atob(data.states), (c) => c.charCodeAt(0));
      applyAwarenessUpdate(this.awareness, binary, this);
    } catch (err) {
      console.warn('[CollabProvider] Failed to apply remote awareness:', err);
    }
  };

  private handleLanguageChanged = (data: { channelId: string; language: string }) => {
    if (data.channelId !== this.channelId || this.destroying) return;
    handleCollabLanguageChanged(data);
  };

  // ── Lifecycle ──────────────────────────────────────────────────────────

  destroy() {
    this.destroying = true;

    // Remove local awareness before leaving
    removeAwarenessStates(this.awareness, [this.doc.clientID], this);

    this.doc.off('update', this.handleDocUpdate);
    this.awareness.off('update', this.handleAwarenessUpdate);
    this.socket.off('collab:sync', this.handleRemoteSync);
    this.socket.off('collab:awareness', this.handleRemoteAwareness);
    this.socket.off('collab:language_changed', this.handleLanguageChanged);

    this.socket.emit('collab:leave', this.channelId);
    this.awareness.destroy();
  }
}
