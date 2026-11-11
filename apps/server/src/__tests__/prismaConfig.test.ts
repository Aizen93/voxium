import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The Prisma CLI's update check sends the CLI version, platform, command and
 * a project hash to checkpoint.prisma.io on every run unless
 * CHECKPOINT_DISABLE is set (Prisma 7: `runCheckpointClientCheck`, which the
 * CLI starts only after it has loaded prisma.config.ts). Voxium uses no
 * third-party service, so the switch is set where every CLI run passes:
 * prisma.config.ts for every run from apps/server (dev, CI, the documented
 * commands), and the Dockerfile for both image stages, where an operator may
 * run the CLI from any directory. A fresh container showed the "Update
 * available" box and the checkpoint cache files on a second run without it,
 * and neither with it.
 */

const REPO = resolve(__dirname, '../../../..');

describe('the Prisma CLI update check is off', () => {
  const saved = process.env.CHECKPOINT_DISABLE;

  afterEach(() => {
    if (saved === undefined) delete process.env.CHECKPOINT_DISABLE;
    else process.env.CHECKPOINT_DISABLE = saved;
  });

  it('loading prisma.config.ts sets CHECKPOINT_DISABLE', async () => {
    delete process.env.CHECKPOINT_DISABLE;
    await import('../../prisma.config');
    expect(process.env.CHECKPOINT_DISABLE).toBe('1');
  });

  it('both Dockerfile stages set it before any command runs in them', () => {
    const dockerfile = readFileSync(resolve(REPO, 'Dockerfile'), 'utf8').replace(/\r\n/g, '\n');
    const stages = dockerfile.split(/^(?=FROM )/m).filter((s) => s.startsWith('FROM '));
    expect(stages.map((s) => s.match(/ AS (\w+)/)?.[1])).toEqual(['build', 'production']);
    for (const stage of stages) {
      const env = stage.search(/^ENV CHECKPOINT_DISABLE=1$/m);
      const firstRun = stage.search(/^RUN /m);
      expect(env).toBeGreaterThan(-1);
      expect(env).toBeLessThan(firstRun);
    }
  });
});
