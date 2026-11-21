import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Tabs of one browser, for tests that load the session modules once per tab
 * (`vi.resetModules()` between the imports).
 *
 * jsdom gives a test file ONE window and ONE sessionStorage: two module
 * copies would read each other's not-remembered pair (in a browser it is one
 * tab's own), and no `storage` event would ever reach either (a browser fires
 * one in every OTHER tab for each change of localStorage). Code that runs as
 * a tab here — its module copy, the timers it sets, the promises it chains,
 * the messages and events delivered to it — sees instead:
 *
 * - its own sessionStorage, a copy of the page's taken when the tab opens (a
 *   duplicated or restored tab starts with a copy of its opener's);
 * - the origin's one localStorage, and for every change another tab (or the
 *   test itself) makes to it, a `storage` event delivered to this tab as a
 *   task, never for a change of its own;
 * - its own window listeners: what its code adds is kept apart from the real
 *   window and called only for this tab's events;
 * - the BroadcastChannel and the Web Lock of `channel` and `locks`, which
 *   deliver and grant in the context of the tab they are for.
 *
 * A tab is told apart by an AsyncLocalStorage context: carried through
 * promises natively, and through timers by wrapping `setTimeout` and
 * `setInterval` (fake timers call back in the context of whoever advances the
 * clock). The wrap is put back on top of whatever timers are current each
 * time a tab is entered, so `vi.useFakeTimers()` before or after opening
 * tabs both work.
 */

interface TabContext {
  readonly tab: BrowserTab;
}

const contexts = new AsyncLocalStorage<TabContext>();

/** The tab whose code is running now, if any. */
function currentTab(): BrowserTab | null {
  return contexts.getStore()?.tab ?? null;
}

/** A Storage of one tab's own (its sessionStorage). */
class TabStorage implements Storage {
  [name: string]: unknown;
  private readonly items = new Map<string, string>();

  constructor(from?: Storage) {
    if (!from) return;
    for (let i = 0; i < from.length; i++) {
      const key = from.key(i);
      if (key !== null) this.items.set(key, from.getItem(key) ?? '');
    }
  }

  get length(): number {
    return this.items.size;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.items.has(key) ? this.items.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  clear(): void {
    this.items.clear();
  }
}

type AnyListener = EventListenerOrEventListenerObject;

export interface BrowserTab {
  readonly name: string;
  /** This tab's own sessionStorage. */
  readonly sessionStorage: Storage;
  /** Run `fn` as this tab's code. */
  run<T>(fn: () => T): T;
  /** A module whose functions run as this tab's code when the test calls them. */
  bind<M extends object>(module: M): M;
  /** The listeners of `type` this tab's code holds on its window now. */
  listenerCount(type: string): number;
  /** Times this tab's code added a listener it already held (a browser ignores the second; it is a fault here). */
  readonly duplicateAdds: number;
  /** Deliver `event` to this tab's window listeners, as this tab's code. */
  dispatch(event: Event): void;
  /** The tab is closed: nothing is delivered to it any more. */
  close(): void;
  readonly closed: boolean;
}

/** The part of BroadcastChannel the session storage uses (services/tokenStorage.ts SessionChannel). */
export interface TabChannel {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

/** The part of the Web Locks API the renewal uses (services/session.ts RefreshLockManager). */
export interface TabLocks {
  request(name: string, options: { mode: 'exclusive'; signal: AbortSignal }, callback: () => Promise<unknown>): Promise<unknown>;
}

export interface Browser {
  /** A new tab, its sessionStorage a copy of what the page's holds now. */
  openTab(name: string): BrowserTab;
  /** The tabs open now. */
  readonly tabs: readonly BrowserTab[];
  /** A BroadcastChannel factory: each channel belongs to the tab that opens it, and reaches every other tab's. */
  readonly channel: () => TabChannel;
  /** One exclusive lock shared by the tabs: FIFO, honouring the abort signal while waiting, granted as the requesting tab. */
  locks(): TabLocks;
  /** Close every tab and undo every patch. */
  dispose(): void;
}

/** A timer function wrapped so its callback runs in the context it was set from. */
const WRAPPED = Symbol('browserTabs.wrapped');
type TimerFn = ((handler: unknown, timeout?: number, ...args: unknown[]) => unknown) & { [WRAPPED]?: TimerFn };

function wrapTimer(name: 'setTimeout' | 'setInterval'): void {
  const scope = globalThis as unknown as Record<string, TimerFn>;
  const current = scope[name];
  if (current[WRAPPED]) return;
  const wrapper: TimerFn = function (this: unknown, handler: unknown, timeout?: number, ...args: unknown[]) {
    const context = contexts.getStore();
    const callback = typeof handler === 'function' && context
      ? (...callArgs: unknown[]) => contexts.run(context, () => (handler as (...a: unknown[]) => unknown)(...callArgs))
      : handler;
    return current.call(this, callback, timeout, ...args);
  };
  wrapper[WRAPPED] = current;
  scope[name] = wrapper;
}

function unwrapTimer(name: 'setTimeout' | 'setInterval'): void {
  const scope = globalThis as unknown as Record<string, TimerFn>;
  const current = scope[name];
  if (current[WRAPPED]) scope[name] = current[WRAPPED]!;
}

function callListener(listener: AnyListener, event: Event): void {
  if (typeof listener === 'function') listener.call(globalThis, event);
  else listener.handleEvent(event);
}

/** Install the tabs of one browser on this test file's jsdom window. One at a time; `dispose()` undoes it. */
export function createBrowser(): Browser {
  const tabs: TabImpl[] = [];
  const pageSessionStorage = globalThis.sessionStorage;
  const sharedLocalStorage = globalThis.localStorage;

  // The page's sessionStorage, or the running tab's own
  const sessionDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get: () => currentTab()?.sessionStorage ?? pageSessionStorage,
  });

  // A listener a tab's code adds is that tab's; the test's own go to the real window
  const addDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener');
  const removeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'removeEventListener');
  const realAdd = globalThis.addEventListener.bind(globalThis);
  const realRemove = globalThis.removeEventListener.bind(globalThis);
  Object.defineProperty(globalThis, 'addEventListener', {
    configurable: true,
    writable: true,
    value: (type: string, listener: AnyListener | null, options?: boolean | AddEventListenerOptions) => {
      const tab = currentTab() as TabImpl | null;
      if (tab) {
        if (listener) tab.add(type, listener);
        return;
      }
      if (listener) realAdd(type, listener, options);
    },
  });
  Object.defineProperty(globalThis, 'removeEventListener', {
    configurable: true,
    writable: true,
    value: (type: string, listener: AnyListener | null, options?: boolean | EventListenerOptions) => {
      const tab = currentTab() as TabImpl | null;
      if (tab) {
        if (listener) tab.remove(type, listener);
        return;
      }
      if (listener) realRemove(type, listener, options);
    },
  });

  /** A task for `tab`, as the browser queues one: later, as that tab's code. */
  function queueFor(tab: TabImpl, work: () => void): void {
    setTimeout(() => {
      if (!tab.closed) tab.run(work);
    }, 0);
  }

  // Every change of the origin's localStorage is told to every OTHER tab
  const proto = Storage.prototype;
  const original = { setItem: proto.setItem, removeItem: proto.removeItem, clear: proto.clear };
  function announce(key: string | null, oldValue: string | null, newValue: string | null): void {
    const writer = currentTab();
    for (const tab of tabs) {
      if (tab === writer || tab.closed) continue;
      queueFor(tab, () => tab.dispatch(new StorageEvent('storage', { key, oldValue, newValue, storageArea: sharedLocalStorage })));
    }
  }
  proto.setItem = function setItem(this: Storage, key: string, value: string) {
    if (this !== sharedLocalStorage) return original.setItem.call(this, key, value);
    const before = this.getItem(key);
    original.setItem.call(this, key, value);
    const after = this.getItem(key);
    if (before !== after) announce(key, before, after);
  };
  proto.removeItem = function removeItem(this: Storage, key: string) {
    if (this !== sharedLocalStorage) return original.removeItem.call(this, key);
    const before = this.getItem(key);
    original.removeItem.call(this, key);
    if (before !== null) announce(key, before, null);
  };
  proto.clear = function clear(this: Storage) {
    if (this !== sharedLocalStorage) return original.clear.call(this);
    const hadItems = this.length > 0;
    original.clear.call(this);
    if (hadItems) announce(null, null, null);
  };

  class TabImpl implements BrowserTab {
    readonly sessionStorage: Storage;
    duplicateAdds = 0;
    closed = false;
    private readonly listeners = new Map<string, AnyListener[]>();
    private readonly context: TabContext = { tab: this };

    constructor(readonly name: string) {
      this.sessionStorage = new TabStorage(pageSessionStorage);
    }

    run<T>(fn: () => T): T {
      wrapTimer('setTimeout');
      wrapTimer('setInterval');
      return contexts.run(this.context, fn);
    }

    bind<M extends object>(module: M): M {
      return new Proxy({} as M, {
        get: (_target, key) => {
          const value = Reflect.get(module, key) as unknown;
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => this.run(() => (value as (...a: unknown[]) => unknown)(...args));
        },
      });
    }

    add(type: string, listener: AnyListener): void {
      const list = this.listeners.get(type) ?? [];
      if (list.includes(listener)) {
        this.duplicateAdds++;
        return;
      }
      list.push(listener);
      this.listeners.set(type, list);
    }

    remove(type: string, listener: AnyListener): void {
      const list = this.listeners.get(type);
      if (!list) return;
      const at = list.indexOf(listener);
      if (at >= 0) list.splice(at, 1);
    }

    listenerCount(type: string): number {
      return this.listeners.get(type)?.length ?? 0;
    }

    dispatch(event: Event): void {
      if (this.closed) return;
      this.run(() => {
        for (const listener of [...(this.listeners.get(event.type) ?? [])]) callListener(listener, event);
      });
    }

    close(): void {
      this.closed = true;
    }
  }

  interface Member extends TabChannel {
    readonly tab: TabImpl;
    open: boolean;
  }
  const members: Member[] = [];

  const channel = (): TabChannel => {
    const tab = currentTab() as TabImpl | null;
    if (!tab) throw new Error('a channel is opened by a tab: call the factory from code that runs as one');
    const own: Member = {
      tab,
      open: true,
      onmessage: null,
      postMessage(message: unknown) {
        if (!own.open) throw new Error('InvalidStateError: the channel is closed');
        for (const other of members) {
          if (other === own || !other.open) continue;
          const data = structuredClone(message);
          queueFor(other.tab, () => {
            if (other.open) other.onmessage?.({ data });
          });
        }
      },
      close() {
        own.open = false;
        const at = members.indexOf(own);
        if (at >= 0) members.splice(at, 1);
      },
    };
    members.push(own);
    return own;
  };

  function locks(): TabLocks {
    const queue: Array<() => void> = [];
    let held = false;
    return {
      request(_name, options, callback) {
        const context = contexts.getStore();
        return new Promise((resolve, reject) => {
          const grant = () => {
            held = true;
            const work = () => Promise.resolve().then(callback);
            (context ? contexts.run(context, work) : work())
              .then(resolve, reject)
              .finally(() => {
                held = false;
                queue.shift()?.();
              });
          };
          options.signal.addEventListener('abort', () => {
            const at = queue.indexOf(grant);
            if (at >= 0) {
              queue.splice(at, 1);
              reject(Object.assign(new Error('The request was aborted'), { name: 'AbortError' }));
            }
          });
          if (held) queue.push(grant);
          else grant();
        });
      },
    };
  }

  return {
    openTab(name: string) {
      const tab = new TabImpl(name);
      tabs.push(tab);
      return tab;
    },
    get tabs() {
      return tabs.filter((tab) => !tab.closed);
    },
    channel,
    locks,
    dispose() {
      for (const tab of tabs) tab.close();
      tabs.length = 0;
      members.length = 0;
      proto.setItem = original.setItem;
      proto.removeItem = original.removeItem;
      proto.clear = original.clear;
      unwrapTimer('setTimeout');
      unwrapTimer('setInterval');
      for (const [key, descriptor] of [['sessionStorage', sessionDescriptor], ['addEventListener', addDescriptor], ['removeEventListener', removeDescriptor]] as const) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
