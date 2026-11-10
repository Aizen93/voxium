import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPidRunning, killProcessTree, TASKKILL_NOTHING_KILLED } from '../../../../../scripts/lib/processTree.mjs';

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

  it('treats exit 128 as done, without a warning, when the root pid is gone afterwards (the tree died first)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const isRunning = vi.fn(() => false);
    await killProcessTree(fakeChild({ pid: 1234 }), { platform: 'win32', spawn: fakeSpawn({ code: TASKKILL_NOTHING_KILLED }) as never, isRunning });
    expect(isRunning).toHaveBeenCalledWith(1234);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs exit 128 when the root pid is still running (taskkill found the tree and terminated none of it)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const isRunning = vi.fn(() => true);
    await expect(
      killProcessTree(fakeChild({ pid: 4 }), { platform: 'win32', spawn: fakeSpawn({ code: TASKKILL_NOTHING_KILLED }) as never, isRunning }),
    ).resolves.toBeUndefined();
    expect(isRunning).toHaveBeenCalledWith(4);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('taskkill for pid 4 terminated nothing (exit 128) and pid 4 is still running'));
  });

  it('logs a failing liveness check after exit 128 and still resolves', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const isRunning = vi.fn(() => { throw new Error('probe failed'); });
    await expect(
      killProcessTree(fakeChild({ pid: 8 }), { platform: 'win32', spawn: fakeSpawn({ code: TASKKILL_NOTHING_KILLED }) as never, isRunning }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not check pid 8 after taskkill: probe failed'));
  });

  it('does not probe the pid after a taskkill that succeeded', async () => {
    const isRunning = vi.fn(() => true);
    await killProcessTree(fakeChild({ pid: 9 }), { platform: 'win32', spawn: fakeSpawn({ code: 0 }) as never, isRunning });
    expect(isRunning).not.toHaveBeenCalled();
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

describe('isPidRunning (the probe after a taskkill that terminated nothing)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is true for this process', () => {
    expect(isPidRunning(process.pid)).toBe(true);
  });

  it('is false for a process that is gone (ESRCH)', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }); });
    expect(isPidRunning(1234)).toBe(false);
  });

  it('is true for a process that runs but cannot be signalled (EPERM, like pid 4)', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); });
    expect(isPidRunning(4)).toBe(true);
  });

  it('only probes: it sends signal 0', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(isPidRunning(77)).toBe(true);
    expect(kill).toHaveBeenCalledWith(77, 0);
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

/** The grandchild exits by itself after this long, so a failed run cannot leave it for good. */
const GRANDCHILD_LIFETIME_MS = 60_000;

interface Spawned {
  wrapper: ChildProcess;
  grandchildPid: number | null;
  /** set once this test saw the grandchild end: its pid may be reused after that */
  grandchildGone: boolean;
}

async function waitUntilGone(pid: number, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPidRunning(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isPidRunning(pid);
}

async function waitUntilGrandchildGone(record: Spawned): Promise<boolean> {
  const gone = await waitUntilGone(record.grandchildPid!);
  if (gone) record.grandchildGone = true;
  return gone;
}

describe.runIf(process.platform === 'win32')('killProcessTree — real process tree on Windows', () => {
  let dir = '';
  let script = '';
  const spawned: Spawned[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'voxium-processtree-'));
    script = join(dir, 'grandchild.js');
    // Prints its own pid, then idles like a server would (bounded, see above)
    writeFileSync(script, `process.stdout.write(String(process.pid) + '\\n');\nsetTimeout(() => process.exit(0), ${GRANDCHILD_LIFETIME_MS});\n`);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(async () => {
    // A failed assertion must not leave a process behind
    for (const record of spawned.splice(0)) {
      // The wrapper is our child: its handle says whether it exited, so a
      // pid Windows has handed to another process is never touched. Its tree
      // holds the grandchild.
      if (record.wrapper.exitCode === null && record.wrapper.signalCode === null) {
        await killProcessTree(record.wrapper);
        continue;
      }
      // The grandchild is not ours (no handle): end it only while this test
      // never saw it end; it cannot have exited on its own this early
      const pid = record.grandchildPid;
      if (pid !== null && !record.grandchildGone && isPidRunning(pid)) {
        try { process.kill(pid); } catch (err) { console.warn(`cleanup of grandchild pid ${pid} failed: ${(err as Error).message}`); }
      }
    }
  });

  /** cmd.exe → node: resolves once the node grandchild has printed its pid. */
  function spawnWrappedNode(): Promise<Spawned & { grandchildPid: number }> {
    return new Promise((resolve, reject) => {
      // One command string with shell: true, as scripts/dev-all.mjs spawns
      const wrapper = spawn(`"${process.execPath}" "${script}"`, { shell: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const record: Spawned = { wrapper, grandchildPid: null, grandchildGone: false };
      spawned.push(record);
      let out = '';
      const timer = setTimeout(() => reject(new Error(
        `the grandchild never printed its pid within 8 s; afterEach kills the wrapper's tree, but a grandchild may be left behind (it exits by itself within ${GRANDCHILD_LIFETIME_MS / 1000} s)`,
      )), 8000);
      wrapper.on('error', (err) => { clearTimeout(timer); reject(err); });
      wrapper.stdout!.setEncoding('utf8');
      wrapper.stdout!.on('data', (chunk: string) => {
        out += chunk;
        const match = /^(\d+)\r?\n/.exec(out);
        if (match) {
          clearTimeout(timer);
          record.grandchildPid = Number(match[1]);
          resolve(record as Spawned & { grandchildPid: number });
        }
      });
    });
  }

  it('child.kill() alone leaves the grandchild running (the bug, reproduced)', async () => {
    const record = await spawnWrappedNode();
    const { wrapper, grandchildPid } = record;
    expect(grandchildPid).not.toBe(wrapper.pid);
    expect(isPidRunning(grandchildPid)).toBe(true);

    wrapper.kill();
    expect(await waitUntilGone(wrapper.pid!)).toBe(true);
    // a second later the grandchild is still there: nobody ended it
    await new Promise((r) => setTimeout(r, 1000));
    expect(isPidRunning(grandchildPid)).toBe(true);
  }, 20000);

  it('ends the wrapper AND the grandchild', async () => {
    const record = await spawnWrappedNode();
    const { wrapper, grandchildPid } = record;
    expect(isPidRunning(wrapper.pid!)).toBe(true);
    expect(isPidRunning(grandchildPid)).toBe(true);

    await killProcessTree(wrapper);

    expect(await waitUntilGone(wrapper.pid!)).toBe(true);
    expect(await waitUntilGrandchildGone(record)).toBe(true);
  }, 20000);

  it('does not run taskkill again for a child that has exited (its pid may be reused)', async () => {
    const record = await spawnWrappedNode();
    const { wrapper } = record;
    await killProcessTree(wrapper);
    await new Promise<void>((r) => (wrapper.exitCode !== null || wrapper.signalCode !== null ? r() : wrapper.once('exit', () => r())));
    expect(await waitUntilGrandchildGone(record)).toBe(true);

    const spawnMock = fakeSpawn({ code: 0 });
    await killProcessTree(wrapper, { spawn: spawnMock as never });
    expect(spawnMock).not.toHaveBeenCalled();
  }, 20000);
});
