import dotenv from 'dotenv';
dotenv.config();

// Validate required env vars before any module reads them
const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'S3_ASSETS_ENDPOINT',
  'S3_ASSETS_REGION',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'S3_ASSETS_BUCKET',
] as const;

const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`\nFATAL: Missing required environment variables:\n  ${missing.join('\n  ')}\n`);
  process.exit(1);
}

// TOTP_ENCRYPTION_KEY: fail closed in production — without it TOTP secrets
// would be stored in PLAINTEXT. Dev keeps the warning-only fallback so local
// setups don't need the key.
if (!process.env.TOTP_ENCRYPTION_KEY) {
  if (process.env.NODE_ENV === 'production') {
    console.error('\nFATAL: TOTP_ENCRYPTION_KEY is not set — refusing to start in production (TOTP secrets would be stored UNENCRYPTED).');
    console.error('Generate one with: openssl rand -hex 32\n');
    process.exit(1);
  }
  console.warn('\nWARNING: TOTP_ENCRYPTION_KEY is not set. TOTP secrets will be stored UNENCRYPTED in the database.');
  console.warn('Set this to a 32-byte hex string (64 characters) for production use.\n');
}

import http from 'http';
import { app } from './app';
import { initSocketServer } from './websocket/socketServer';
import { startAdminMetricsEmitter, stopAdminMetricsEmitter } from './websocket/adminMetrics';
import { startAttachmentCleanup, stopAttachmentCleanup } from './utils/attachmentCleanup';
import { startRegistrationHygiene, stopRegistrationHygiene } from './utils/registrationHygiene';
import { startKeyShareCleanup, stopKeyShareCleanup } from './utils/keyShareCleanup';
import { startOrphanCleanup, stopOrphanCleanup } from './utils/orphanCleanup';
import { prisma } from './utils/prisma';
import { initRedis, clearPresenceState, NODE_ID, NODE_HEARTBEAT_TTL_S, startNodeHeartbeat, stopNodeHeartbeat } from './utils/redis';
import { ensureBucketEncryption } from './utils/s3';
import { loadRateLimitOverrides } from './middleware/rateLimiter';
import { repairIpBanSpellings } from './utils/ipBans';
import { loadFeatureFlags } from './utils/featureFlags';
import { initMediasoup, onWorkerDeath } from './mediasoup/mediasoupManager';
import { clearVoiceState, dispatchVoiceEvent, handleWorkerDeath } from './websocket/voiceHandler';
import { clearDMVoiceState } from './websocket/dmVoiceHandler';
import { initVoiceCluster, stopVoiceCluster } from './websocket/voiceCluster';
import { initVoiceRelay } from './websocket/voiceRelay';

const PORT = parseInt(process.env.PORT || '3001', 10);

async function main() {
  // Connect to database
  await prisma.$connect();
  console.log('[DB] Connected to PostgreSQL');

  // Connect to Redis
  await initRedis();
  console.log('[Redis] Connected');

  // Announce this node's liveness IMMEDIATELY so peer reapers stop treating our
  // state as dead. Production runs multiple horizontally-scaled instances.
  await startNodeHeartbeat();
  console.log(`[Node ${NODE_ID()}] Heartbeat started`);

  // Load rate limit overrides from Redis
  await loadRateLimitOverrides();
  console.log('[RateLimit] Overrides loaded');

  // Load feature flags from Redis
  await loadFeatureFlags();
  console.log('[FeatureFlags] Loaded');

  // Bans stored before the admin write path normalized addresses never
  // matched the canonical form readers query. Non-fatal: a failure here
  // leaves those rows as they were, which is the state they were in anyway.
  try {
    const repaired = await repairIpBanSpellings(prisma);
    if (repaired.rewritten || repaired.merged) {
      console.log(`[IpBan] Repaired ${repaired.rewritten} non-canonical ban(s), merged ${repaired.merged} duplicate(s)`);
    }
  } catch (err) {
    console.warn('[IpBan] Spelling repair failed (bans in non-canonical form stay inert):', err instanceof Error ? err.message : err);
  }

  // Apply bucket-default encryption when S3_SSE is set (never throws;
  // logs loudly if the provider/key can't do it — uploads keep working)
  await ensureBucketEncryption();

  // Initialize mediasoup workers
  await initMediasoup();
  console.log('[mediasoup] Workers initialized');

  // Create HTTP server
  const server = http.createServer(app);

  // Production HTTP timeouts — prevent hanging connections from accumulating
  server.keepAliveTimeout = 65000;   // Must exceed reverse proxy keep-alive (nginx default: 60s)
  server.headersTimeout = 66000;     // Must be > keepAliveTimeout

  // Initialize WebSocket server (before the stale-state cleanups: they need the
  // Redis adapter to emit cross-node and to check cluster-wide socket existence;
  // no client can connect until server.listen() below)
  const io = initSocketServer(server);
  console.log('[WS] Socket.IO server initialized');

  // Reset stale state from previous runs (crash, hot reload, redeploy). All three
  // are multi-node aware: with live peer nodes they reap only cluster-wide-dead
  // state; the full wipes run only when this is the sole node.
  const presence = await clearPresenceState(prisma, io);
  if (!presence.skipped) console.log('[Presence] Stale presence cleared');
  await clearVoiceState(io).catch((err) => console.warn('[Voice] Stale voice cleanup failed:', err));
  const dmVoice = await clearDMVoiceState(io).catch((err) => {
    console.warn('[DMVoice] Stale DM-call cleanup failed:', err);
    return { skipped: false };
  });
  console.log('[Voice] Stale voice state cleared');

  // A sweep that REFUSED an unusable cluster snapshot has left real stale state
  // behind, and nothing else reaps presence. The ambiguity it refused on is
  // "a heartbeat exists but the adapter sees no peer", which is either a live
  // peer whose subscriber connection blipped, or the CORPSE of a node that was
  // killed hard — and a corpse's heartbeat expires within its TTL. So the
  // ambiguity resolves itself; we just have to look again afterwards.
  //
  // This is not hypothetical: NODE_ID defaults to a fresh random id per
  // process, so a hard-killed node is a peer to its own replacement, and every
  // SIGKILL restart of a sole node hit this. Retrying once past the TTL turns
  // that into a short delay instead of ghost "online" users that survive until
  // some later boot happens to catch a clean snapshot.
  //
  // The retry fires AFTER server.listen() below, so `allowFullWipe: false` is
  // load-bearing: by then this node is serving clients, and the sole-node
  // full wipe — which the corpse's expired heartbeat would otherwise select,
  // since that is exactly how the ambiguity resolves — would erase the
  // presence and DM-call state of everyone who connected in the meantime. The
  // scoped path is complete on a sole node (its own rooms are the cluster's),
  // so it reaps precisely the crash ghosts and nothing else.
  if (presence.skipped || dmVoice.skipped) {
    const retryMs = (NODE_HEARTBEAT_TTL_S + 5) * 1000;
    console.log(`[Presence] Boot sweep deferred — retrying in ${Math.round(retryMs / 1000)}s, once any stale heartbeat has expired`);
    setTimeout(() => {
      void (async () => {
        try {
          if (presence.skipped) {
            const retry = await clearPresenceState(prisma, io, { allowFullWipe: false });
            console.log(retry.skipped
              ? '[Presence] Deferred sweep still could not see the cluster — leaving state for the next boot'
              : '[Presence] Deferred sweep completed');
          }
          if (dmVoice.skipped) {
            const retry = await clearDMVoiceState(io, { allowFullWipe: false });
            console.log(retry.skipped
              ? '[DMVoice] Deferred sweep still could not see the cluster — leaving state for the next boot'
              : '[DMVoice] Deferred sweep completed');
          }
        } catch (err) {
          console.warn('[Presence] Deferred boot sweep failed:', err instanceof Error ? err.message : err);
        }
      })();
    }, retryMs).unref?.();
  }

  // Cross-node voice coordination: server-deletion fan-out + dead-node reaper
  await initVoiceCluster(io);
  console.log('[VoiceCluster] Initialized');

  // Channel-affinity voice signaling relay (HIGH-15): a channel's mediasoup
  // Router lives on ONE node; peers relay their participants' voice events here
  // and this node dispatches them against shims.
  await initVoiceRelay(io, (shim, event, args, ack) => dispatchVoiceEvent(io, shim, event, args, ack));
  console.log('[VoiceRelay] Initialized');

  // On mediasoup worker death: evict stranded voice sessions and tell their
  // clients to rejoin (they'd otherwise sit in a silently dead channel)
  onWorkerDeath((channelIds) => handleWorkerDeath(io, channelIds));

  // Start admin metrics emitter
  startAdminMetricsEmitter(io);

  // Start attachment cleanup (3-day retention) — leader-locked via withClusterLock
  startAttachmentCleanup();

  // Sweep undeliverable E2E key shares (30-day retention) — leader-locked via withClusterLock
  startKeyShareCleanup();

  // Registration hygiene: unverified-account TTL + IP-record retention (GDPR)
  startRegistrationHygiene();

  // Backstop for S3 objects whose DB row went without them. Age-gated and
  // leader-locked — see the header of utils/orphanCleanup.ts for why both
  // matter more than the sweep itself.
  startOrphanCleanup();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n[Node ${NODE_ID()}] Voxium server running on http://0.0.0.0:${PORT}\n`);
    // Signal readiness probe after full initialization (migrations, Redis, mediasoup)
    import('./app').then(({ markServerReady }) => markServerReady());
  });

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down...');
    stopAdminMetricsEmitter();
    stopAttachmentCleanup();
    stopKeyShareCleanup();
    stopRegistrationHygiene();
    stopOrphanCleanup();
    stopVoiceCluster();
    // Drop our liveness key FIRST so peer reapers promptly clean up any voice
    // state this node owned, instead of waiting out the heartbeat TTL.
    await stopNodeHeartbeat().catch((err) => console.warn('[Shutdown] Heartbeat cleanup failed:', err));
    // Gracefully disconnect all Socket.IO clients before closing HTTP server
    // .local: the adapter's disconnectSockets publishes a REMOTE_DISCONNECT
    // with an empty room filter, which every peer (and this node) applies to
    // its ENTIRE namespace — restarting one node would hang up every client in
    // the cluster, tearing down the surviving node's voice sessions and DM
    // calls too. (Pre-existing; found while reviewing the boot-sweep change.)
    io.local.disconnectSockets(true);
    server.close();
    // Clean up presence so users don't appear online after shutdown.
    // Multi-node aware: with live peers this only reaps OUR dead sockets —
    // wiping everything would mark the peers' users offline.
    await clearPresenceState(prisma, io).catch((err) => console.warn('[Shutdown] Presence cleanup failed:', err));
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Catch unhandled errors to prevent silent crashes
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[Process] Unhandled Rejection at:', promise, 'reason:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[Process] Uncaught Exception:', err);
    shutdown();
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
