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

// Warn about optional but security-critical env vars
if (!process.env.TOTP_ENCRYPTION_KEY) {
  console.warn('\nWARNING: TOTP_ENCRYPTION_KEY is not set. TOTP secrets will be stored UNENCRYPTED in the database.');
  console.warn('Set this to a 32-byte hex string (64 characters) for production use.\n');
}

import http from 'http';
import { app } from './app';
import { initSocketServer } from './websocket/socketServer';
import { startAdminMetricsEmitter, stopAdminMetricsEmitter } from './websocket/adminMetrics';
import { startAttachmentCleanup, stopAttachmentCleanup } from './utils/attachmentCleanup';
import { prisma } from './utils/prisma';
import { initRedis, clearPresenceState, NODE_ID } from './utils/redis';
import { loadRateLimitOverrides } from './middleware/rateLimiter';
import { loadFeatureFlags } from './utils/featureFlags';
import { initMediasoup } from './mediasoup/mediasoupManager';

const PORT = parseInt(process.env.PORT || '3001', 10);

async function main() {
  // Connect to database
  await prisma.$connect();
  console.log('[DB] Connected to PostgreSQL');

  // Connect to Redis
  await initRedis();
  console.log('[Redis] Connected');

  // Reset stale presence from previous runs (crash, hot reload, etc.)
  await clearPresenceState(prisma);
  console.log('[Presence] Stale presence cleared');

  // Load rate limit overrides from Redis
  await loadRateLimitOverrides();
  console.log('[RateLimit] Overrides loaded');

  // Load feature flags from Redis
  await loadFeatureFlags();
  console.log('[FeatureFlags] Loaded');

  // Initialize mediasoup workers
  await initMediasoup();
  console.log('[mediasoup] Workers initialized');

  // Create HTTP server
  const server = http.createServer(app);

  // Production HTTP timeouts — prevent hanging connections from accumulating
  server.keepAliveTimeout = 65000;   // Must exceed reverse proxy keep-alive (nginx default: 60s)
  server.headersTimeout = 66000;     // Must be > keepAliveTimeout

  // Initialize WebSocket server
  const io = initSocketServer(server);
  console.log('[WS] Socket.IO server initialized');

  // Start admin metrics emitter
  startAdminMetricsEmitter(io);

  // Start attachment cleanup (3-day retention)
  startAttachmentCleanup();

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
    // Gracefully disconnect all Socket.IO clients before closing HTTP server
    io.disconnectSockets(true);
    server.close();
    // Clean up presence so users don't appear online after shutdown
    await clearPresenceState(prisma).catch((err) => console.warn('[Shutdown] Presence cleanup failed:', err));
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
