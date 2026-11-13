import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { E2EVault } from '../../services/e2e/vault';
import type { PickleKeyProvider } from '../../services/e2e/vault';

// The acknowledgements a device owes the server for claimed key shares
// (docs/e2e-dm-spec.md §12.3): `pka:{shareId}` entries, ids only, kept apart
// from the kept shares themselves (`pks:`).

let n = 0;
function makeVault() {
  n++;
  const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
  const provider: PickleKeyProvider = { load: async () => key, save: async () => {} };
  return new E2EVault(`acks-user-${n}`, provider, `acks-${n}`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('owed key-share acknowledgements in the vault', () => {
  it('keeps each owed acknowledgement as the share id and when it was noted, nothing else', async () => {
    const vault = makeVault();
    await vault.open();
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    await vault.putShareAck('cmkeyshare000000000001');
    await vault.putShareAck('cmkeyshare000000000002');
    await vault.putShareAck('cmkeyshare000000000001'); // noted twice: one entry

    expect(await vault.listShareAcks()).toEqual([
      { id: 'cmkeyshare000000000001', at: 1_700_000_000_000 },
      { id: 'cmkeyshare000000000002', at: 1_700_000_000_000 },
    ]);
    vault.close();
  });

  it('forgets exactly the confirmed ones, in one call', async () => {
    const vault = makeVault();
    await vault.open();
    for (const id of ['cmkeyshare000000000001', 'cmkeyshare000000000002', 'cmkeyshare000000000003']) {
      await vault.putShareAck(id);
    }
    await vault.deleteShareAcks(['cmkeyshare000000000001', 'cmkeyshare000000000003', 'cmkeyshare-never-noted']);
    expect((await vault.listShareAcks()).map((a) => a.id)).toEqual(['cmkeyshare000000000002']);
    await vault.deleteShareAcks([]); // nothing to forget: no transaction, no error
    vault.close();
  });

  it('never mixes owed acknowledgements with kept shares', async () => {
    const vault = makeVault();
    await vault.open();
    await vault.putPendingShares([
      { key: 'pks:2026-11-11T10:00:00.000Z|cmkeyshare000000000009', record: { share: { id: 'cmkeyshare000000000009' }, attempts: 0, receivedAt: 1, leased: true } },
    ]);
    await vault.putShareAck('cmkeyshare000000000001');

    expect((await vault.listPendingShares()).map((p) => p.key)).toEqual(['pks:2026-11-11T10:00:00.000Z|cmkeyshare000000000009']);
    expect((await vault.listShareAcks()).map((a) => a.id)).toEqual(['cmkeyshare000000000001']);
    vault.close();
  });
});
