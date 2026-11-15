import { describe, it, expect } from 'vitest';
import {
  DELETED_MESSAGE_TYPE,
  DELETED_PARTICIPANT_ID_PREFIX,
  OPAQUE_ID_RE,
  WEBHOOK_AUTHOR_ID_PREFIX,
  WS_EVENTS,
  isDeletedMessagePlaceholder,
  isDeletedParticipantId,
  isDMSystemNotice,
  type Conversation,
  type ServerToClientEvents,
} from '@voxium/shared';

// The shared surface of conversations that outlive one side (#47, #48, #131):
// the placeholder id prefix and its recogniser, the placeholder message type
// and its recogniser, the nullable sides and the two events. Types and
// constants only: nothing in this change emits or handles the events yet.

describe('DELETED_PARTICIPANT_ID_PREFIX', () => {
  it('is `deleted:`, beside and distinct from the webhook prefix', () => {
    expect(DELETED_PARTICIPANT_ID_PREFIX).toBe('deleted:');
    expect(DELETED_PARTICIPANT_ID_PREFIX).not.toBe(WEBHOOK_AUTHOR_ID_PREFIX);
    expect(WEBHOOK_AUTHOR_ID_PREFIX.startsWith(DELETED_PARTICIPANT_ID_PREFIX)).toBe(false);
    expect(DELETED_PARTICIPANT_ID_PREFIX.startsWith(WEBHOOK_AUTHOR_ID_PREFIX)).toBe(false);
  });

  it('can NEVER pass the opaque-id check, and can never equal a user id (a cuid holds no colon)', () => {
    expect(DELETED_PARTICIPANT_ID_PREFIX).toContain(':');
    for (const id of [`${DELETED_PARTICIPANT_ID_PREFIX}cmconv000000000000000001`, `${DELETED_PARTICIPANT_ID_PREFIX}x`]) {
      expect(OPAQUE_ID_RE.test(id), id).toBe(false);
      // user ids are cuids (`@default(cuid())`): lower-case letters and digits
      expect(id, id).not.toMatch(/^[a-z0-9]+$/);
    }
  });
});

describe('isDeletedParticipantId', () => {
  it('recognises the placeholder id', () => {
    expect(isDeletedParticipantId('deleted:conv-1')).toBe(true);
    expect(isDeletedParticipantId('deleted:')).toBe(true);
  });

  it('refuses a user id, a webhook author id, a near miss and a non-string', () => {
    for (const id of ['cmuser000000000000000001', 'deleted', 'webhook:wh-1', 'webhook:deleted', 'Deleted:conv-1', ' deleted:conv-1', '', null, undefined, 42, {}]) {
      expect(isDeletedParticipantId(id), String(id)).toBe(false);
    }
  });
});

describe('DELETED_MESSAGE_TYPE and isDeletedMessagePlaceholder', () => {
  it('is the type `deleted`, neither of the two types rows carry today', () => {
    expect(DELETED_MESSAGE_TYPE).toBe('deleted');
    expect(['user', 'system']).not.toContain(DELETED_MESSAGE_TYPE);
  });

  it('recognises the placeholder: the type, not encrypted, empty content', () => {
    expect(isDeletedMessagePlaceholder({ type: 'deleted', encrypted: false, content: '' })).toBe(true);
    // `encrypted` absent reads as not encrypted, as the wire type allows
    expect(isDeletedMessagePlaceholder({ type: 'deleted', content: '' })).toBe(true);
  });

  it('refuses a row that names the type but carries ciphertext or text (the type is the server\'s word)', () => {
    expect(isDeletedMessagePlaceholder({ type: 'deleted', encrypted: true, content: '' })).toBe(false);
    expect(isDeletedMessagePlaceholder({ type: 'deleted', encrypted: false, content: 'hello' })).toBe(false);
    expect(isDeletedMessagePlaceholder({ type: 'deleted', encrypted: false })).toBe(false);
  });

  it('refuses every other row: a user row, a call notice, a refused (unable to decrypt) row', () => {
    expect(isDeletedMessagePlaceholder({ type: 'user', encrypted: false, content: '' })).toBe(false);
    expect(isDeletedMessagePlaceholder({ type: 'system', encrypted: false, content: 'Voice call started' })).toBe(false);
    expect(isDeletedMessagePlaceholder({ type: 'user', encrypted: true, content: '' })).toBe(false);
    expect(isDeletedMessagePlaceholder({})).toBe(false);
  });

  it('is never a call notice, so the display gate can never pass one as plaintext', () => {
    expect(isDMSystemNotice('')).toBe(false);
  });
});

describe('the conversation and its events', () => {
  it('lists the read-only event beside the delete event', () => {
    expect(WS_EVENTS.DM_CONVERSATION_DELETED).toBe('dm:conversation:deleted');
    expect(WS_EVENTS.DM_CONVERSATION_READ_ONLY).toBe('dm:conversation:read_only');
  });

  it('types both sides as nullable and participantDeleted as optional (compile-time, asserted on values)', () => {
    const live: Conversation = {
      id: 'conv-1',
      user1Id: 'user-1',
      user2Id: 'user-2',
      participant: { id: 'user-2', username: 'bob', displayName: 'Bob', avatarUrl: null },
      lastMessage: null,
      encryptedAt: '2026-11-16T00:00:00.000Z',
      createdAt: '2026-11-16T00:00:00.000Z',
    };
    const outlived: Conversation = {
      ...live,
      user2Id: null,
      participant: { id: 'deleted:conv-1', username: 'deleted', displayName: 'Deleted user', avatarUrl: null },
      participantDeleted: true,
    };
    expect(live).not.toHaveProperty('participantDeleted');
    expect(outlived.user2Id).toBeNull();
  });

  it('types the two events\' payloads (compile-time: clearedUntil optional, read_only carries the id)', () => {
    const deleted: Parameters<ServerToClientEvents['dm:conversation:deleted']>[0][] = [
      { conversationId: 'conv-1' },
      { conversationId: 'conv-1', clearedUntil: '2026-11-16T00:00:00.000Z' },
    ];
    const readOnly: Parameters<ServerToClientEvents['dm:conversation:read_only']>[0] = { conversationId: 'conv-1' };
    expect(deleted).toHaveLength(2);
    expect(readOnly.conversationId).toBe('conv-1');
  });
});
