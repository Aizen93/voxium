import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), delete: vi.fn() },
  server: { updateMany: vi.fn(), findMany: vi.fn() },
  serverMember: { findMany: vi.fn() },
  // The member rows are deleted with RETURNING server_id inside the transaction
  $queryRaw: vi.fn(),
  serverJoinRequest: { findMany: vi.fn() },
  messageAttachment: { findMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('../../utils/prisma', () => ({ prisma: prismaMock }));

const purgeE2E = vi.hoisted(() => vi.fn());
vi.mock('../../utils/e2ePurge', () => ({ purgeE2EMaterial: (...a: unknown[]) => purgeE2E(...a) }));
const removeSecure = vi.hoisted(() => vi.fn());
const announceSecure = vi.hoisted(() => vi.fn());
vi.mock('../../utils/secureChannelLifecycle', () => ({
  removeSecureMembershipsInTx: (...a: unknown[]) => removeSecure(...a),
  announceSecureMembershipsRemoved: (...a: unknown[]) => announceSecure(...a),
}));
const memberLeft = vi.hoisted(() => vi.fn());
vi.mock('../../utils/memberBroadcast', () => ({ broadcastMemberLeft: (...a: unknown[]) => memberLeft(...a) }));
const deleteFromS3 = vi.hoisted(() => vi.fn());
const deleteMultipleFromS3 = vi.hoisted(() => vi.fn());
vi.mock('../../utils/s3', () => ({
  deleteFromS3: (...a: unknown[]) => deleteFromS3(...a),
  deleteMultipleFromS3: (...a: unknown[]) => deleteMultipleFromS3(...a),
  VALID_ATTACHMENT_KEY_RE: /^attachments\/(ch|dm)-[\w-]+\/[\w]+-[\w][\w.-]*$/,
}));
const emitMods = vi.hoisted(() => vi.fn());
vi.mock('../../utils/moderatorAudience', () => ({ emitToModerators: (...a: unknown[]) => emitMods(...a) }));
// The direct conversations step (its statements are tested in
// conversationLifecycle.test.ts and on a real database): here its place in
// the transaction, the flag it is given and what follows its commit
const settle = vi.hoisted(() => vi.fn());
vi.mock('../../utils/conversationLifecycle', () => ({ settleConversationsOfDeletedAccount: (...a: unknown[]) => settle(...a) }));
const flag = vi.hoisted(() => vi.fn());
vi.mock('../../utils/featureFlags', () => ({ isFeatureEnabled: (...a: unknown[]) => flag(...a) }));
const endCall = vi.hoisted(() => vi.fn());
vi.mock('../../websocket/dmVoiceHandler', () => ({ endDMCall: (...a: unknown[]) => endCall(...a) }));

const io = vi.hoisted(() => {
  const emit = vi.fn();
  const disconnectSockets = vi.fn();
  const localDisconnectSockets = vi.fn();
  const socketsLeave = vi.fn();
  const localSocketsLeave = vi.fn();
  return {
    emit,
    disconnectSockets,
    localDisconnectSockets,
    socketsLeave,
    localSocketsLeave,
    to: vi.fn(() => ({ emit })),
    in: vi.fn(() => ({ disconnectSockets, socketsLeave })),
    local: { in: vi.fn(() => ({ disconnectSockets: localDisconnectSockets, socketsLeave: localSocketsLeave })) },
  };
});
vi.mock('../../websocket/socketServer', () => ({ getIO: () => io }));

import { deleteUserAccount } from '../../utils/accountDeletion';
import { lazyStatement } from '../helpers/lazyStatement';
import { OwnedServersError } from '../../utils/errors';

const order: string[] = [];
// The transaction's own client gets a space-update spy of its own: the delete
// transaction must never touch a space row (the counts move after the commit,
// on the shared client)
const txSpaceUpdate = vi.fn();
// The second delete of the account's device-registry row, under the account
// row lock: recorded when it RUNS (a dropped await would remove it silently)
const txRegistryDelete = vi.fn();
const SECURE_REMOVAL = {
  userId: 'u-1',
  deleted: [{ channelId: 'sec-own', serverId: 's-1', memberIds: ['u-1', 'u-2'] }],
  left: [{ channelId: 'sec-other', serverId: 's-2' }],
};

let memberDeletes = 0;
let lateJoins: Array<{ server_id: string }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  prismaMock.user.findUnique.mockResolvedValue({ id: 'u-1', avatarUrl: 'avatars/u-1.webp', ownedServers: [] });
  prismaMock.serverMember.findMany.mockResolvedValue([{ serverId: 's-1' }, { serverId: 's-2' }]);
  prismaMock.serverJoinRequest.findMany.mockResolvedValue([]);
  memberLeft.mockImplementation(async (_u: string, s: string) => { order.push(`left:${s}`); });
  io.localDisconnectSockets.mockImplementation(() => { order.push('disconnect:local'); });
  io.disconnectSockets.mockImplementation(() => { order.push('disconnect'); });
  io.emit.mockImplementation(() => { order.push('force:logout'); });
  // the transaction's raw statements: the first member-row delete, the
  // account row lock, the second member-row delete (each attempt from the start)
  memberDeletes = 0;
  prismaMock.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (/FROM users/.test(sql)) { order.push('lock:account'); return [{ id: 'u-1' }]; }
    if (memberDeletes++ % 2 === 0) { order.push('memberships'); return [{ server_id: 's-1' }, { server_id: 's-2' }]; }
    order.push('memberships:since');
    return lateJoins;
  });
  lateJoins = [];
  removeSecure.mockImplementation(async () => { order.push('secure'); return SECURE_REMOVAL; });
  announceSecure.mockImplementation(async () => { order.push('secure:notices'); });
  purgeE2E.mockImplementation(async () => { order.push('e2e'); });
  txRegistryDelete.mockImplementation(() => lazyStatement(order, 'registry:since', { count: 0 }));
  prismaMock.user.delete.mockImplementation(async () => { order.push('delete'); return {}; });
  // one statement per space, after the commit: named by its space in the order log
  prismaMock.server.updateMany.mockImplementation(async (args: { where: { id: unknown } }) => { order.push(`count:${String(args.where.id)}`); return { count: 1 }; });
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
    order.push('txn:start');
    const result = await fn({
      user: prismaMock.user,
      server: { updateMany: txSpaceUpdate },
      serverMember: prismaMock.serverMember,
      e2EDeviceRegistry: { deleteMany: txRegistryDelete },
      $queryRaw: prismaMock.$queryRaw,
    });
    order.push('txn:end');
    return result;
  });
  deleteFromS3.mockImplementation(async () => { order.push('s3'); });
  prismaMock.messageAttachment.findMany.mockImplementation(async () => { order.push('attachment-keys'); return []; });
  deleteMultipleFromS3.mockImplementation(async (keys: string[]) => { order.push('s3:attachments'); return keys.length; });
  settle.mockImplementation(() => lazyStatement(order, 'conversations', { kept: [], deleted: [], attachmentKeys: [] }));
  flag.mockImplementation((name: string) => { order.push(`flag:${name}`); return false; });
  endCall.mockImplementation(async () => []);
  io.to.mockImplementation(() => ({ emit: io.emit }));
  io.socketsLeave.mockReset();
  io.localSocketsLeave.mockReset();
});

describe('deleteUserAccount', () => {
  it('runs the steps in the order that keeps each one safe', async () => {
    await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

    // members told and sessions ended before anything is purged; the E2E
    // purge and the row delete share one transaction; the avatar blob goes
    // only AFTER the row (a failed delete must not strand a live account
    // without its avatar)
    expect(order.filter((step) => !step.startsWith('count:'))).toEqual([
      'left:s-1', 'left:s-2', 'force:logout', 'disconnect:local', 'disconnect',
      'flag:account_deletion_keeps_conversations',
      'attachment-keys', 'attachment-keys',
      'txn:start', 'memberships', 'secure', 'e2e', 'lock:account', 'memberships:since', 'registry:since', 'conversations', 'delete', 'txn:end',
      'force:logout', 'disconnect:local', 'disconnect', 'secure:notices', 's3',
    ]);
    // the member counts move once the transaction has committed, a space at a
    // time, beside the steps above (nothing waits for them)
    await vi.waitFor(() => expect(order).toContain('count:s-2'));
    expect(order.indexOf('count:s-1')).toBeGreaterThan(order.indexOf('txn:end'));
    expect(order.indexOf('count:s-2')).toBeGreaterThan(order.indexOf('count:s-1'));
    expect(purgeE2E).toHaveBeenCalledWith('u-1', expect.objectContaining({ user: prismaMock.user }));
    expect(prismaMock.user.delete).toHaveBeenCalledWith({ where: { id: 'u-1' } });
    expect(deleteFromS3).toHaveBeenCalledWith('avatars/u-1.webp');
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 60_000, maxWait: 10_000 });
  });

  it('removes the memberships, then the secure-channel state, inside the delete transaction and on its client', async () => {
    await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

    const [sql, ...values] = prismaMock.$queryRaw.mock.calls[0];
    expect((sql as string[]).join('?')).toMatch(/DELETE FROM server_members WHERE user_id = \? RETURNING server_id/);
    expect(values).toEqual(['u-1']);
    // Every space at once (no space argument), on the transaction's client
    expect(removeSecure).toHaveBeenCalledWith(expect.objectContaining({ $queryRaw: prismaMock.$queryRaw }), 'u-1');
    // The member rows before the secure channels: the lock order every writer
    // of a secure-channel row takes them in
    expect(order.indexOf('memberships')).toBeLessThan(order.indexOf('secure'));
    expect(order.indexOf('secure')).toBeLessThan(order.indexOf('delete'));
  });

  it('purges the key shares and the rest of the E2E material AFTER the secure channels are locked, before the user delete', async () => {
    await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

    // A removal from one secure channel locks the channel, then deletes the
    // key shares addressed to the member there: purged first, a share that
    // removal waits for was held while this transaction waited for its channel
    expect(order.indexOf('secure')).toBeLessThan(order.indexOf('e2e'));
    expect(order.indexOf('e2e')).toBeLessThan(order.indexOf('delete'));
    // on the transaction's client, inside it
    expect(purgeE2E).toHaveBeenCalledWith('u-1', expect.objectContaining({ $queryRaw: prismaMock.$queryRaw }));
    expect(order.indexOf('e2e')).toBeLessThan(order.indexOf('txn:end'));
  });

  describe('a device registry row committed after the E2E purge (the account registering its first device meanwhile)', () => {
    // A registration takes the account row first and the registry row last;
    // its device rows have a key to the account and go with the user delete,
    // its registry row has none. Under the account row lock no registration
    // can write it again, so the second delete there covers the window.
    it('is deleted a second time under the account row lock, before the user delete (recorded when each statement runs)', async () => {
      let deletes = 0;
      prismaMock.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
        if (/FROM users/.test(strings.join('?'))) return lazyStatement(order, 'lock:account', [{ id: 'u-1' }]);
        const first = deletes++ === 0;
        return lazyStatement(order, first ? 'memberships' : 'memberships:since', first ? [{ server_id: 's-1' }, { server_id: 's-2' }] : []);
      });
      prismaMock.user.delete.mockImplementation(() => lazyStatement(order, 'delete', {}));

      await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

      const inTx = order.slice(order.indexOf('txn:start') + 1, order.indexOf('txn:end'));
      expect(inTx).toEqual(['memberships', 'secure', 'e2e', 'lock:account', 'memberships:since', 'registry:since', 'conversations', 'delete']);
      expect(txRegistryDelete).toHaveBeenCalledTimes(1);
      expect(txRegistryDelete).toHaveBeenCalledWith({ where: { userId: 'u-1' } });
    });

    it('an attempt aborted on the user delete is run again whole, the second registry delete included', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      prismaMock.user.delete.mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: 'P2034' }));
      try {
        await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

        expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
        expect(txRegistryDelete).toHaveBeenCalledTimes(2);
        // the committed attempt: account row, member rows since, registry row, user delete
        const lastAttempt = order.slice(order.lastIndexOf('txn:start') + 1, order.lastIndexOf('txn:end'));
        expect(lastAttempt).toEqual(['memberships', 'secure', 'e2e', 'lock:account', 'memberships:since', 'registry:since', 'conversations', 'delete']);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('a membership committed after the first member-row delete (the account joining a space meanwhile)', () => {
    it('is deleted under the account row lock right before the user delete, then counted and announced after the commit', async () => {
      lateJoins = [{ server_id: 's-3' }];

      await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });
      await vi.waitFor(() => expect(order).toContain('count:s-3'));

      // the account row first, then the second delete, then the user delete
      expect(order.indexOf('e2e')).toBeLessThan(order.indexOf('lock:account'));
      expect(order.indexOf('lock:account')).toBeLessThan(order.indexOf('memberships:since'));
      expect(order.indexOf('memberships:since')).toBeLessThan(order.indexOf('delete'));
      const sqls = (prismaMock.$queryRaw.mock.calls as unknown as Array<[string[], ...unknown[]]>).map(([s, ...v]) => [s.join('?').replace(/\s+/g, ' ').trim(), v]);
      expect(sqls[1]).toEqual(['SELECT id FROM users WHERE id = ? FOR UPDATE', ['u-1']]);
      expect(sqls[2]).toEqual(['DELETE FROM server_members WHERE user_id = ? RETURNING server_id', ['u-1']]);
      // its members hear the departure once the delete has committed, and its count moves
      expect(order.indexOf('left:s-3')).toBeGreaterThan(order.indexOf('txn:end'));
      expect(order.filter((s) => s === 'left:s-3')).toHaveLength(1);
      expect(prismaMock.server.updateMany).toHaveBeenCalledWith({ where: { id: 's-3', memberCount: { gt: 0 } }, data: { memberCount: { decrement: 1 } } });
      // the spaces of the first delete are counted once and were announced before the transaction
      expect(prismaMock.server.updateMany).toHaveBeenCalledTimes(3);
      expect(order.indexOf('left:s-1')).toBeLessThan(order.indexOf('txn:start'));
    });

    it('a membership the earlier read missed and the first delete removed is announced after the commit, once', async () => {
      // read before the transaction: s-1 and s-2; a join to s-4 committed
      // before the first member-row delete, which removes it with the others
      prismaMock.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
        const sql = strings.join('?');
        if (/FROM users/.test(sql)) { order.push('lock:account'); return [{ id: 'u-1' }]; }
        if (memberDeletes++ % 2 === 0) { order.push('memberships'); return [{ server_id: 's-1' }, { server_id: 's-2' }, { server_id: 's-4' }]; }
        order.push('memberships:since');
        return [];
      });

      await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });
      await vi.waitFor(() => expect(order).toContain('count:s-4'));

      expect(order.filter((s) => s === 'left:s-4')).toHaveLength(1);
      expect(order.indexOf('left:s-4')).toBeGreaterThan(order.indexOf('txn:end'));
      // the spaces announced before the transaction are not announced again
      expect(order.filter((s) => s === 'left:s-1')).toHaveLength(1);
      expect(order.filter((s) => s === 'left:s-2')).toHaveLength(1);
      expect(memberLeft).toHaveBeenCalledTimes(3);
    });

    it('nothing joined meanwhile: no second announcement, no extra count', async () => {
      await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });
      await vi.waitFor(() => expect(prismaMock.server.updateMany).toHaveBeenCalledTimes(2));
      expect(memberLeft).toHaveBeenCalledTimes(2);
    });

    it('a departure notice that fails after the commit is logged; the deletion still completes', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      lateJoins = [{ server_id: 's-3' }];
      memberLeft.mockImplementation(async (_u: string, s: string) => {
        order.push(`left:${s}`);
        if (s === 's-3') throw new Error('socket layer down');
      });
      try {
        await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith('[T] After the deletion of account u-1, the departure notice in space s-3 failed:', 'socket layer down');
        expect(deleteFromS3).toHaveBeenCalledWith('avatars/u-1.webp');
        expect(announceSecure).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('the member counts of the spaces the account was in', () => {
    const countUpdate = (serverId: string) => ({
      where: { id: serverId, memberCount: { gt: 0 } },
      data: { memberCount: { decrement: 1 } },
    });

    it('the delete transaction touches no space row: the user delete is its last statement and the counts move after the commit, on the shared client', async () => {
      // The count update locks the row of every space the account was in,
      // which every join, creation, kick and transfer there also takes. Inside
      // the transaction it was held through the user delete's cascade (ahead
      // of it) or closed a cycle with those transactions (behind it).
      const txOrder: string[] = [];
      let deletes = 0;
      const tx = {
        $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
          if (/FROM users/.test(strings.join('?'))) { txOrder.push('lock:account'); return [{ id: 'u-1' }]; }
          if (deletes++ === 0) { txOrder.push('memberships'); return [{ server_id: 's-1' }, { server_id: 's-2' }]; }
          txOrder.push('memberships:since');
          return [];
        }),
        user: { delete: vi.fn(async () => { txOrder.push('delete'); return {}; }) },
        server: { updateMany: vi.fn(), update: vi.fn() },
        e2EDeviceRegistry: { deleteMany: vi.fn(() => lazyStatement(txOrder, 'registry:since', { count: 0 })) },
        $executeRaw: vi.fn(),
      };
      removeSecure.mockImplementation(async () => { txOrder.push('secure'); return SECURE_REMOVAL; });
      purgeE2E.mockImplementation(async () => { txOrder.push('e2e'); });
      let committed = false;
      prismaMock.$transaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => {
        const result = await fn(tx);
        committed = true;
        return result;
      });
      const committedAtCountUpdate: boolean[] = [];
      prismaMock.server.updateMany.mockImplementation(async () => { committedAtCountUpdate.push(committed); return { count: 1 }; });

      await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });
      await vi.waitFor(() => expect(prismaMock.server.updateMany).toHaveBeenCalledTimes(2));

      expect(txOrder).toEqual(['memberships', 'secure', 'e2e', 'lock:account', 'memberships:since', 'registry:since', 'delete']);
      // the conversations step runs on the transaction's own client (it names no space either)
      expect(settle).toHaveBeenCalledWith(tx, 'u-1', { keep: false });
      expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: 'u-1' } });
      expect(tx.server.updateMany).not.toHaveBeenCalled();
      expect(tx.server.update).not.toHaveBeenCalled();
      expect(tx.$executeRaw).not.toHaveBeenCalled();
      // the statements of the transaction's client that are raw SQL name no space
      expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
      for (const [strings] of tx.$queryRaw.mock.calls as unknown as Array<[string[]]>) {
        expect(strings.join('?')).not.toMatch(/\bservers\b/);
      }
      expect(prismaMock.server.updateMany).toHaveBeenNthCalledWith(1, countUpdate('s-1'));
      expect(prismaMock.server.updateMany).toHaveBeenNthCalledWith(2, countUpdate('s-2'));
      expect(committedAtCountUpdate).toEqual([true, true]);
    });

    it('lowers ONE space per statement, one after the other: a statement over several rows would keep the rows it has updated locked while it waits for the next', async () => {
      let releaseFirst!: () => void;
      prismaMock.server.updateMany
        .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = () => resolve({ count: 1 }); }))
        .mockResolvedValue({ count: 1 });

      await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

      // the first space's row is held elsewhere: its statement waits, and the
      // second space has not been touched (no lock taken on it meanwhile)
      expect(prismaMock.server.updateMany).toHaveBeenCalledTimes(1);
      expect(prismaMock.server.updateMany).toHaveBeenCalledWith(countUpdate('s-1'));
      releaseFirst();
      await vi.waitFor(() => expect(prismaMock.server.updateMany).toHaveBeenCalledTimes(2));
      expect(prismaMock.server.updateMany).toHaveBeenLastCalledWith(countUpdate('s-2'));
      // never a statement over several spaces
      for (const [args] of prismaMock.server.updateMany.mock.calls as Array<[{ where: { id: unknown } }]>) {
        expect(typeof args.where.id).toBe('string');
      }
    });

    it('a count update that waits (a space delete holds that row) holds up nothing that follows the commit', async () => {
      // never answers: the second revocation, the notices and the avatar must not wait for it
      prismaMock.server.updateMany.mockImplementation(() => { order.push('counts'); return new Promise(() => {}); });

      await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).resolves.toBeUndefined();

      expect(order.slice(order.indexOf('txn:end'))).toEqual([
        'txn:end', 'counts', 'force:logout', 'disconnect:local', 'disconnect', 'secure:notices', 's3',
      ]);
    });

    it('a count update that fails is logged and the deletion still completes (the nightly recount corrects the figure)', async () => {
      prismaMock.server.updateMany.mockRejectedValue(new Error('db gone'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).resolves.toBeUndefined();

        await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
          '[Accounts] The member count of 2 of 2 space(s) was not lowered after the deletion of account u-1 (the nightly recount corrects it):', 'db gone'));
        // one warning for the pass, and never a second try (the recount is the backstop)
        expect(warn).toHaveBeenCalledTimes(1);
        expect(prismaMock.server.updateMany).toHaveBeenCalledTimes(2);
        expect(announceSecure).toHaveBeenCalledWith(SECURE_REMOVAL);
        expect(deleteFromS3).toHaveBeenCalledWith('avatars/u-1.webp');
      } finally {
        warn.mockRestore();
      }
    });

    it('a space whose count update fails does not stop the next one', async () => {
      prismaMock.server.updateMany
        .mockRejectedValueOnce(new Error('canceling statement due to lock timeout'))
        .mockResolvedValue({ count: 1 });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

        await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
          '[Accounts] The member count of 1 of 2 space(s) was not lowered after the deletion of account u-1 (the nightly recount corrects it):',
          'canceling statement due to lock timeout'));
        expect(prismaMock.server.updateMany).toHaveBeenNthCalledWith(1, countUpdate('s-1'));
        expect(prismaMock.server.updateMany).toHaveBeenNthCalledWith(2, countUpdate('s-2'));
      } finally {
        warn.mockRestore();
      }
    });

    it('no count moves when the delete fails: the memberships are still there', async () => {
      prismaMock.$transaction.mockRejectedValue(new Error('db gone'));

      await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).rejects.toThrow('db gone');

      expect(prismaMock.server.updateMany).not.toHaveBeenCalled();
    });

    it('no count moves when the account came to own a space and the deletion is refused', async () => {
      prismaMock.$transaction.mockRejectedValue(Object.assign(
        new Error('Foreign key constraint violated on the constraint: `servers_owner_id_fkey`'),
        { code: 'P2003' },
      ));
      prismaMock.server.findMany.mockResolvedValue([{ id: 's-9', name: 'Handed over' }]);

      await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).rejects.toBeInstanceOf(OwnedServersError);

      expect(prismaMock.server.updateMany).not.toHaveBeenCalled();
    });
  });

  it('announces the secure-channel removal only after the delete committed', async () => {
    await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

    expect(announceSecure).toHaveBeenCalledWith(SECURE_REMOVAL);
    expect(order.indexOf('secure:notices')).toBeGreaterThan(order.indexOf('txn:end'));
  });

  it('a secure-channel step that throws fails the deletion: the account survives and nothing is announced', async () => {
    removeSecure.mockRejectedValue(new Error('channel delete failed'));
    prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ user: prismaMock.user, server: prismaMock.server, serverMember: prismaMock.serverMember, $queryRaw: prismaMock.$queryRaw }));

    await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).rejects.toThrow('channel delete failed');

    expect(prismaMock.user.delete).not.toHaveBeenCalled();
    expect(announceSecure).not.toHaveBeenCalled();
    expect(deleteFromS3).not.toHaveBeenCalled();
  });

  describe('a delete transaction PostgreSQL aborted to break a deadlock (a space delete or a transfer to this account)', () => {
    const deadlock = () => Object.assign(new Error('Transaction failed due to a write conflict or a deadlock.'), { code: 'P2034' });

    it('is run again whole: the account is deleted, its notices sent once, the user not left signed out with the account intact', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const real = prismaMock.$transaction.getMockImplementation()!;
      prismaMock.$transaction
        .mockImplementationOnce(async () => { order.push('txn:aborted'); throw deadlock(); })
        .mockImplementation(real);
      try {
        await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).resolves.toBeUndefined();

        expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
        expect(prismaMock.user.delete).toHaveBeenCalledTimes(1);
        expect(announceSecure).toHaveBeenCalledTimes(1);
        expect(order.indexOf('txn:aborted')).toBeLessThan(order.indexOf('txn:start'));
        expect(warn).toHaveBeenCalledWith('[Accounts] The deletion of account u-1 was aborted by a deadlock or a serialization failure; retrying (1 of 2)');
      } finally {
        warn.mockRestore();
      }
    });

    it('a retry that meets a space the account came to own (a transfer to it committed meanwhile) answers 409, not a 500', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      prismaMock.$transaction
        .mockRejectedValueOnce(deadlock())
        .mockRejectedValueOnce(Object.assign(
          new Error('Foreign key constraint violated on the constraint: `servers_owner_id_fkey`'),
          { code: 'P2003' },
        ));
      prismaMock.server.findMany.mockResolvedValue([{ id: 's-9', name: 'Handed over' }]);
      try {
        const refusal = await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' }).catch((e: unknown) => e);

        // the error the self-service route answers with data.ownedServers,
        // which the client's owned-spaces dialog lists
        expect(refusal).toBeInstanceOf(OwnedServersError);
        expect(refusal).toMatchObject({
          statusCode: 409,
          message: 'Transfer or delete the servers you own before deleting your account',
          servers: [{ id: 's-9', name: 'Handed over' }],
        });
        expect(prismaMock.server.findMany).toHaveBeenCalledWith({ where: { ownerId: 'u-1' }, select: { id: true, name: true } });
        expect(announceSecure).not.toHaveBeenCalled();
        expect(deleteFromS3).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('another foreign-key failure is not taken for an owned space', async () => {
      prismaMock.$transaction.mockRejectedValue(Object.assign(new Error('Foreign key constraint violated on the constraint: `other_fkey`'), { code: 'P2003' }));

      await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).rejects.toMatchObject({ code: 'P2003' });
    });

    it('any other failure is not retried', async () => {
      prismaMock.$transaction.mockRejectedValue(new Error('db gone'));

      await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).rejects.toThrow('db gone');
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  it('withdraws the account\'s pending join requests with it: each server\'s moderators hear it, after the delete committed', async () => {
    prismaMock.serverJoinRequest.findMany.mockResolvedValue([{ serverId: 's-7' }]);
    emitMods.mockImplementation(async () => { order.push('request-withdrawn'); });

    await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

    expect(prismaMock.serverJoinRequest.findMany).toHaveBeenCalledWith({ where: { userId: 'u-1', status: 'pending' }, select: { serverId: true } });
    expect(emitMods).toHaveBeenCalledWith('s-7', 'server:join_request_resolved', { serverId: 's-7', userId: 'u-1', outcome: 'cancelled' });
    expect(order.indexOf('request-withdrawn')).toBeGreaterThan(order.indexOf('txn:end'));
  });

  it('ends every live session with a ROOM-filtered disconnect, never the empty-filter form', () => {
    // The empty room filter fans out to every node's entire namespace (see
    // index.ts shutdown) — restarting one node once hung up the cluster.
    return deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' }).then(() => {
      expect(io.local.in).toHaveBeenCalledWith('user:u-1');
      expect(io.localDisconnectSockets).toHaveBeenCalledWith(true);
      expect(io.in).toHaveBeenCalledWith('user:u-1');
      expect(io.disconnectSockets).toHaveBeenCalledWith(true);
      expect(io.to).toHaveBeenCalledWith('user:u-1');
      expect(io.emit).toHaveBeenCalledWith('force:logout', { reason: 'bye' });
    });
  });

  it('ends again, after the delete committed, a session that connected while the row still existed', async () => {
    // A second device's handshake lands between the first revocation and the
    // delete: it joins user:{id} after the first disconnect went out.
    const lateSockets = new Set<string>();
    removeSecure.mockImplementation(async () => { order.push('secure'); lateSockets.add('late-socket'); return SECURE_REMOVAL; });
    io.disconnectSockets.mockImplementation(() => { order.push('disconnect'); lateSockets.clear(); });

    await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

    expect(lateSockets.size).toBe(0);
    const lastDisconnect = order.lastIndexOf('disconnect');
    expect(lastDisconnect).toBeGreaterThan(order.indexOf('txn:end'));
    expect(io.emit).toHaveBeenCalledTimes(2);
    expect(io.emit).toHaveBeenLastCalledWith('force:logout', { reason: 'bye' });
  });

  it('does not run the second revocation when the delete fails (the account survives)', async () => {
    prismaMock.$transaction.mockRejectedValue(new Error('db gone'));

    await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).rejects.toThrow('db gone');
    expect(io.disconnectSockets).toHaveBeenCalledTimes(1);
  });

  it('refuses an account that still owns servers — Server.owner is onDelete: Restrict and the choice is the owner\'s', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u-1', avatarUrl: null, ownedServers: [{ id: 's-owned' }] });

    await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).rejects.toThrow(/still owns servers/);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(io.disconnectSockets).not.toHaveBeenCalled();
    expect(io.localDisconnectSockets).not.toHaveBeenCalled();
  });

  it('keeps the avatar when the delete fails, and surfaces the error', async () => {
    prismaMock.$transaction.mockRejectedValue(new Error('db gone'));

    await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).rejects.toThrow('db gone');
    expect(deleteFromS3).not.toHaveBeenCalled();
  });

  it('decrements the inline member count of every server the account belonged to, never inside the delete transaction', async () => {
    await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

    // The transaction removes the memberships; the directory's live member
    // count (server discovery) follows its commit, guarded so drift can never
    // push it negative.
    await vi.waitFor(() => expect(prismaMock.server.updateMany).toHaveBeenCalledTimes(2));
    expect(prismaMock.server.updateMany).toHaveBeenCalledWith({
      where: { id: 's-1', memberCount: { gt: 0 } },
      data: { memberCount: { decrement: 1 } },
    });
    expect(prismaMock.server.updateMany).toHaveBeenCalledWith({
      where: { id: 's-2', memberCount: { gt: 0 } },
      data: { memberCount: { decrement: 1 } },
    });
    expect(txSpaceUpdate).not.toHaveBeenCalled();
  });

  it('skips the count update when the account was a member of nothing', async () => {
    prismaMock.serverMember.findMany.mockResolvedValue([]);
    // no member row anywhere; the account row is there
    prismaMock.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => (/FROM users/.test(strings.join('?')) ? [{ id: 'u-1' }] : []));
    await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });
    expect(prismaMock.server.updateMany).not.toHaveBeenCalled();
  });

  it('counts the spaces the committed attempt\'s own delete removed a row from, once, not a list read before the transaction', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // read before the transaction: s-1 and s-2. Between the attempts a join
    // to s-3 committed and a removal from s-2 did
    prismaMock.serverMember.findMany.mockResolvedValue([{ serverId: 's-1' }, { serverId: 's-2' }]);
    // the committed attempt's first member-row delete; its account lock and
    // second delete find nothing more
    prismaMock.$queryRaw.mockResolvedValueOnce([{ server_id: 's-1' }, { server_id: 's-3' }])
      .mockImplementation(async (strings: TemplateStringsArray) => (/FROM users/.test(strings.join('?')) ? [{ id: 'u-1' }] : []));
    const real = prismaMock.$transaction.getMockImplementation()!;
    prismaMock.$transaction
      .mockImplementationOnce(async () => { throw Object.assign(new Error('deadlock'), { code: 'P2034' }); })
      .mockImplementation(real);
    try {
      await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

      await vi.waitFor(() => expect(prismaMock.server.updateMany).toHaveBeenCalledTimes(2));
      const lowered = (prismaMock.server.updateMany.mock.calls as Array<[{ where: { id: string } }]>).map(([args]) => args.where.id);
      // each of the committed attempt's spaces once; s-2 (left between the attempts) never
      expect(lowered).toEqual(['s-1', 's-3']);
      // s-3, joined between the attempts, is announced after the commit, once;
      // s-1 and s-2 were announced before the transaction and are not again
      expect(order.filter((s) => s === 'left:s-3')).toHaveLength(1);
      expect(order.lastIndexOf('left:s-3')).toBeGreaterThan(order.lastIndexOf('txn:end'));
      expect(order.filter((s) => s === 'left:s-1')).toHaveLength(1);
      expect(order.filter((s) => s === 'left:s-2')).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  describe('the attachment files of the messages the delete cascades', () => {
    const OWN = 'attachments/ch-general/clmsg1-photo.png';
    const PEER = 'attachments/dm-conv1/clmsg2-blob.bin';

    it("are read before the transaction, one read per indexed column: the account's own messages and its secure channels, never the other side of its conversations", async () => {
      prismaMock.messageAttachment.findMany.mockImplementation(async () => {
        order.push('attachment-keys');
        return [];
      });

      await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

      const shapes = prismaMock.messageAttachment.findMany.mock.calls.map(([args]: [any]) => args.where);
      expect(shapes).toEqual([
        { expired: false, message: { authorId: 'u-1' } },
        // the secure channels the account created: the transaction deletes them
        { expired: false, message: { channel: { createdById: 'u-1', secure: true } } },
      ]);
      // the other person's files in a conversation: only the transaction knows
      // whether that conversation goes, and reads them under its lock
      expect(JSON.stringify(shapes)).not.toContain('conversation');
      // No OR across the joined tables: it started from no index
      expect(JSON.stringify(shapes)).not.toContain('"OR"');
      // Before the delete transaction takes the rows
      expect(order.lastIndexOf('attachment-keys')).toBeLessThan(order.indexOf('txn:start'));
    });

    it('are deleted only after the delete committed, each file once though two reads found it', async () => {
      // OWN was written by the account in a conversation the transaction
      // deleted: the author read and the transaction's keys both have it
      prismaMock.messageAttachment.findMany
        .mockResolvedValueOnce([{ id: 'att-1', s3Key: OWN }])
        .mockResolvedValueOnce([]);
      settle.mockImplementation(() => lazyStatement(order, 'conversations', { kept: [], deleted: ['conv1'], attachmentKeys: [OWN, PEER] }));

      await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

      expect(deleteMultipleFromS3).toHaveBeenCalledTimes(1);
      expect(deleteMultipleFromS3).toHaveBeenCalledWith([OWN, PEER]);
      expect(order.indexOf('s3:attachments')).toBeGreaterThan(order.indexOf('txn:end'));
    });

    it('a key read that fails is logged and the erasure goes on, deleting the files the other reads found', async () => {
      prismaMock.messageAttachment.findMany
        .mockRejectedValueOnce(new Error('db gone'))
        .mockResolvedValueOnce([{ id: 'att-2', s3Key: PEER }]);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).resolves.toBeUndefined();

        // The sessions were revoked before the read: stopping there would
        // leave the account half erased
        expect(prismaMock.user.delete).toHaveBeenCalledWith({ where: { id: 'u-1' } });
        expect(order.lastIndexOf('disconnect')).toBeGreaterThan(order.indexOf('txn:end'));
        expect(deleteFromS3).toHaveBeenCalledWith('avatars/u-1.webp');
        expect(deleteMultipleFromS3).toHaveBeenCalledWith([PEER]);
        expect(error).toHaveBeenCalledWith(
          "[T] Reading the attachment keys of the account's messages failed (the orphan sweep will reclaim those files):", 'db gone');
      } finally {
        error.mockRestore();
      }
    });

    it('every key read failing still erases the account, with no file delete', async () => {
      prismaMock.messageAttachment.findMany.mockRejectedValue(new Error('db gone'));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).resolves.toBeUndefined();

        expect(prismaMock.user.delete).toHaveBeenCalled();
        expect(deleteMultipleFromS3).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledTimes(2);
      } finally {
        error.mockRestore();
      }
    });

    it('stay when the delete fails (the account and its messages survive)', async () => {
      prismaMock.messageAttachment.findMany.mockResolvedValue([{ id: 'att-1', s3Key: OWN }]);
      prismaMock.$transaction.mockRejectedValue(new Error('db gone'));

      await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).rejects.toThrow('db gone');
      expect(deleteMultipleFromS3).not.toHaveBeenCalled();
    });

    it('a storage failure is logged and the deletion still completes', async () => {
      prismaMock.messageAttachment.findMany.mockResolvedValue([{ id: 'att-1', s3Key: OWN }]);
      deleteMultipleFromS3.mockRejectedValue(new Error('S3 unavailable'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).resolves.toBeUndefined();
        await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
          '[T] Attachment file cleanup failed for a deleted account (the orphan sweep will reclaim them):', 'S3 unavailable'));
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('the direct conversations (#131)', () => {
    const KEPT = { kept: ['conv-kept'], deleted: [], attachmentKeys: ['attachments/dm-conv-kept/own1-encrypted.bin'] };

    it('the flag is read ONCE per deletion, before the transaction, and given to the conversations step of every attempt', async () => {
      flag.mockImplementation((name: string) => { order.push(`flag:${name}`); return true; });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      prismaMock.user.delete.mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: 'P2034' }));
      try {
        await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

        expect(flag).toHaveBeenCalledTimes(1);
        expect(flag).toHaveBeenCalledWith('account_deletion_keeps_conversations');
        expect(order.indexOf('flag:account_deletion_keeps_conversations')).toBeLessThan(order.indexOf('txn:start'));
        // both attempts got the same rule
        expect(settle).toHaveBeenCalledTimes(2);
        for (const call of settle.mock.calls) expect(call.slice(1)).toEqual(['u-1', { keep: true }]);
      } finally {
        warn.mockRestore();
      }
    });

    it('with the flag off the step is told to keep nothing', async () => {
      await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

      expect(settle).toHaveBeenCalledWith(expect.objectContaining({ $queryRaw: prismaMock.$queryRaw }), 'u-1', { keep: false });
    });

    it('the step runs under the account row lock, after the registry delete and right before the user delete (recorded when it runs)', async () => {
      await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

      const inTx = order.slice(order.indexOf('txn:start') + 1, order.indexOf('txn:end'));
      expect(inTx.indexOf('lock:account')).toBeLessThan(inTx.indexOf('conversations'));
      expect(inTx.indexOf('registry:since')).toBeLessThan(inTx.indexOf('conversations'));
      expect(inTx.indexOf('conversations')).toBe(inTx.indexOf('delete') - 1);
    });

    it('the files after the commit: the account\'s own and those of the conversations the COMMITTED attempt deleted, never another attempt\'s', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const OWN = 'attachments/ch-general/clmsg1-photo.png';
      prismaMock.messageAttachment.findMany.mockResolvedValueOnce([{ id: 'att-1', s3Key: OWN }]).mockResolvedValueOnce([]);
      // the first attempt decided to delete conv-a, then was aborted; the
      // committed one kept it (its other person had reopened it meanwhile)
      settle
        .mockImplementationOnce(() => lazyStatement(order, 'conversations', { kept: [], deleted: ['conv-a'], attachmentKeys: ['attachments/dm-conv-a/peer1-encrypted.bin'] }))
        .mockImplementationOnce(() => lazyStatement(order, 'conversations', KEPT));
      prismaMock.user.delete.mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: 'P2034' }));
      try {
        await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

        expect(deleteMultipleFromS3).toHaveBeenCalledTimes(1);
        expect(deleteMultipleFromS3).toHaveBeenCalledWith([OWN, 'attachments/dm-conv-kept/own1-encrypted.bin']);
      } finally {
        warn.mockRestore();
      }
    });

    it('never deletes a file of the other person in a conversation kept for them: the only conversation files are the ones the step names', async () => {
      // a read by conversation would find the other person's file: the
      // deletion must not issue one
      const PEER_IN_KEPT = 'attachments/dm-conv-kept/peer1-encrypted.bin';
      prismaMock.messageAttachment.findMany.mockImplementation(async (args: { where: unknown }) =>
        JSON.stringify(args.where).includes('conversation') ? [{ id: 'att-9', s3Key: PEER_IN_KEPT }] : []);
      settle.mockImplementation(() => lazyStatement(order, 'conversations', KEPT));

      await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

      expect(deleteMultipleFromS3).toHaveBeenCalledWith(['attachments/dm-conv-kept/own1-encrypted.bin']);
      expect(JSON.stringify(deleteMultipleFromS3.mock.calls)).not.toContain(PEER_IN_KEPT);
    });

    it('after the commit: dm:conversation:read_only to each kept conversation\'s room; each deleted one\'s room emptied, local form first; every call left in any of them ended with no notice; no dm:conversation:deleted', async () => {
      settle.mockImplementation(() => lazyStatement(order, 'conversations', { kept: ['conv-k1', 'conv-k2'], deleted: ['conv-d1', 'conv-d2'], attachmentKeys: [] }));
      io.to.mockImplementation((room: string) => ({ emit: (event: string, payload: unknown) => { order.push(`emit:${room}:${event}`); io.emit(event, payload); } }));
      endCall.mockImplementation(async (_io: unknown, conversationId: string) => { order.push(`end call:${conversationId}`); return []; });
      io.localSocketsLeave.mockImplementation(() => { order.push('leave:local'); });
      io.socketsLeave.mockImplementation(() => { order.push('leave:cluster'); });

      await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

      const after = order.slice(order.indexOf('txn:end'));
      // only once the rows are rewritten (after the commit), and after the second revocation
      expect(after.indexOf('emit:dm:conv-k1:dm:conversation:read_only')).toBeGreaterThan(after.lastIndexOf('disconnect'));
      expect(io.emit).toHaveBeenCalledWith('dm:conversation:read_only', { conversationId: 'conv-k1' });
      expect(io.emit).toHaveBeenCalledWith('dm:conversation:read_only', { conversationId: 'conv-k2' });
      expect(io.emit).not.toHaveBeenCalledWith('dm:conversation:read_only', { conversationId: 'conv-d1' });
      expect(io.emit).not.toHaveBeenCalledWith('dm:conversation:deleted', expect.anything());
      expect(endCall.mock.calls.map((c) => [c[1], c[2]])).toEqual([
        // dm:voice:left names each conversation's placeholder, never the deleted account
        ['conv-k1', { notice: false, leftUserId: 'deleted:conv-k1' }], ['conv-k2', { notice: false, leftUserId: 'deleted:conv-k2' }],
        ['conv-d1', { notice: false, leftUserId: 'deleted:conv-d1' }], ['conv-d2', { notice: false, leftUserId: 'deleted:conv-d2' }],
      ]);
      // the deleted rooms, in one operation each form, after the calls ended there
      const rooms = ['dm:conv-d1', 'dm:conv-d2'];
      expect(io.local.in).toHaveBeenCalledWith(rooms);
      expect(io.localSocketsLeave).toHaveBeenCalledWith(rooms);
      expect(io.in).toHaveBeenCalledWith(rooms);
      expect(io.socketsLeave).toHaveBeenCalledWith(rooms);
      expect(after.indexOf('end call:conv-d2')).toBeLessThan(after.indexOf('leave:local'));
      expect(after.indexOf('leave:local')).toBeLessThan(after.indexOf('leave:cluster'));
    });

    it('no conversation: no notice, no call teardown, no room operation', async () => {
      await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' });

      expect(endCall).not.toHaveBeenCalled();
      expect(io.socketsLeave).not.toHaveBeenCalled();
      expect(io.localSocketsLeave).not.toHaveBeenCalled();
      expect(io.emit).not.toHaveBeenCalledWith('dm:conversation:read_only', expect.anything());
    });

    it('each step after the commit that fails is logged and the deletion completes: a notice, a call teardown, a room leave', async () => {
      settle.mockImplementation(() => lazyStatement(order, 'conversations', { kept: ['conv-k1'], deleted: ['conv-d1'], attachmentKeys: [] }));
      io.to.mockImplementation((room: string) => ({
        emit: (event: string, payload: unknown) => {
          if (room === 'dm:conv-k1') throw new Error('adapter down');
          io.emit(event, payload);
        },
      }));
      endCall.mockRejectedValue(new Error('redis down'));
      io.localSocketsLeave.mockImplementation(() => { throw new Error('local leave failed'); });
      io.socketsLeave.mockImplementation(() => { throw new Error('cluster leave failed'); });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).resolves.toBeUndefined();

        expect(warn).toHaveBeenCalledWith('[T] The read-only notice of conversation conv-k1 failed:', 'adapter down');
        expect(warn).toHaveBeenCalledWith('[T] Ending the calls of 2 direct conversation(s) of a deleted account failed:', 'redis down');
        expect(warn).toHaveBeenCalledWith('[T] The local room leave of 1 deleted conversation(s) failed:', 'local leave failed');
        expect(warn).toHaveBeenCalledWith('[T] The cluster room leave of 1 deleted conversation(s) failed:', 'cluster leave failed');
        // what follows still runs
        expect(announceSecure).toHaveBeenCalledWith(SECURE_REMOVAL);
        expect(deleteFromS3).toHaveBeenCalledWith('avatars/u-1.webp');
      } finally {
        warn.mockRestore();
      }
    });

    it('nothing about the conversations goes out when the deletion fails', async () => {
      settle.mockImplementation(() => lazyStatement(order, 'conversations', KEPT));
      prismaMock.user.delete.mockRejectedValue(new Error('db gone'));

      await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).rejects.toThrow('db gone');

      expect(io.emit).not.toHaveBeenCalledWith('dm:conversation:read_only', expect.anything());
      expect(endCall).not.toHaveBeenCalled();
      expect(deleteMultipleFromS3).not.toHaveBeenCalled();
    });
  });

  it('an account found gone under the account row lock (another deletion or the sweep removed it first): 404 User, the attempt rolled back, nothing announced', async () => {
    prismaMock.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => (/FROM users/.test(strings.join('?')) ? [] : []));

    const refusal = await deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' }).catch((e: unknown) => e);

    expect(refusal).toMatchObject({ statusCode: 404, message: 'User not found' });
    expect(settle).not.toHaveBeenCalled();
    expect(prismaMock.user.delete).not.toHaveBeenCalled();
    expect(announceSecure).not.toHaveBeenCalled();
    expect(deleteMultipleFromS3).not.toHaveBeenCalled();
    expect(deleteFromS3).not.toHaveBeenCalled();
    // only the first revocation (before the transaction) went out
    expect(io.disconnectSockets).toHaveBeenCalledTimes(1);
  });

  describe('every step after the commit is on its own: a failure is logged, never thrown, and the steps after it still run', () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => warn.mockRestore());

    it('the secure-channel notices throwing (no socket server)', async () => {
      announceSecure.mockRejectedValue(new Error('Socket.IO not initialized'));
      prismaMock.serverJoinRequest.findMany.mockResolvedValue([{ serverId: 's-7' }]);
      emitMods.mockImplementation(async () => { order.push('request-withdrawn'); });

      await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith('[T] After the deletion of account u-1, the secure-channel notices failed:', 'Socket.IO not initialized');
      expect(order).toContain('request-withdrawn');
      expect(deleteFromS3).toHaveBeenCalledWith('avatars/u-1.webp');
    });

    it('a withdrawn join request notice throwing', async () => {
      prismaMock.serverJoinRequest.findMany.mockResolvedValue([{ serverId: 's-7' }, { serverId: 's-8' }]);
      emitMods.mockRejectedValueOnce(new Error('adapter down')).mockResolvedValue(undefined);

      await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith('[T] After the deletion of account u-1, the withdrawn join request notice in space s-7 failed:', 'adapter down');
      expect(emitMods).toHaveBeenCalledTimes(2);
      expect(deleteFromS3).toHaveBeenCalledWith('avatars/u-1.webp');
    });

    it('the avatar cleanup throwing', async () => {
      deleteFromS3.mockRejectedValue(new Error('s3 down'));

      await expect(deleteUserAccount('u-1', { reason: 'bye', logPrefix: '[T]' })).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith('[T] After the deletion of account u-1, the avatar cleanup (the orphan sweep will reclaim it) failed:', 's3 down');
    });
  });

  it('does nothing for an account that no longer exists', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    await deleteUserAccount('ghost', { reason: 'bye', logPrefix: '[T]' });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});
