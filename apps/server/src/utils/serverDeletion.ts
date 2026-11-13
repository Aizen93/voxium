import { WS_EVENTS } from '@voxium/shared';
import { prisma } from './prisma';
import { deleteFromS3 } from './s3';
import { collectAttachmentKeys, deleteAttachmentBlobs } from './attachmentBlobs';
import { bumpDiscoveryPageCache } from './discoveryPageCache';
import { getIO } from '../websocket/socketServer';
import { broadcastServerVoiceCleanup } from '../websocket/voiceCluster';

/** A step after the committing write failed: logged, never thrown (the space is gone either way). */
function logFanOutFailure(logPrefix: string, step: string, serverId: string, err: unknown): void {
  console.error(`${logPrefix} Space ${serverId} deleted, but ${step} failed:`, err instanceof Error ? err.message : err);
}

/**
 * Delete a space, then tell everyone. Shared by the owner's
 * DELETE /servers/:serverId, the admin's DELETE /admin/servers/:serverId and
 * the `delete` action of the admin account deletion, so the three cannot
 * drift apart.
 *
 * The row goes FIRST. Everything after it is best effort, each step on its
 * own: a step that throws is logged and the next one still runs, and none of
 * them can fail the caller. The other order (notices and room operations
 * first, the row last) answered 500 for a space every member had already
 * been told was gone when any one of those steps threw, with the space, its
 * channels and its messages still in the database. A failing row delete
 * throws before anything is announced, so nobody is told about a deletion
 * that did not happen.
 *
 * What a step after the delete needs and the cascade takes with the row is
 * read before it: the channel ids, whose rooms the sockets must leave, and
 * the keys of the attachment files still kept on the messages of every
 * channel (secure ones included), whose files go with the space.
 *
 * After the row, in this order:
 *  - the Explore page cache generation (never throws), so the card is gone
 *    at the next open;
 *  - the icon and attachment files, started and never awaited (the response
 *    does not wait on storage; the orphan sweep reclaims a file whose delete
 *    failed), ahead of the fan-out so nothing in it can skip them;
 *  - live voice, on every node (mediasoup objects are node-local), silently:
 *    clients tear their call down on `server:deleted`;
 *  - `server:deleted` to the space room;
 *  - every socket in the space room OR any of its channel rooms leaves all
 *    of them (a socket can sit in a channel room without the server room).
 *    Adapter-wide room operations, never a `fetchSockets()` round trip, which
 *    waits for every node and throws after 5 s when one peer is unresponsive.
 *    Local form first, then cluster-wide (see utils/memberBroadcast.ts: the
 *    Redis adapter applies the cluster form on this node only when its own
 *    message comes back); published after the notice on the same Redis
 *    connection, so every peer delivers the notice before it applies the
 *    leave.
 */
export async function deleteServerAndAnnounce(
  server: { id: string; iconUrl: string | null },
  opts: { cacheReason: string; logPrefix: string },
): Promise<void> {
  const serverId = server.id;
  const channels = await prisma.channel.findMany({
    where: { serverId },
    select: { id: true },
  });
  const attachmentKeys = await collectAttachmentKeys({ channel: { serverId } });

  // The cascade takes channels, members, messages, attachments, reactions,
  // reads, categories, invites, roles and webhooks with the row.
  await prisma.server.delete({ where: { id: serverId } });

  await bumpDiscoveryPageCache(opts.cacheReason);

  if (server.iconUrl) {
    deleteFromS3(server.iconUrl).catch((err) =>
      console.warn(`${opts.logPrefix} Server icon cleanup failed (the orphan sweep will reclaim it):`, err instanceof Error ? err.message : err));
  }
  deleteAttachmentBlobs(attachmentKeys, opts.logPrefix, `space ${serverId}`);

  const io = getIO();

  try {
    await broadcastServerVoiceCleanup(io, serverId);
  } catch (err) {
    logFanOutFailure(opts.logPrefix, 'the voice cleanup', serverId, err);
  }

  try {
    io.to(`server:${serverId}`).emit(WS_EVENTS.SERVER_DELETED, { serverId });
  } catch (err) {
    logFanOutFailure(opts.logPrefix, 'the server:deleted notice', serverId, err);
  }

  const rooms = [`server:${serverId}`, ...channels.map((c) => `channel:${c.id}`)];
  try {
    io.local.in(rooms).socketsLeave(rooms);
  } catch (err) {
    logFanOutFailure(opts.logPrefix, 'the local room leave', serverId, err);
  }
  try {
    io.in(rooms).socketsLeave(rooms);
  } catch (err) {
    logFanOutFailure(opts.logPrefix, 'the cluster room leave', serverId, err);
  }
}
