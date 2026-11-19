import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEMO_SEED_OVERRIDE, demoSeedOverrideWarning, demoSeedRefusal } from '../../../prisma/seedGuard';

// The demo seed makes three verified accounts with a published password: it
// must not run against a production configuration unless the operator says
// so for that run. Development, test and CI databases need no flag.

const SERVER = path.resolve(__dirname, '../../..');

describe('demoSeedRefusal', () => {
  it.each([undefined, '', 'development', 'test', 'staging', 'Production'])('lets NODE_ENV=%j seed without a flag', (nodeEnv) => {
    expect(demoSeedRefusal({ nodeEnv, allowDemoSeed: undefined })).toBeNull();
  });

  it('refuses NODE_ENV=production, and says what the seed creates and how to go on', () => {
    const refusal = demoSeedRefusal({ nodeEnv: 'production', allowDemoSeed: undefined });
    expect(refusal).toMatch(/^Refusing to seed demo data: NODE_ENV=production\./);
    expect(refusal).toContain('alice, bob and charlie');
    expect(refusal).toContain('VOXIUM_ALLOW_DEMO_SEED=1');
  });

  it('runs in production only with the exact override value 1', () => {
    expect(DEMO_SEED_OVERRIDE).toBe('VOXIUM_ALLOW_DEMO_SEED');
    expect(demoSeedRefusal({ nodeEnv: 'production', allowDemoSeed: '1' })).toBeNull();
    for (const value of ['', '0', 'true', 'yes', ' 1', '1 ', 'TRUE']) {
      expect(demoSeedRefusal({ nodeEnv: 'production', allowDemoSeed: value }), value).not.toBeNull();
    }
  });

  it('warns about the accounts when the override is used', () => {
    expect(demoSeedOverrideWarning()).toContain('alice, bob, charlie');
    expect(demoSeedOverrideWarning()).toContain('VOXIUM_ALLOW_DEMO_SEED=1');
  });
});

describe('prisma.config.ts: the command `prisma db seed` runs', () => {
  it('is configured under migrations.seed, the key Prisma 7 reads, and runs prisma/seed.ts', async () => {
    const config = (await import('../../../prisma.config')).default as { migrations?: { seed?: string }; migrate?: unknown };
    expect(config.migrations?.seed).toBe('npx --no tsx prisma/seed.ts');
    // the earlier spelling, which Prisma 7 ignores. defineConfig drops unknown
    // keys, so the loaded object cannot show it: the file's text does
    expect(readFileSync(path.join(SERVER, 'prisma.config.ts'), 'utf8')).not.toMatch(/^\s*migrate\s*:/m);
    const script = /prisma\/seed\.ts$/.exec(config.migrations!.seed!)?.[0];
    expect(script).toBe('prisma/seed.ts');
    expect(readFileSync(path.join(SERVER, script!), 'utf8')).toContain('demoSeedRefusal({');
  });

});

describe('prisma/seed.ts', () => {
  const seed = readFileSync(path.join(SERVER, 'prisma/seed.ts'), 'utf8');

  it('imports only what the server image holds, so the refusal works in the container too', () => {
    // The production stage copies apps/server/prisma and src/generated/prisma, not the rest of src/
    const dockerfile = readFileSync(path.join(SERVER, '../../Dockerfile'), 'utf8');
    expect(dockerfile).toContain('COPY --from=build /app/apps/server/prisma apps/server/prisma');
    expect(dockerfile).toContain('COPY --from=build /app/apps/server/src/generated/prisma apps/server/src/generated/prisma');
    const relative = [...seed.matchAll(/from '(\.[^']+)'/g)].map((m) => m[1]);
    expect(relative).toContain('./seedGuard');
    for (const spec of relative) expect(spec, spec).toMatch(/^(?:\.\/[^/]+|\.\.\/src\/generated\/prisma\/.+)$/);
  });

  it('checks the guard before it creates a database client', () => {
    const guard = seed.indexOf('demoSeedRefusal({');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(seed.indexOf('new PrismaPg('));
    expect(guard).toBeLessThan(seed.indexOf('new PrismaClient('));
    // after dotenv, so a .env saying production counts
    expect(seed.indexOf("import 'dotenv/config';")).toBeLessThan(guard);
    expect(seed).toContain('nodeEnv: process.env.NODE_ENV');
    expect(seed).toContain('allowDemoSeed: process.env.VOXIUM_ALLOW_DEMO_SEED');
  });

  // The real script, through tsx as `pnpm db:seed` and the prisma.config.ts
  // hook run it. The database URL names a closed port: a guard that let the
  // run through would fail on the connection instead, with another message.
  function runSeed(extra: Record<string, string>) {
    return spawnSync(process.execPath, ['--import', 'tsx', 'prisma/seed.ts'], {
      cwd: SERVER,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        // What node and tsx need from the machine, and nothing of the checkout's own settings
        ...Object.fromEntries(['PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE']
          .filter((k) => process.env[k] !== undefined)
          .map((k) => [k, process.env[k]!])),
        // No .env of the checkout may decide the run
        DOTENV_CONFIG_PATH: path.join(SERVER, 'prisma', 'no-such.env'),
        DATABASE_URL: 'postgresql://seed-guard:seed-guard@127.0.0.1:1/seed_guard',
        ...extra,
      },
    });
  }

  it('exits non-zero under NODE_ENV=production without the override, before connecting', () => {
    const result = runSeed({ NODE_ENV: 'production' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing to seed demo data: NODE_ENV=production.');
    expect(result.stdout).not.toContain('Seeding database...');
  }, 60_000);

  it('goes on to the database outside production (and fails here only because the port is closed)', () => {
    const result = runSeed({ NODE_ENV: 'development' });
    expect(result.stderr).not.toContain('Refusing to seed demo data');
    expect(result.stdout).toContain('Seeding database...');
    expect(result.status).toBe(1);
  }, 60_000);

  it('goes on under production with VOXIUM_ALLOW_DEMO_SEED=1, with the warning', () => {
    const result = runSeed({ NODE_ENV: 'production', VOXIUM_ALLOW_DEMO_SEED: '1' });
    expect(result.stderr).not.toContain('Refusing to seed demo data');
    expect(result.stderr).toContain('WARNING: VOXIUM_ALLOW_DEMO_SEED=1 under NODE_ENV=production');
    expect(result.stdout).toContain('Seeding database...');
  }, 60_000);
});
