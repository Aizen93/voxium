// Fakes of what the vault ownership reaches of a page (services/e2e/vaultOwnership.ts):
// a lock manager with the Web Locks semantics it relies on (exclusive locks,
// a queue, ifAvailable, steal, an abort signal; the callback run later, never
// inside request()), and a BroadcastChannel bus. A test plays every other tab
// itself, through the same lock manager and a channel of its own on the bus.
import type { VaultChannel, VaultLockManager } from '../../services/e2e/vaultOwnership';

const abortError = () => Object.assign(new Error('The lock request was aborted'), { name: 'AbortError' });

interface Holder {
  reject: (err: unknown) => void;
  stolen: boolean;
}

/** An exclusive-only lock manager with the Web Locks semantics this module relies on. */
export class FakeLocks implements VaultLockManager {
  readonly held = new Map<string, Holder>();
  readonly queues = new Map<string, Array<() => void>>();
  requests: Array<{ name: string; ifAvailable?: boolean; steal?: boolean }> = [];

  request(
    name: string,
    options: { mode?: 'exclusive'; ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => unknown
  ): Promise<unknown> {
    this.requests.push({ name, ifAvailable: options.ifAvailable, steal: options.steal });
    return new Promise((resolve, reject) => {
      const grant = () => {
        const holder: Holder = { reject, stolen: false };
        this.held.set(name, holder);
        void Promise.resolve().then(async () => {
          let result: unknown;
          try {
            result = await callback({ name, mode: 'exclusive' });
          } catch (err) {
            if (!holder.stolen) {
              this.release(name, holder);
              reject(err);
            }
            return;
          }
          if (holder.stolen) return;
          this.release(name, holder);
          resolve(result);
        });
      };
      if (options.steal) {
        const current = this.held.get(name);
        if (current) {
          current.stolen = true;
          this.held.delete(name);
          current.reject(abortError());
        }
        grant();
        return;
      }
      const queue = this.queues.get(name) ?? [];
      if (!this.held.has(name) && queue.length === 0) {
        grant();
        return;
      }
      if (options.ifAvailable) {
        void Promise.resolve().then(async () => resolve(await callback(null)));
        return;
      }
      const waiter = () => grant();
      queue.push(waiter);
      this.queues.set(name, queue);
      options.signal?.addEventListener('abort', () => {
        const q = this.queues.get(name) ?? [];
        const i = q.indexOf(waiter);
        if (i !== -1) {
          q.splice(i, 1);
          reject(abortError());
        }
      });
    });
  }

  private release(name: string, holder: Holder): void {
    if (this.held.get(name) !== holder) return;
    this.held.delete(name);
    this.queues.get(name)?.shift()?.();
  }

  /** Another tab takes the lock (waiting for it if needed); returns its release and whether it was taken from it. */
  otherTab(name: string, opts: { steal?: boolean } = {}) {
    let release = () => {};
    let lost = false;
    const granted = new Promise<void>((onGranted) => {
      void this.request(name, { mode: 'exclusive', steal: opts.steal }, () => {
        onGranted();
        return new Promise<void>((r) => {
          release = r;
        });
      }).catch(() => {
        lost = true;
      });
    });
    return { granted, release: () => release(), lost: () => lost };
  }
}

export class Bus {
  readonly channels = new Set<FakeChannel>();
}

export class FakeChannel implements VaultChannel {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly received: Array<Record<string, unknown>> = [];
  constructor(private readonly bus: Bus) {
    bus.channels.add(this);
  }
  postMessage(message: unknown): void {
    for (const other of this.bus.channels) {
      if (other === this) continue;
      const data = structuredClone(message);
      void Promise.resolve().then(() => {
        other.received.push(data as Record<string, unknown>);
        other.onmessage?.({ data });
      });
    }
  }
  close(): void {
    this.bus.channels.delete(this);
  }
}
