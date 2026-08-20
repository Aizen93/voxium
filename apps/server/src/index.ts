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
import { prisma } from './utils/prisma';
import { initRedis, clearPresenceState, NODE_ID, startNodeHeartbeat, stopNodeHeartbeat } from './utils/redis';
import { ensureBucketEncryption } from './utils/s3';
import { loadRateLimitOverrides } from './middleware/rateLimiter';
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
  await clearPresenceState(prisma, io);
  console.log('[Presence] Stale presence cleared');
  await clearVoiceState(io).catch((err) => console.warn('[Voice] Stale voice cleanup failed:', err));
  await clearDMVoiceState(io).catch((err) => console.warn('[DMVoice] Stale DM-call cleanup failed:', err));
  console.log('[Voice] Stale voice state cleared');

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

  // Start attachment cleanup (3-day retention)
  startAttachmentCleanup();

  // Sweep undeliverable E2E key shares (30-day retention)
  startKeyShareCleanup();

  // Registration hygiene: unverified-account TTL + IP-record retention (GDPR)
  startRegistrationHygiene();

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
    stopVoiceCluster();
    // Drop our liveness key FIRST so peer reapers promptly clean up any voice
    // state this node owned, instead of waiting out the heartbeat TTL.
    await stopNodeHeartbeat().catch((err) => console.warn('[Shutdown] Heartbeat cleanup failed:', err));
    // Gracefully disconnect all Socket.IO clients before closing HTTP server
    io.disconnectSockets(true);
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
