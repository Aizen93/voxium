import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * .github/workflows/server-image.yml builds the server image and boots it on
 * every change that can break a boot: before it, nothing built or started the
 * image between release tags, and a fresh install that refused to start
 * (issue #82) reached self-hosters first. These pin what review would
 * otherwise have to re-check by eye.
 */

const REPO = resolve(__dirname, '../../../../..');
const read = (path: string) => readFileSync(resolve(REPO, path), 'utf8').replace(/\r\n/g, '\n');
const workflow = read('.github/workflows/server-image.yml');

describe('server-image workflow', () => {
  it('pins every action exactly as docker.yml or ci.yml already does (SHA, tag in a comment)', () => {
    const known = `${read('.github/workflows/docker.yml')}\n${read('.github/workflows/ci.yml')}`;
    const uses = workflow.split('\n').filter((l) => /^\s*(- )?uses: /.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line).toMatch(/uses: [\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
      expect(known).toContain(line.trim().replace(/^- /, ''));
    }
  });

  it('reads the repository and pushes nothing', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(workflow).not.toMatch(/packages: write|push: true|docker\/login-action/);
  });

  it('runs on pull requests and develop pushes that touch what the image is built from', () => {
    for (const path of [
      'Dockerfile',
      'docker-entrypoint.sh',
      '.dockerignore',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'package.json',
      'apps/server/package.json',
      'apps/server/prisma/**',
      'apps/server/prisma.config.ts',
      '.github/workflows/server-image.yml',
    ]) {
      // Once under pull_request, once under push.
      expect(workflow.split('\n').filter((l) => l.trim() === `- ${path}`), path).toHaveLength(2);
    }
    expect(workflow).toMatch(/push:\n {4}branches: \[develop\]/);
  });

  it('interpolates no attacker-controlled context', () => {
    // Every expression in the file, none of them inside a run: script.
    expect(new Set(workflow.match(/\$\{\{.*?\}\}/g))).toEqual(
      new Set([
        '${{ github.ref }}',
        '${{ env.IMAGE }}',
        "${{ github.event_name == 'push' && 'type=gha,scope=server-image,mode=max' || '' }}",
      ])
    );
  });

  it('boots the empty database with no override, and refuses the existing one', () => {
    expect(workflow).not.toContain('VOXIUM_ALLOW_CUTOVER');
    expect(workflow).toContain('[Voxium] New database: every migration will be applied.');
    expect(workflow).toContain('FATAL: the always-on E2E cutover ($CUTOVER) has not been applied.');
    expect(workflow).toMatch(/migration_name = '\$CUTOVER'/);
  });
});
