import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { E2EVault } from '../../services/e2e/vault';
import type { PickleKeyProvider } from '../../services/e2e/vault';

/**
 * A hidden page can have its IndexedDB connection closed by the browser — Chrome
 * and WebView2 freeze or discard backgrounded pages, and the Tauri window does
 * the same when hidden. The handle is still in hand, but every `transaction()`
 * on it throws InvalidStateError from then on.
 *
 * Before this, the vault held that dead handle forever: after one hide/restore,
 * every read failed until the app was reloaded. What the user saw was "Failed to
 * load conversations" on returning to the app, because the encrypted previews
 * are read through here.
 */

let n = 0;
function makeVault() {
  n++;
  const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  const provider: PickleKeyProvider = {
    load: async () => key,
    save: async () => {},
  };
  return new E2EVault(`user-${n}`, provider, `reopen-${n}`);
}

describe('vault survives the browser closing its connection', () => {
  it('reopens and serves the read that found the connection gone', async () => {
    const vault = makeVault();
    await vault.open();
    await vault.putPlaintext('m1', { conversationId: 'c1', text: 'hello from before the window was hidden' });

    // What the browser does to a backgrounded page: the connection goes away
    // without the vault being told to close.
    (vault as unknown as { db: IDBDatabase | null }).db!.close();

    expect((await vault.getPlaintext('m1'))?.text).toBe('hello from before the window was hidden');
  });

  it('reopens for writes too, so nothing is silently dropped', async () => {
    const vault = makeVault();
    await vault.open();
    (vault as unknown as { db: IDBDatabase | null }).db!.close();

    await vault.putPlaintext('m2', { conversationId: 'c1', text: 'written after the connection died' });

    expect((await vault.getPlaintext('m2'))?.text).toBe('written after the connection died');
  });

  it('keeps working across repeated hide/restore cycles', async () => {
    // The reported symptom recurred every time the window was hidden, so once
    // is not enough — the recovery must not be a one-shot.
    const vault = makeVault();
    await vault.open();
    await vault.putPlaintext('m3', { conversationId: 'c1', text: 'durable' });

    for (let i = 0; i < 3; i++) {
      (vault as unknown as { db: IDBDatabase | null }).db!.close();
      expect((await vault.getPlaintext('m3'))?.text).toBe('durable');
    }
  });

  it('drops the handle when the browser fires onclose', async () => {
    const vault = makeVault();
    await vault.open();
    const internals = vault as unknown as { db: IDBDatabase | null };
    const db = internals.db!;

    // Invoked directly rather than dispatched: fake-indexeddb does not route a
    // synthetic 'close' event to the on-property, and what matters here is that
    // OUR handler releases the reference, not that the shim re-emits events.
    expect(typeof db.onclose).toBe('function');
    db.onclose!(new Event('close'));

    expect(internals.db).toBeNull();
    // and the next access transparently reopens
    await vault.putPlaintext('m4', { conversationId: 'c1', text: 'after onclose' });
    expect((await vault.getPlaintext('m4'))?.text).toBe('after onclose');
  });
});
