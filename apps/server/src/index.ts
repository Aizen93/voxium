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
import { initRedis, NODE_ID } from './utils/redis';
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

  // Initialize WebSocket server
  const io = initSocketServer(server);
  console.log('[WS] Socket.IO server initialized');

  // Start admin metrics emitter
  startAdminMetricsEmitter(io);

  // Start attachment cleanup (3-day retention)
  startAttachmentCleanup();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n[Node ${NODE_ID}] Voxium server running on http://0.0.0.0:${PORT}\n`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    stopAdminMetricsEmitter();
    stopAttachmentCleanup();
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
