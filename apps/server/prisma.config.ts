import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// The Prisma CLI's update check sends the CLI version, platform, command and a
// project hash to checkpoint.prisma.io on every run unless CHECKPOINT_DISABLE
// is set, and Voxium uses no third-party service. The CLI loads this file
// before it starts the check, so this one line covers every run from
// apps/server: dev scripts, CI, the documented commands, the image's
// entrypoint (the Dockerfile sets it too, for runs outside apps/server).
process.env.CHECKPOINT_DISABLE = '1';

export default defineConfig({
  earlyAccess: true,
  schema: './prisma/schema.prisma',
  // datasource URL is optional for `prisma generate` (no DB needed).
  // Required for `prisma migrate` and `prisma db push`.
  // Uses process.env directly so it doesn't throw when unset (CI generate step).
  ...(process.env.DATABASE_URL ? { datasource: { url: process.env.DATABASE_URL } } : {}),
  migrate: {
    async seed() {
      const { execSync } = await import('child_process');
      execSync('npx tsx prisma/seed.ts', { stdio: 'inherit' });
    },
  },
});
