import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  earlyAccess: true,
  schema: './prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
  migrate: {
    async seed() {
      const { execSync } = await import('child_process');
      execSync('npx tsx prisma/seed.ts', { stdio: 'inherit' });
    },
  },
});
