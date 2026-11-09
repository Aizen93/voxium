import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killProcessTree, TASKKILL_NOT_FOUND } from '../../../../../scripts/lib/processTree.mjs';

// The tree-kill helper of the ROOT dev scripts (scripts/dev-all.mjs,
// scripts/test-multi-node.ts). It lives in the server suite, beside
// migrations/cutoverAuthorisation.test.ts, which checks another root script:
// the root package has no test runner, and this suite runs in a node
// environment (the desktop one is jsdom, no place to spawn processes).
//
// On Windows `child.kill()` ends ONE pid and the processes it started live on
// (the dev servers our scripts start through cmd.exe / pnpm / tsx kept their
// ports and wedged on an unread stdout pipe). The real-process tests below
// prove the helper ends the grandchild too; the injected-platform ones pin
// both branches on any machine.

/** A fake ChildProcess: only what the helper reads. */
function fakeChild(overrides: Partial<{ pid: number | undefined; exitCode: number | null; signalCode: NodeJS.Signals | null }> = {}) {
  return {
    pid: 'pid' in overrides ? overrides.pid : 4242,
    exitCode: overrides.exitCode ?? null,
    signalCode: overrides.signalCode ?? null,
    kill: vi.fn(() => true),
  };
}

/** A fake spawn whose process closes with `code` (or fails to start with `error`). */
function fakeSpawn(outcome: { code?: number | null; error?: Error }) {
  return vi.fn(() => {
    const proc = new EventEmitter();
    setImmediate(() => {
      if (outcome.error) proc.emit('error', outcome.error);
      else proc.emit('close', outcome.code ?? 0);
    });
    return proc as unknown as ChildProcess;
  });
}

describe('killProcessTree — win32 branch (taskkill)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('runs taskkill /pid <pid> /T /F with an args array and no shell', async () => {
    const child = fakeChild({ pid: 1234 });
    const spawnMock = fakeSpawn({ code: 0 });
    await killProcessTree(child, { platform: 'win32', spawn: spawnMock as never });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = spawnMock.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(cmd).toBe('taskkill');
    expect(args).toEqual(['/pid', '1234', '/T', '/F']);
    expect(options).toEqual({ stdio: 'ignore', windowsHide: true });
    expect(options).not.toHaveProperty('shell');
    // TerminateProcess on the one pid is exactly the bug: never call it
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('ignores the signal (taskkill /F has no gentler form)', async () => {
    const spawnMock = fakeSpawn({ code: 0 });
    await killProcessTree(fakeChild({ pid: 7 }), { platform: 'win32', signal: 'SIGINT', spawn: spawnMock as never });
    expect((spawnMock.mock.calls[0] as unknown as [string, string[]])[1]).toEqual(['/pid', '7', '/T', '/F']);
  });

  it('treats "process not found" (128) as done, without a warning: the tree died first', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await killProcessTree(fakeChild(), { platform: 'win32', spawn: fakeSpawn({ code: TASKKILL_NOT_FOUND }) as never });
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs any other non-zero taskkill exit and still resolves', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await killProcessTree(fakeChild({ pid: 99 }), { platform: 'win32', spawn: fakeSpawn({ code: 1 }) as never });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('taskkill for pid 99 exited with 1'));
  });

  it('logs a taskkill that cannot start and still resolves', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await killProcessTree(fakeChild({ pid: 5 }), { platform: 'win32', spawn: fakeSpawn({ error: new Error('spawn taskkill ENOENT') }) as never });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('taskkill for pid 5 failed: spawn taskkill ENOENT'));
  });

  it('logs a spawn that throws synchronously and still resolves', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const throwing = vi.fn(() => { throw new Error('EPERM'); });
    await expect(killProcessTree(fakeChild({ pid: 6 }), { platform: 'win32', spawn: throwing as never })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not start taskkill for pid 6: EPERM'));
  });

  it('never targets a pid whose process has exited (Windows reuses pids)', async () => {
    const spawnMock = fakeSpawn({ code: 0 });
    await killProcessTree(fakeChild({ exitCode: 1 }), { platform: 'win32', spawn: spawnMock as never });
    await killProcessTree(fakeChild({ exitCode: 0 }), { platform: 'win32', spawn: spawnMock as never });
    await killProcessTree(fakeChild({ signalCode: 'SIGTERM' }), { platform: 'win32', spawn: spawnMock as never });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does nothing for a child that never got a pid (spawn failed) or no child at all', async () => {
    const spawnMock = fakeSpawn({ code: 0 });
    const child = fakeChild({ pid: undefined });
    await killProcessTree(child, { platform: 'win32', spawn: spawnMock as never });
    await killProcessTree(null, { platform: 'win32', spawn: spawnMock as never });
    await killProcessTree(undefined, { platform: 'win32', spawn: spawnMock as never });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe('killProcessTree — POSIX branch (the signal, as before)', () => {
  afterEach(() => vi.restoreAllMocks());

  for (const platform of ['linux', 'darwin'] as const) {
    it(`${platform}: sends SIGTERM by default and spawns nothing`, async () => {
      const child = fakeChild();
      const spawnMock = fakeSpawn({ code: 0 });
      await killProcessTree(child, { platform, spawn: spawnMock as never });
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(spawnMock).not.toHaveBeenCalled();
    });
  }

  it('sends the signal asked for (the crash test uses SIGKILL)', async () => {
    const child = fakeChild();
    await killProcessTree(child, { platform: 'linux', signal: 'SIGKILL' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not signal a child that has exited, nor one without a pid', async () => {
    const exited = fakeChild({ exitCode: 0 });
    const killed = fakeChild({ signalCode: 'SIGKILL' });
    const noPid = fakeChild({ pid: undefined });
    await killProcessTree(exited, { platform: 'linux' });
    await killProcessTree(killed, { platform: 'linux' });
    await killProcessTree(noPid, { platform: 'linux' });
    expect(exited.kill).not.toHaveBeenCalled();
    expect(killed.kill).not.toHaveBeenCalled();
    expect(noPid.kill).not.toHaveBeenCalled();
  });

  it('logs a kill that throws and still resolves', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const child = fakeChild({ pid: 31 });
    child.kill.mockImplementation(() => { throw new Error('EPERM'); });
    await expect(killProcessTree(child, { platform: 'linux' })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not signal pid 31: EPERM'));
  });
});

// ── Real processes (Windows only: the branch this helper exists for) ─────────
//
// The wrapper is cmd.exe, as with `spawn(..., { shell: true })` in the dev
// scripts. It matters which: libuv puts every child a NODE process spawns into
// a kill-on-close job object, so a node parent's own children die with it
// (only its direct children: the job is silent-breakaway), while cmd.exe has
// no such job. Killing the cmd.exe at the top of a chain is what orphaned the
// servers.

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

describe.runIf(process.platform === 'win32')('killProcessTree — real process tree on Windows', () => {
  let dir = '';
  let script = '';
  const spawned: number[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'voxium-processtree-'));
    script = join(dir, 'grandchild.js');
    // Prints its own pid, then idles like a server would
    writeFileSync(script, "process.stdout.write(String(process.pid) + '\\n');\nsetInterval(() => {}, 1000);\n");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    // A failed assertion must not leave a process behind
    for (const pid of spawned.splice(0)) {
      if (isAlive(pid)) {
        try { process.kill(pid); } catch (err) { console.warn(`cleanup of pid ${pid} failed: ${(err as Error).message}`); }
      }
    }
  });

  /** cmd.exe → node: resolves once the node grandchild has printed its pid. */
  function spawnWrappedNode(): Promise<{ wrapper: ChildProcess; childPid: number }> {
    return new Promise((resolve, reject) => {
      // One command string with shell: true, as scripts/dev-all.mjs spawns
      const wrapper = spawn(`"${process.execPath}" "${script}"`, { shell: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      spawned.push(wrapper.pid!);
      let out = '';
      const timer = setTimeout(() => reject(new Error('the grandchild never printed its pid')), 8000);
      wrapper.on('error', (err) => { clearTimeout(timer); reject(err); });
      wrapper.stdout!.setEncoding('utf8');
      wrapper.stdout!.on('data', (chunk: string) => {
        out += chunk;
        const match = /^(\d+)\r?\n/.exec(out);
        if (match) {
          clearTimeout(timer);
          const childPid = Number(match[1]);
          spawned.push(childPid);
          resolve({ wrapper, childPid });
        }
      });
    });
  }

  it('child.kill() alone leaves the grandchild running (the bug, reproduced)', async () => {
    const { wrapper, childPid } = await spawnWrappedNode();
    expect(childPid).not.toBe(wrapper.pid);
    expect(isAlive(childPid)).toBe(true);

    wrapper.kill();
    expect(await waitUntilGone(wrapper.pid!)).toBe(true);
    // a second later the grandchild is still there: nobody ended it
    await new Promise((r) => setTimeout(r, 1000));
    expect(isAlive(childPid)).toBe(true);
  }, 20000);

  it('ends the wrapper AND the grandchild', async () => {
    const { wrapper, childPid } = await spawnWrappedNode();
    expect(isAlive(wrapper.pid!)).toBe(true);
    expect(isAlive(childPid)).toBe(true);

    await killProcessTree(wrapper);

    expect(await waitUntilGone(wrapper.pid!)).toBe(true);
    expect(await waitUntilGone(childPid)).toBe(true);
  }, 20000);

  it('does not run taskkill again for a child that has exited (its pid may be reused)', async () => {
    const { wrapper } = await spawnWrappedNode();
    await killProcessTree(wrapper);
    await new Promise<void>((r) => (wrapper.exitCode !== null || wrapper.signalCode !== null ? r() : wrapper.once('exit', () => r())));

    const spawnMock = fakeSpawn({ code: 0 });
    await killProcessTree(wrapper, { spawn: spawnMock as never });
    expect(spawnMock).not.toHaveBeenCalled();
  }, 20000);
});
