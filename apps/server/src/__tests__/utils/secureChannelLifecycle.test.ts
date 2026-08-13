import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WS_EVENTS } from '@voxium/shared';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const prismaMock: Record<string, any> = {
  channel: { findUnique: vi.fn(), findMany: vi.fn(), delete: vi.fn() },
  channelMember: { findMany: vi.fn(), deleteMany: vi.fn() },
  channelRead: { deleteMany: vi.fn() },
  e2EKeyShare: { deleteMany: vi.fn() },
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
  deleteMultipleFromS3: (...args: any[]) => mockDeleteMultipleFromS3(...args),
}));

import {
  deleteSecureChannel,
  deleteSecureChannelsOwnedBy,
  removeSecureMember,
  purgeSecureChannelState,
} from '../../utils/secureChannelLifecycle';

describe('secureChannelLifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteMultipleFromS3.mockResolvedValue(undefined);
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
        messages: [
          { attachments: [{ s3Key: 'attachments/ch-sec-1/aaaa-encrypted.bin' }] },
          { attachments: [{ s3Key: 'attachments/ch-sec-1/bbbb-encrypted.bin' }] },
        ],
      });
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

    it('REFUSES to delete a plaintext channel (returns false, touches nothing)', async () => {
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'ch-plain', secure: false, serverId: 'srv-1', members: [], messages: [],
      });

      const result = await deleteSecureChannel('ch-plain');

      expect(result).toBe(false);
      expect(prismaMock.channel.delete).not.toHaveBeenCalled();
      expect(mockEmit).not.toHaveBeenCalled();
    });

    it('returns false for a nonexistent channel', async () => {
      prismaMock.channel.findUnique.mockResolvedValue(null);

      expect(await deleteSecureChannel('ghost')).toBe(false);
    });

    it('a failed S3 cleanup does not fail the deletion (logged, fire-and-forget)', async () => {
      const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'sec-1', secure: true, serverId: 'srv-1',
        members: [{ userId: 'u1' }],
        messages: [{ attachments: [{ s3Key: 'attachments/ch-sec-1/x-encrypted.bin' }] }],
      });
      prismaMock.channel.delete.mockResolvedValue({});
      mockDeleteMultipleFromS3.mockRejectedValue(new Error('s3 down'));

      const result = await deleteSecureChannel('sec-1');
      // Let the fire-and-forget rejection settle
      await new Promise((r) => setImmediate(r));

      expect(result).toBe(true);
      expect(consoleErr).toHaveBeenCalled();
      consoleErr.mockRestore();
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

  describe('purgeSecureChannelState (leave/kick)', () => {
    it('deletes created channels and removes other memberships', async () => {
      // deleteSecureChannelsOwnedBy: one created channel
      prismaMock.channel.findMany.mockResolvedValue([{ id: 'sec-own' }]);
      prismaMock.channel.findUnique.mockResolvedValue({
        id: 'sec-own', secure: true, serverId: 'srv-1',
        members: [{ userId: 'u1' }, { userId: 'u9' }], messages: [],
      });
      prismaMock.channel.delete.mockResolvedValue({});
      // remaining membership in someone else's channel
      prismaMock.channelMember.findMany
        .mockResolvedValueOnce([{ channelId: 'sec-other' }]) // memberships query
        .mockResolvedValue([]); // members payload for broadcast

      await purgeSecureChannelState('u1', 'srv-1');

      expect(prismaMock.channel.findMany).toHaveBeenCalledWith({
        where: { createdById: 'u1', secure: true, serverId: 'srv-1' },
        select: { id: true },
      });
      expect(prismaMock.channel.delete).toHaveBeenCalledWith({ where: { id: 'sec-own' } });
      expect(prismaMock.channelMember.deleteMany).toHaveBeenCalledWith({
        where: { channelId: 'sec-other', userId: 'u1' },
      });
    });

    it('one failing channel delete does not abort the rest', async () => {
      const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
      prismaMock.channel.findMany.mockResolvedValue([{ id: 'sec-a' }, { id: 'sec-b' }]);
      prismaMock.channel.findUnique
        .mockRejectedValueOnce(new Error('db hiccup'))
        .mockResolvedValueOnce({
          id: 'sec-b', secure: true, serverId: 'srv-1', members: [], messages: [],
        });
      prismaMock.channel.delete.mockResolvedValue({});

      await deleteSecureChannelsOwnedBy('u1', 'srv-1');

      expect(prismaMock.channel.delete).toHaveBeenCalledWith({ where: { id: 'sec-b' } });
      expect(consoleErr).toHaveBeenCalled();
      consoleErr.mockRestore();
    });
  });
});
