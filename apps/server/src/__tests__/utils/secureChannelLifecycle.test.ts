import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WS_EVENTS } from '@voxium/shared';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const prismaMock: Record<string, any> = {
  channel: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), delete: vi.fn() },
  channelMember: { findMany: vi.fn(), deleteMany: vi.fn() },
  channelRead: { deleteMany: vi.fn() },
  e2EKeyShare: { deleteMany: vi.fn() },
  messageAttachment: { findMany: vi.fn() },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
};

vi.mock('../../utils/prisma', () => ({
  prisma: new Proxy({} as any, {
    get(_target, prop) {
      return prismaMock[prop as string];
    },
  }),
}));

const mockEmit = vi.fn();
const mockTo = vi.fn(() => ({ emit: mockEmit }));
const mockSocketsLeave = vi.fn();
const mockIn = vi.fn(() => ({ socketsLeave: mockSocketsLeave }));
vi.mock('../../websocket/socketServer', () => ({
  getIO: vi.fn(() => ({ to: mockTo, in: mockIn })),
}));

const mockDeleteMultipleFromS3 = vi.fn().mockResolvedValue(undefined);
vi.mock('../../utils/s3', () => ({
  VALID_ATTACHMENT_KEY_RE: /^attachments\/(ch|dm)-[\w-]+\/[\w]+-[\w][\w.-]*$/,
  deleteMultipleFromS3: (...args: any[]) => mockDeleteMultipleFromS3(...args),
}));

// Live voice in a deleted secure voice channel dies with it, on every node
const mockBroadcastChannelVoiceCleanup = vi.fn().mockResolvedValue(undefined);
const mockBroadcastVoiceEvictUser = vi.fn().mockResolvedValue(undefined);
vi.mock('../../websocket/voiceCluster', () => ({
  broadcastChannelVoiceCleanup: (...args: any[]) => mockBroadcastChannelVoiceCleanup(...args),
  broadcastVoiceEvictUser: (...args: any[]) => mockBroadcastVoiceEvictUser(...args),
}));

// The retry between attempts waits for nothing in these tests
vi.mock('../../utils/transactionRetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/transactionRetry')>();
  return {
    ...actual,
    retryOnTransactionConflict: (fn: () => Promise<unknown>, label: string, opts: object = {}) =>
      actual.retryOnTransactionConflict(fn, label, { ...opts, sleep: async () => {} }),
  };
});

import {
  deleteSecureChannel,
  removeSecureMember,
  removeSecureMembershipsInTx,
  announceSecureMembershipsRemoved,
  getSecureChannelMembersPayload,
  lockServerMemberRows,
  undoRoomJoinsOfRemovedMembers,
} from '../../utils/secureChannelLifecycle';

describe('secureChannelLifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteMultipleFromS3.mockResolvedValue(undefined);
    prismaMock.messageAttachment.findMany.mockReset().mockResolvedValue([]);
    mockBroadcastChannelVoiceCleanup.mockReset().mockResolvedValue(undefined);
    mockBroadcastVoiceEvictUser.mockReset().mockResolvedValue(undefined);
    prismaMock.$transaction.mockImplementation(async (arg: any) =>
      Array.isArray(arg) ? Promise.all(arg) : arg(prismaMock),
    );
    prismaMock.channelMember.findMany.mockResolvedValue([]);
    prismaMock.channelMember.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.channelRead.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.e2EKeyShare.deleteMany.mockResolvedValue({ count: 0 });
  });

  describe('deleteSecureChannel', () => {
    const KEY = 'attachments/ch-sec-1/aaaa-encrypted.bin';
    const deadlock = () => Object.assign(new Error('Transaction failed due to a write conflict or a deadlock.'), { code: 'P2034' });
    let warn: ReturnType<typeof vi.spyOn>;

    /** The locked row the transaction finds, and the members the notices go to */
    function arm(...userIds: string[]) {
      prismaMock.$queryRaw.mockResolvedValue([{ serverId: 'srv-1' }]);
      prismaMock.channelMember.findMany.mockResolvedValue(userIds.map((userId) => ({ userId })));
      prismaMock.channel.delete.mockResolvedValue({});
    }
    const userRooms = () => mockTo.mock.calls.map((c: any[]) => c[0]);

    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      prismaMock.$queryRaw.mockReset();
      prismaMock.channel.delete.mockReset();
      // the cheap existence check a call without a decision makes first
      prismaMock.channel.findFirst.mockReset().mockResolvedValue({ id: 'sec-1' });
    });
    afterEach(() => warn.mockRestore());

    it('deletes the row, notifies each member user room, tears down the channel room, cleans S3', async () => {
      arm('u1', 'u2');
      prismaMock.messageAttachment.findMany.mockResolvedValueOnce([
        { id: 'att-1', s3Key: 'attachments/ch-sec-1/aaaa-encrypted.bin' },
        { id: 'att-2', s3Key: 'attachments/ch-sec-1/bbbb-encrypted.bin' },
      ]);

      const result = await deleteSecureChannel('sec-1');

      expect(result).toBe(true);
      expect(prismaMock.channel.delete).toHaveBeenCalledWith({ where: { id: 'sec-1' } });
      expect(userRooms()).toEqual(['user:u1', 'user:u2']);
      expect(mockEmit).toHaveBeenCalledWith(WS_EVENTS.CHANNEL_DELETED, {
        channelId: 'sec-1',
        serverId: 'srv-1',
      });
      expect(mockIn).toHaveBeenCalledWith('channel:sec-1');
      expect(mockSocketsLeave).toHaveBeenCalledWith('channel:sec-1');
      expect(mockDeleteMultipleFromS3).toHaveBeenCalledWith([
        'attachments/ch-sec-1/aaaa-encrypted.bin',
        'attachments/ch-sec-1/bbbb-encrypted.bin',
      ]);
    });

    it('locks the secure channel row FIRST, reads the members under that lock, then deletes, in one transaction', async () => {
      const order: string[] = [];
      prismaMock.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
        order.push(strings.join('?').includes('FOR UPDATE') ? 'lock' : 'other');
        return [{ serverId: 'srv-1' }];
      });
      prismaMock.channelMember.findMany.mockImplementation(async () => { order.push('members'); return []; });
      prismaMock.channel.delete.mockImplementation(async () => { order.push('delete'); return {}; });

      await deleteSecureChannel('sec-1');

      expect(order).toEqual(['lock', 'members', 'delete']);
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      // the long budget: a wait behind an account deletion must not expire it
      expect(prismaMock.$transaction.mock.calls[0][1]).toEqual({ timeout: 60_000, maxWait: 10_000 });
      // a plaintext channel can never match the lock
      expect(prismaMock.$queryRaw.mock.calls[0][0].join('?')).toContain('secure = true');
    });

    it('reads the keys in bounded batches before the row, and deletes the files after it', async () => {
      arm();
      prismaMock.messageAttachment.findMany.mockResolvedValueOnce([{ id: 'att-1', s3Key: KEY }]);

      await deleteSecureChannel('sec-1');

      expect(prismaMock.messageAttachment.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { expired: false, message: { channelId: 'sec-1' } },
        take: 1000,
      }));
      const deleteOrder = prismaMock.channel.delete.mock.invocationCallOrder[0];
      expect(prismaMock.messageAttachment.findMany.mock.invocationCallOrder[0]).toBeLessThan(deleteOrder);
      expect(mockDeleteMultipleFromS3.mock.invocationCallOrder[0]).toBeGreaterThan(deleteOrder);
    });

    it('a fan-out step that throws after the row cannot skip the file delete', async () => {
      arm('u1');
      prismaMock.messageAttachment.findMany.mockResolvedValueOnce([{ id: 'att-1', s3Key: KEY }]);
      mockEmit.mockImplementationOnce(() => { throw new Error('adapter publish failed'); });
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await deleteSecureChannel('sec-1');

        expect(mockDeleteMultipleFromS3).toHaveBeenCalledWith([KEY]);
      } finally {
        errorLog.mockRestore();
      }
    });

    describe('the steps after the row delete are best effort', () => {
      let errorLog: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        arm('u1');
        errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      });

      afterEach(() => {
        errorLog.mockRestore();
        mockEmit.mockReset();
        mockSocketsLeave.mockReset();
      });

      it('a notice that throws still empties the room and still tears the live voice down (spec §21)', async () => {
        mockEmit.mockImplementationOnce(() => { throw new Error('adapter publish failed'); });

        await expect(deleteSecureChannel('sec-1')).resolves.toBe(true);

        expect(mockSocketsLeave).toHaveBeenCalledWith('channel:sec-1');
        expect(mockBroadcastChannelVoiceCleanup).toHaveBeenCalledWith(expect.anything(), 'sec-1');
        expect(errorLog).toHaveBeenCalledWith('[SecureChannel] Channel sec-1 deleted, but the channel:deleted notices failed:', 'adapter publish failed');
      });

      it('a room leave that throws still tears the live voice down', async () => {
        mockSocketsLeave.mockImplementationOnce(() => { throw new Error('adapter failed'); });

        await expect(deleteSecureChannel('sec-1')).resolves.toBe(true);

        expect(mockBroadcastChannelVoiceCleanup).toHaveBeenCalledWith(expect.anything(), 'sec-1');
        expect(errorLog).toHaveBeenCalledWith('[SecureChannel] Channel sec-1 deleted, but the room leave failed:', 'adapter failed');
      });

      it('a voice cleanup that rejects still reports the channel as deleted', async () => {
        mockBroadcastChannelVoiceCleanup.mockRejectedValueOnce(new Error('voice cleanup failed'));

        await expect(deleteSecureChannel('sec-1')).resolves.toBe(true);

        expect(errorLog).toHaveBeenCalledWith('[SecureChannel] Channel sec-1 deleted, but the voice cleanup failed:', 'voice cleanup failed');
      });

      it('a row delete that fails announces nothing and tears nothing down', async () => {
        prismaMock.channel.delete.mockRejectedValueOnce(new Error('db gone'));

        await expect(deleteSecureChannel('sec-1')).rejects.toThrow('db gone');

        expect(mockEmit).not.toHaveBeenCalled();
        expect(mockSocketsLeave).not.toHaveBeenCalled();
        expect(mockBroadcastChannelVoiceCleanup).not.toHaveBeenCalled();
        expect(mockDeleteMultipleFromS3).not.toHaveBeenCalled();
      });
    });

    it('REFUSES to delete a plaintext or a nonexistent channel (returns false, reads and touches nothing)', async () => {
      // without a decision to make, the existence check matches secure rows only
      prismaMock.channel.findFirst.mockResolvedValue(null);

      expect(await deleteSecureChannel('ch-plain')).toBe(false);

      expect(prismaMock.channel.findFirst).toHaveBeenCalledWith({ where: { id: 'ch-plain', secure: true }, select: { id: true } });
      expect(prismaMock.messageAttachment.findMany).not.toHaveBeenCalled();
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
      expect(prismaMock.channel.delete).not.toHaveBeenCalled();
      expect(mockEmit).not.toHaveBeenCalled();
      expect(mockDeleteMultipleFromS3).not.toHaveBeenCalled();
      expect(mockBroadcastChannelVoiceCleanup).not.toHaveBeenCalled();
    });

    it('a channel the lock does not find (gone or not secure) returns false, touches nothing', async () => {
      prismaMock.$queryRaw.mockResolvedValue([]);

      expect(await deleteSecureChannel('sec-1')).toBe(false);

      expect(prismaMock.channel.delete).not.toHaveBeenCalled();
      expect(prismaMock.channelMember.findMany).not.toHaveBeenCalled();
      expect(mockEmit).not.toHaveBeenCalled();
      expect(mockBroadcastChannelVoiceCleanup).not.toHaveBeenCalled();
    });

    it('a failed S3 cleanup does not fail the deletion (logged, fire-and-forget)', async () => {
      arm('u1');
      prismaMock.messageAttachment.findMany.mockResolvedValueOnce([{ id: 'att-1', s3Key: 'attachments/ch-sec-1/x-encrypted.bin' }]);
      mockDeleteMultipleFromS3.mockRejectedValue(Object.assign(new Error('s3 down'), { name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } }));

      const result = await deleteSecureChannel('sec-1');
      // Let the fire-and-forget rejection settle
      await new Promise((r) => setImmediate(r));

      expect(result).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        '[SecureChannel] Attachment file cleanup failed for deleted channel sec-1 (the orphan sweep will reclaim them):', 'ServiceUnavailable, HTTP 503');
    });

    describe('a delete that loses a deadlock is tried again', () => {
      it('a deadlock on the first attempt, then success: deletes twice at the database, announces and cleans once', async () => {
        arm('u1');
        prismaMock.messageAttachment.findMany.mockResolvedValueOnce([{ id: 'att-1', s3Key: KEY }]);
        prismaMock.channel.delete.mockRejectedValueOnce(deadlock());

        await expect(deleteSecureChannel('sec-1')).resolves.toBe(true);

        expect(prismaMock.channel.delete).toHaveBeenCalledTimes(2);
        expect(mockEmit).toHaveBeenCalledTimes(1);
        expect(mockBroadcastChannelVoiceCleanup).toHaveBeenCalledTimes(1);
        expect(mockDeleteMultipleFromS3).toHaveBeenCalledTimes(1);
        // the keys are read once, not per attempt
        expect(prismaMock.messageAttachment.findMany).toHaveBeenCalledTimes(1);
      });

      it("the caller's decision is made again on each attempt, and once before the keys are read", async () => {
        arm('u1');
        prismaMock.channel.delete.mockRejectedValueOnce(deadlock());
        const authorize = vi.fn().mockResolvedValue(undefined);

        await deleteSecureChannel('sec-1', authorize);

        // the early refusal + one per attempt
        expect(authorize).toHaveBeenCalledTimes(3);
        expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.messageAttachment.findMany.mock.invocationCallOrder[0]);
      });

      it("a refusal at the second attempt deletes and announces nothing more, and the caller's own answer surfaces", async () => {
        arm('u1');
        prismaMock.channel.delete.mockRejectedValueOnce(deadlock());
        const refusal = new Error('lever gone');
        const authorize = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(refusal);

        await expect(deleteSecureChannel('sec-1', authorize)).rejects.toBe(refusal);

        expect(prismaMock.channel.delete).toHaveBeenCalledTimes(1);
        expect(mockEmit).not.toHaveBeenCalled();
        expect(mockDeleteMultipleFromS3).not.toHaveBeenCalled();
        expect(mockBroadcastChannelVoiceCleanup).not.toHaveBeenCalled();
      });

      it('a member added between the attempts receives the notice: the list is read inside the attempt that deletes', async () => {
        prismaMock.$queryRaw.mockResolvedValue([{ serverId: 'srv-1' }]);
        prismaMock.channelMember.findMany
          .mockResolvedValueOnce([{ userId: 'u1' }])
          .mockResolvedValueOnce([{ userId: 'u1' }, { userId: 'u-new' }]);
        prismaMock.channel.delete.mockRejectedValueOnce(deadlock()).mockResolvedValue({});

        await deleteSecureChannel('sec-1');

        expect(userRooms()).toEqual(['user:u1', 'user:u-new']);
      });

      it('a channel gone at the second attempt returns false and announces nothing', async () => {
        prismaMock.$queryRaw.mockResolvedValueOnce([{ serverId: 'srv-1' }]).mockResolvedValueOnce([]);
        prismaMock.channelMember.findMany.mockResolvedValue([{ userId: 'u1' }]);
        prismaMock.channel.delete.mockRejectedValueOnce(deadlock());

        await expect(deleteSecureChannel('sec-1')).resolves.toBe(false);

        expect(prismaMock.channel.delete).toHaveBeenCalledTimes(1);
        expect(mockEmit).not.toHaveBeenCalled();
        expect(mockDeleteMultipleFromS3).not.toHaveBeenCalled();
        expect(mockBroadcastChannelVoiceCleanup).not.toHaveBeenCalled();
      });

      it('a row gone at the delete (P2025) returns false, announces nothing, and is not retried', async () => {
        arm('u1');
        prismaMock.channel.delete.mockRejectedValueOnce(Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' }));

        await expect(deleteSecureChannel('sec-1')).resolves.toBe(false);

        expect(prismaMock.channel.delete).toHaveBeenCalledTimes(1);
        expect(mockEmit).not.toHaveBeenCalled();
        expect(mockDeleteMultipleFromS3).not.toHaveBeenCalled();
      });

      it('an error that is not a conflict is not retried', async () => {
        arm('u1');
        prismaMock.channel.delete.mockRejectedValueOnce(new Error('db gone'));

        await expect(deleteSecureChannel('sec-1')).rejects.toThrow('db gone');

        expect(prismaMock.channel.delete).toHaveBeenCalledTimes(1);
        expect(mockEmit).not.toHaveBeenCalled();
      });

      it('a conflict on every attempt surfaces as before and announces nothing', async () => {
        arm('u1');
        prismaMock.channel.delete.mockRejectedValue(deadlock());

        await expect(deleteSecureChannel('sec-1')).rejects.toMatchObject({ code: 'P2034' });

        // the first attempt and two retries
        expect(prismaMock.channel.delete).toHaveBeenCalledTimes(3);
        expect(mockEmit).not.toHaveBeenCalled();
        expect(mockSocketsLeave).not.toHaveBeenCalled();
        expect(mockBroadcastChannelVoiceCleanup).not.toHaveBeenCalled();
        expect(mockDeleteMultipleFromS3).not.toHaveBeenCalled();
      });
    });
  });

  describe('removeSecureMember', () => {
    it('locks the channel row FIRST, then deletes the rows, in one transaction (the order every delete in the channel takes)', async () => {
      const order: string[] = [];
      prismaMock.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => { order.push(strings.join('?').includes('FOR UPDATE') ? 'lock' : 'other'); return [{ id: 'sec-1' }]; });
      prismaMock.channelMember.deleteMany.mockImplementation(async () => { order.push('member'); return { count: 1 }; });
      prismaMock.channelRead.deleteMany.mockImplementation(async () => { order.push('read'); return { count: 1 }; });
      prismaMock.e2EKeyShare.deleteMany.mockImplementation(async () => { order.push('shares'); return { count: 0 }; });

      await removeSecureMember('sec-1', 'srv-1', 'u2');

      expect(order.slice(0, 4)).toEqual(['lock', 'member', 'read', 'shares']);
      expect((prismaMock.$queryRaw.mock.calls[0][0] as string[]).join('?')).toMatch(/SELECT id FROM channels WHERE id = \? FOR UPDATE/);
      expect(prismaMock.$queryRaw.mock.calls[0][1]).toBe('sec-1');
      expect(typeof prismaMock.$transaction.mock.calls[0][0]).toBe('function');
    });

    it('gives the transaction the long budget: the channel row it waits for is held through an account deletion\'s cascade', async () => {
      prismaMock.$queryRaw.mockResolvedValue([{ id: 'sec-1' }]);

      await removeSecureMember('sec-1', 'srv-1', 'u2');

      // Under Prisma's 5 s default the wait alone expired the transaction (P2028, a 500)
      expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 60_000, maxWait: 10_000 });
    });

    it('a removal PostgreSQL aborted to break a deadlock (its creator leaving at once) runs again instead of answering 500', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      prismaMock.$queryRaw.mockResolvedValue([{ id: 'sec-1' }]);
      const real = prismaMock.$transaction.getMockImplementation()!;
      prismaMock.$transaction
        .mockImplementationOnce(async () => { throw Object.assign(new Error('deadlock'), { code: 'P2034' }); })
        .mockImplementation(real);
      try {
        await expect(removeSecureMember('sec-1', 'srv-1', 'u2')).resolves.toBeUndefined();
        expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
        expect(mockEmit).toHaveBeenCalledWith(WS_EVENTS.CHANNEL_DELETED, { channelId: 'sec-1', serverId: 'srv-1' });
      } finally {
        warn.mockRestore();
      }
    });

    it('deletes membership+read rows, tells the removed user, refreshes the member list', async () => {
      prismaMock.channelMember.findMany.mockResolvedValue([
        {
          userId: 'u1', isCreator: true, addedAt: new Date(),
          user: { id: 'u1', username: 'a', displayName: 'A', avatarUrl: null },
        },
      ]);

      await removeSecureMember('sec-1', 'srv-1', 'u2');

      expect(prismaMock.channelMember.deleteMany).toHaveBeenCalledWith({
        where: { channelId: 'sec-1', userId: 'u2' },
      });
      expect(prismaMock.channelRead.deleteMany).toHaveBeenCalledWith({
        where: { channelId: 'sec-1', userId: 'u2' },
      });
      // Unclaimed key shares for this channel's scope die with the membership
      expect(prismaMock.e2EKeyShare.deleteMany).toHaveBeenCalledWith({
        where: { recipientUserId: 'u2', conversationId: 'ch:sec-1' },
      });
      expect(mockTo).toHaveBeenCalledWith('user:u2');
      expect(mockEmit).toHaveBeenCalledWith(WS_EVENTS.CHANNEL_DELETED, {
        channelId: 'sec-1', serverId: 'srv-1',
      });
      expect(mockIn).toHaveBeenCalledWith('user:u2');
      expect(mockSocketsLeave).toHaveBeenCalledWith('channel:sec-1');
      expect(mockTo).toHaveBeenCalledWith('channel:sec-1');
      expect(mockEmit).toHaveBeenCalledWith(
        WS_EVENTS.CHANNEL_MEMBERS_UPDATED,
        expect.objectContaining({ channelId: 'sec-1', serverId: 'srv-1' }),
      );
    });
  });

  describe('lockServerMemberRows', () => {
    it('takes FOR KEY SHARE on the member rows, in id order, and answers the ids that are members', async () => {
      const tx = { $queryRaw: vi.fn().mockResolvedValue([{ user_id: 'u1' }, { user_id: 'u3' }]) };

      const members = await lockServerMemberRows(tx as any, 'srv-1', ['u3', 'u1', 'u2']);

      const sql = (tx.$queryRaw.mock.calls[0][0] as string[]).join('?');
      // KEY SHARE: the removal's DELETE of the row waits for it, an UPDATE of
      // the row (an ownership transfer takes the space row, then the member
      // rows) does not, so the two never deadlock. FOR SHARE blocked it.
      expect(sql).toMatch(/ORDER BY user_id\s+FOR KEY SHARE$/);
      expect(sql).not.toMatch(/FOR SHARE/);
      expect(tx.$queryRaw.mock.calls[0].slice(1)).toEqual(['srv-1', ['u3', 'u1', 'u2']]);
      expect(members).toEqual(new Set(['u1', 'u3']));
    });
  });

  describe('undoRoomJoinsOfRemovedMembers', () => {
    it('re-reads the rows of the users just joined and takes those without one back out of the room', async () => {
      prismaMock.channelMember.findMany.mockResolvedValue([{ userId: 'u1' }]);

      const still = await undoRoomJoinsOfRemovedMembers('sec-1', ['u1', 'u2']);

      expect(prismaMock.channelMember.findMany).toHaveBeenCalledWith({
        where: { channelId: 'sec-1', userId: { in: ['u1', 'u2'] } },
        select: { userId: true },
      });
      // by user room, adapter-wide
      expect(mockIn).toHaveBeenCalledTimes(1);
      expect(mockIn).toHaveBeenCalledWith('user:u2');
      expect(mockSocketsLeave).toHaveBeenCalledWith('channel:sec-1');
      expect(still).toEqual(new Set(['u1']));
    });

    it('a failed re-read confirms nobody: every join is taken back, and it is logged', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      prismaMock.channelMember.findMany.mockRejectedValue(new Error('db hiccup'));
      try {
        const still = await undoRoomJoinsOfRemovedMembers('sec-1', ['u1', 'u2']);

        expect(still).toEqual(new Set());
        expect(mockIn).toHaveBeenCalledWith('user:u1');
        expect(mockIn).toHaveBeenCalledWith('user:u2');
        expect(mockSocketsLeave).toHaveBeenCalledTimes(2);
        expect(mockSocketsLeave).toHaveBeenCalledWith('channel:sec-1');
        expect(warn).toHaveBeenCalledWith('[SecureChannel] Could not re-check the members joined to channel:sec-1; taking every join back:', 'db hiccup');
      } finally {
        warn.mockRestore();
        prismaMock.channelMember.findMany.mockReset().mockResolvedValue([]);
      }
    });
  });

  describe('getSecureChannelMembersPayload', () => {
    it('lists only the rows whose user is a member of the channel\'s space', async () => {
      await getSecureChannelMembersPayload('sec-1', 'srv-1');

      expect(prismaMock.channelMember.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { channelId: 'sec-1', user: { memberships: { some: { serverId: 'srv-1' } } } },
      }));
    });

    it('the members-updated broadcast reads the list of the space it names', async () => {
      await removeSecureMember('sec-1', 'srv-1', 'u2');

      const listRead = prismaMock.channelMember.findMany.mock.calls.at(-1)[0];
      expect(listRead.where).toEqual({ channelId: 'sec-1', user: { memberships: { some: { serverId: 'srv-1' } } } });
    });
  });

  describe('removeSecureMembershipsInTx (inside the transaction that ends a membership)', () => {
    const order: string[] = [];
    let tx: Record<string, any>;

    beforeEach(() => {
      order.length = 0;
      tx = {
        $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
          order.push(`lock:${strings.join('?').includes('c.server_id = ?') ? 'space' : 'account'}`);
          // one channel the user created, one they were invited to, id order
          return [
            { id: 'sec-other', server_id: 'srv-1', created_by_id: 'u5' },
            { id: 'sec-own', server_id: 'srv-1', created_by_id: 'u1' },
          ];
        }),
        channelMember: {
          findMany: vi.fn(async () => {
            order.push('read:created-members');
            return [{ channelId: 'sec-own', userId: 'u1' }, { channelId: 'sec-own', userId: 'u9' }];
          }),
          deleteMany: vi.fn(async () => { order.push('delete:rows'); return { count: 1 }; }),
        },
        channel: { deleteMany: vi.fn(async () => { order.push('delete:created'); return { count: 1 }; }) },
        e2EKeyShare: { deleteMany: vi.fn(async () => { order.push('delete:shares'); return { count: 0 }; }) },
        channelRead: { deleteMany: vi.fn() },
      };
    });

    it('locks EVERY secure channel the user created or belongs to, in id order, before deleting anything', async () => {
      await removeSecureMembershipsInTx(tx as any, 'u1', 'srv-1');

      // The lock is the first statement: a channel delete, another departure
      // and an invite all take the channel row first too, so they queue on it
      // in one order instead of each holding a row the other needs
      expect(order[0]).toBe('lock:space');
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      const lockSql = (tx.$queryRaw.mock.calls[0][0] as string[]).join('?');
      expect(lockSql).toMatch(/c\.secure = true AND c\.server_id = \?/);
      expect(lockSql).toMatch(/c\.created_by_id = \?\s+OR EXISTS \(SELECT 1 FROM channel_members cm WHERE cm\.channel_id = c\.id AND cm\.user_id = \?\)/);
      expect(lockSql).toMatch(/ORDER BY c\.id\s+FOR UPDATE OF c$/);
      expect(tx.$queryRaw.mock.calls[0].slice(1)).toEqual(['srv-1', 'u1', 'u1']);
    });

    it('then deletes the channels the user created, their rows in the others and the key shares; the read markers are not its business', async () => {
      const removal = await removeSecureMembershipsInTx(tx as any, 'u1', 'srv-1');

      expect(order).toEqual(['lock:space', 'read:created-members', 'delete:created', 'delete:rows', 'delete:shares']);
      expect(tx.channel.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['sec-own'] }, secure: true } });
      // Every channel of the space, not only the secure ones: no row may
      // survive the membership
      expect(tx.channelMember.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1', channel: { serverId: 'srv-1' } } });
      expect(tx.e2EKeyShare.deleteMany).toHaveBeenCalledWith({
        where: { recipientUserId: 'u1', conversationId: { in: ['ch:sec-own', 'ch:sec-other'] } },
      });
      // A read marker grants nothing; deleting it here would be one more row
      // locked in an order a channel delete's cascade does not share
      expect(tx.channelRead.deleteMany).not.toHaveBeenCalled();
      expect(removal).toEqual({
        userId: 'u1',
        deleted: [{ channelId: 'sec-own', serverId: 'srv-1', memberIds: ['u1', 'u9'] }],
        left: [{ channelId: 'sec-other', serverId: 'srv-1' }],
      });
    });

    it('without a space (account deletion) covers every space the user is in', async () => {
      await removeSecureMembershipsInTx(tx as any, 'u1');

      expect(order[0]).toBe('lock:account');
      expect(tx.$queryRaw.mock.calls[0].slice(1)).toEqual(['u1', 'u1']);
      expect(tx.channelMember.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    });

    it('a user who created nothing and belongs to no secure channel: no channel delete, no key-share statement', async () => {
      tx.$queryRaw.mockResolvedValue([]);

      const removal = await removeSecureMembershipsInTx(tx as any, 'u1', 'srv-1');

      expect(tx.channel.deleteMany).not.toHaveBeenCalled();
      expect(tx.e2EKeyShare.deleteMany).not.toHaveBeenCalled();
      // the row delete still runs: it is what catches a row nothing listed
      expect(tx.channelMember.deleteMany).toHaveBeenCalledTimes(1);
      expect(removal).toEqual({ userId: 'u1', deleted: [], left: [] });
    });

    it('a statement that throws is thrown to the transaction, never swallowed', async () => {
      tx.channel.deleteMany.mockRejectedValue(new Error('db hiccup'));

      await expect(removeSecureMembershipsInTx(tx as any, 'u1', 'srv-1')).rejects.toThrow('db hiccup');
      expect(tx.channelMember.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('announceSecureMembershipsRemoved (after the commit)', () => {
    const removal = {
      userId: 'u1',
      deleted: [{ channelId: 'sec-own', serverId: 'srv-1', memberIds: ['u1', 'u9'] }],
      left: [{ channelId: 'sec-other', serverId: 'srv-1' }],
    };

    it('deleted channels: channel:deleted to every member, the room emptied, live voice torn down', async () => {
      await announceSecureMembershipsRemoved(removal);

      expect(mockTo).toHaveBeenCalledWith('user:u9');
      expect(mockEmit).toHaveBeenCalledWith(WS_EVENTS.CHANNEL_DELETED, { channelId: 'sec-own', serverId: 'srv-1' });
      expect(mockIn).toHaveBeenCalledWith('channel:sec-own');
      expect(mockSocketsLeave).toHaveBeenCalledWith('channel:sec-own');
      expect(mockBroadcastChannelVoiceCleanup).toHaveBeenCalledWith(expect.anything(), 'sec-own');
    });

    it('channels left: the user told and out of the room, their voice session ended, the others refreshed', async () => {
      await announceSecureMembershipsRemoved(removal);

      expect(mockEmit).toHaveBeenCalledWith(WS_EVENTS.CHANNEL_DELETED, { channelId: 'sec-other', serverId: 'srv-1' });
      expect(mockIn).toHaveBeenCalledWith('user:u1');
      expect(mockSocketsLeave).toHaveBeenCalledWith('channel:sec-other');
      expect(mockBroadcastVoiceEvictUser).toHaveBeenCalledWith(expect.anything(), 'sec-other', 'u1');
      expect(mockTo).toHaveBeenCalledWith('channel:sec-other');
      expect(mockEmit).toHaveBeenCalledWith(WS_EVENTS.CHANNEL_MEMBERS_UPDATED, expect.objectContaining({ channelId: 'sec-other', serverId: 'srv-1' }));
    });

    it('every step is best effort: one that throws is logged and the next still runs, nothing is thrown', async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockBroadcastChannelVoiceCleanup.mockRejectedValueOnce(new Error('voice cleanup failed'));
      mockBroadcastVoiceEvictUser.mockRejectedValueOnce(new Error('evict failed'));
      try {
        await expect(announceSecureMembershipsRemoved(removal)).resolves.toBeUndefined();

        expect(errorLog).toHaveBeenCalledWith('[SecureChannel] Channel sec-own deleted, but the voice cleanup failed:', 'voice cleanup failed');
        expect(errorLog).toHaveBeenCalledWith('[SecureChannel] Member removed from sec-other, but the voice eviction failed:', 'evict failed');
        // the members still get their refreshed list
        expect(mockEmit).toHaveBeenCalledWith(WS_EVENTS.CHANNEL_MEMBERS_UPDATED, expect.objectContaining({ channelId: 'sec-other' }));
      } finally {
        errorLog.mockRestore();
      }
    });
  });
});
