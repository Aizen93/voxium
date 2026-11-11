import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WS_EVENTS } from '@voxium/shared';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const prismaMock: Record<string, any> = {
  channel: { findUnique: vi.fn(), findMany: vi.fn(), delete: vi.fn() },
  channelMember: { findMany: vi.fn(), deleteMany: vi.fn() },
  channelRead: { deleteMany: vi.fn() },
  e2EKeyShare: { deleteMany: vi.fn() },
  messageAttachment: { findMany: vi.fn() },
  $transaction: vi.fn(),
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

import {
  deleteSecureChannel,
  removeSecureMember,
  removeSecureMembershipsInTx,
  announceSecureMembershipsRemoved,
  getSecureChannelMembersPayload,
  lockServerMemberRows,
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
    it('deletes the row, notifies each member user room, tears down the channel room, cleans S3', async () => {
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'sec-1',
        secure: true,
        serverId: 'srv-1',
        members: [{ userId: 'u1' }, { userId: 'u2' }],
      });
      prismaMock.messageAttachment.findMany.mockResolvedValueOnce([
        { id: 'att-1', s3Key: 'attachments/ch-sec-1/aaaa-encrypted.bin' },
        { id: 'att-2', s3Key: 'attachments/ch-sec-1/bbbb-encrypted.bin' },
      ]);
      prismaMock.channel.delete.mockResolvedValue({});

      const result = await deleteSecureChannel('sec-1');

      expect(result).toBe(true);
      expect(prismaMock.channel.delete).toHaveBeenCalledWith({ where: { id: 'sec-1' } });
      const rooms = mockTo.mock.calls.map((c: any[]) => c[0]);
      expect(rooms).toEqual(['user:u1', 'user:u2']);
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

    it('reads the keys in bounded batches before the row, and deletes the files after it', async () => {
      prismaMock.channel.findUnique.mockResolvedValue({ id: 'sec-1', secure: true, serverId: 'srv-1', members: [] });
      prismaMock.messageAttachment.findMany.mockResolvedValueOnce([{ id: 'att-1', s3Key: 'attachments/ch-sec-1/aaaa-encrypted.bin' }]);
      prismaMock.channel.delete.mockResolvedValue({});

      await deleteSecureChannel('sec-1');

      // No nested load of every message: the channel read selects no messages
      expect(prismaMock.channel.findUnique.mock.calls[0][0].select).not.toHaveProperty('messages');
      expect(prismaMock.messageAttachment.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { expired: false, message: { channelId: 'sec-1' } },
        take: 1000,
      }));
      const deleteOrder = prismaMock.channel.delete.mock.invocationCallOrder[0];
      expect(prismaMock.messageAttachment.findMany.mock.invocationCallOrder[0]).toBeLessThan(deleteOrder);
      expect(mockDeleteMultipleFromS3.mock.invocationCallOrder[0]).toBeGreaterThan(deleteOrder);
    });

    it('a fan-out step that throws after the row cannot skip the file delete', async () => {
      prismaMock.channel.findUnique.mockResolvedValue({ id: 'sec-1', secure: true, serverId: 'srv-1', members: [{ userId: 'u1' }] });
      prismaMock.messageAttachment.findMany.mockResolvedValueOnce([{ id: 'att-1', s3Key: 'attachments/ch-sec-1/aaaa-encrypted.bin' }]);
      prismaMock.channel.delete.mockResolvedValue({});
      mockEmit.mockImplementationOnce(() => { throw new Error('adapter publish failed'); });
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await deleteSecureChannel('sec-1');

        expect(mockDeleteMultipleFromS3).toHaveBeenCalledWith(['attachments/ch-sec-1/aaaa-encrypted.bin']);
      } finally {
        errorLog.mockRestore();
      }
    });

    describe('the steps after the row delete are best effort', () => {
      let errorLog: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        prismaMock.channel.findUnique.mockResolvedValue({ id: 'sec-1', secure: true, serverId: 'srv-1', members: [{ userId: 'u1' }] });
        prismaMock.channel.delete.mockResolvedValue({});
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

    it('REFUSES to delete a plaintext channel (returns false, touches nothing)', async () => {
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-plain', secure: false, serverId: 'srv-1', members: [],
      });

      const result = await deleteSecureChannel('ch-plain');

      expect(result).toBe(false);
      expect(prismaMock.channel.delete).not.toHaveBeenCalled();
      expect(mockEmit).not.toHaveBeenCalled();
      expect(prismaMock.messageAttachment.findMany).not.toHaveBeenCalled();
      expect(mockDeleteMultipleFromS3).not.toHaveBeenCalled();
    });

    it('returns false for a nonexistent channel', async () => {
      prismaMock.channel.findUnique.mockResolvedValue(null);

      expect(await deleteSecureChannel('ghost')).toBe(false);
    });

    it('a failed S3 cleanup does not fail the deletion (logged, fire-and-forget)', async () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'sec-1', secure: true, serverId: 'srv-1',
        members: [{ userId: 'u1' }],
      });
      prismaMock.messageAttachment.findMany.mockResolvedValueOnce([{ id: 'att-1', s3Key: 'attachments/ch-sec-1/x-encrypted.bin' }]);
      prismaMock.channel.delete.mockResolvedValue({});
      mockDeleteMultipleFromS3.mockRejectedValue(new Error('s3 down'));

      const result = await deleteSecureChannel('sec-1');
      // Let the fire-and-forget rejection settle
      await new Promise((r) => setImmediate(r));

      expect(result).toBe(true);
      expect(consoleWarn).toHaveBeenCalledWith(
        '[SecureChannel] Attachment file cleanup failed for deleted channel sec-1 (the orphan sweep will reclaim them):', 's3 down');
      consoleWarn.mockRestore();
    });
  });

  describe('removeSecureMember', () => {
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
          order.push(`lock:${strings.join('?').includes('server_id =') ? 'space' : 'account'}`);
          return [{ id: 'sec-own', server_id: 'srv-1' }];
        }),
        channelMember: {
          findMany: vi.fn(async ({ where }: any) => {
            if (where.channelId) {
              order.push('read:created-members');
              return [{ channelId: 'sec-own', userId: 'u1' }, { channelId: 'sec-own', userId: 'u9' }];
            }
            order.push('read:rows');
            return [{ channelId: 'sec-other', channel: { serverId: 'srv-1' } }];
          }),
          deleteMany: vi.fn(async () => { order.push('delete:rows'); return { count: 1 }; }),
        },
        channel: { deleteMany: vi.fn(async () => { order.push('delete:created'); return { count: 1 }; }) },
        e2EKeyShare: { deleteMany: vi.fn(async () => { order.push('delete:shares'); return { count: 0 }; }) },
      };
    });

    it('locks the channels the user created in the space, reads their members, deletes them, then removes every other row and the key shares', async () => {
      const removal = await removeSecureMembershipsInTx(tx as any, 'u1', 'srv-1');

      expect(order).toEqual(['lock:space', 'read:created-members', 'delete:created', 'read:rows', 'delete:rows', 'delete:shares']);
      const lockSql = (tx.$queryRaw.mock.calls[0][0] as string[]).join('?');
      expect(lockSql).toMatch(/created_by_id = \? AND server_id = \? AND secure = true[\s\S]*FOR UPDATE/);
      expect(tx.$queryRaw.mock.calls[0].slice(1)).toEqual(['u1', 'srv-1']);
      expect(tx.channel.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['sec-own'] }, secure: true } });
      // Every channel of the space, not only the secure ones: no row may
      // survive the membership
      expect(tx.channelMember.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1', channel: { serverId: 'srv-1' } } });
      expect(tx.e2EKeyShare.deleteMany).toHaveBeenCalledWith({
        where: { recipientUserId: 'u1', conversationId: { in: ['ch:sec-own', 'ch:sec-other'] } },
      });
      expect(removal).toEqual({
        userId: 'u1',
        deleted: [{ channelId: 'sec-own', serverId: 'srv-1', memberIds: ['u1', 'u9'] }],
        left: [{ channelId: 'sec-other', serverId: 'srv-1' }],
      });
    });

    it('without a space (account deletion) covers every space the user is in', async () => {
      await removeSecureMembershipsInTx(tx as any, 'u1');

      expect(order[0]).toBe('lock:account');
      expect(tx.$queryRaw.mock.calls[0].slice(1)).toEqual(['u1']);
      expect(tx.channelMember.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    });

    it('a user who created nothing and belongs to no secure channel: no channel delete, no key-share statement', async () => {
      tx.$queryRaw.mockResolvedValue([]);
      tx.channelMember.findMany.mockResolvedValue([]);

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
