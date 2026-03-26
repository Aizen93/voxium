import 'dotenv/config';
import { defineConfig } from 'prisma/config';

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
