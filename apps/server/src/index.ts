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

import http from 'http';
import { app } from './app';
import { initSocketServer } from './websocket/socketServer';
import { prisma } from './utils/prisma';
import { initRedis } from './utils/redis';

const PORT = parseInt(process.env.PORT || '3001', 10);

async function main() {
  // Connect to database
  await prisma.$connect();
  console.log('[DB] Connected to PostgreSQL');

  // Connect to Redis
  await initRedis();
  console.log('[Redis] Connected');

  // Create HTTP server
  const server = http.createServer(app);

  // Initialize WebSocket server
  initSocketServer(server);
  console.log('[WS] Socket.IO server initialized');

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Voxium server running on http://0.0.0.0:${PORT}\n`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
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
