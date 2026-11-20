import { describe, it, expect } from 'vitest';
// The opaque-id check every member lookup applies: an id that passes it could
// be looked up as a user id
import { OPAQUE_ID_RE, DELETED_PARTICIPANT_ID_PREFIX, isDeletedParticipantId } from '@voxium/shared';
import {
  deletedParticipant,
  deletedQuoteAuthor,
  deletedParticipantId,
  otherParticipant,
  isReservedUsername,
  DELETED_PARTICIPANT_DISPLAY_NAME,
  DELETED_PARTICIPANT_USERNAME,
} from '../../utils/deletedParticipant';

const alice = {
  id: 'cmalice0000000000000000a',
  username: 'alice',
  displayName: 'Alice',
  avatarUrl: 'avatars/cmalice-1.webp',
  status: 'online',
  role: 'superadmin',
  isSupporter: true,
  supporterTier: 'top',
};
const bob = {
  id: 'cmbob00000000000000000b',
  username: 'bob',
  displayName: 'Bob',
  avatarUrl: null,
  status: 'idle',
  role: 'user',
  isSupporter: false,
  supporterTier: null,
};

describe('deletedParticipant', () => {
  it('is the neutral placeholder of the DM participant select: no avatar, offline, no badge', () => {
    expect(deletedParticipant('conv-1')).toStrictEqual({
      id: 'deleted:conv-1',
      username: 'deleted',
      displayName: 'Deleted user',
      avatarUrl: null,
      status: 'offline',
      role: 'user',
      isSupporter: false,
      supporterTier: null,
    });
    expect(DELETED_PARTICIPANT_USERNAME).toBe('deleted');
    expect(DELETED_PARTICIPANT_DISPLAY_NAME).toBe('Deleted user');
  });

  it('carries every key of the participant select GET /dm sends for a live account, so a client reading one reads the other', () => {
    expect(Object.keys(deletedParticipant('conv-1')).sort()).toEqual(Object.keys(alice).sort());
  });

  it('has an id built from the conversation, under the shared prefix, that never passes the opaque-id check', () => {
    for (const conversationId of ['conv-1', 'cmconv000000000000000001', 'x']) {
      const id = deletedParticipantId(conversationId);
      expect(id).toBe(`${DELETED_PARTICIPANT_ID_PREFIX}${conversationId}`);
      expect(id).not.toMatch(OPAQUE_ID_RE);
      expect(isDeletedParticipantId(id)).toBe(true);
      expect(deletedParticipant(conversationId).id).toBe(id);
    }
  });

  it('differs per conversation, so two conversations of one deleted account are not tied together', () => {
    expect(deletedParticipant('conv-1').id).not.toBe(deletedParticipant('conv-2').id);
  });

  it('is a fresh object each call (a caller that extends one cannot change another)', () => {
    const a = deletedParticipant('conv-1');
    const b = deletedParticipant('conv-1');
    expect(a).not.toBe(b);
    expect(a).toStrictEqual(b);
  });
});

describe('deletedQuoteAuthor', () => {
  it('is the placeholder without presence, the keys of a quote author as the DM routes select it', () => {
    expect(deletedQuoteAuthor('conv-1')).toStrictEqual({
      id: 'deleted:conv-1',
      username: 'deleted',
      displayName: 'Deleted user',
      avatarUrl: null,
      role: 'user',
      isSupporter: false,
      supporterTier: null,
    });
    expect(deletedQuoteAuthor('conv-1')).not.toHaveProperty('status');
  });

  it('is a fresh object each call, and leaves the participant placeholder whole', () => {
    expect(deletedQuoteAuthor('conv-1')).not.toBe(deletedQuoteAuthor('conv-1'));
    expect(deletedParticipant('conv-1')).toHaveProperty('status', 'offline');
  });
});

describe('otherParticipant', () => {
  const live = { id: 'conv-1', user1Id: alice.id, user2Id: bob.id, user1: alice, user2: bob };

  it('gives each side the other account, as loaded, and NO participantDeleted key at all', () => {
    const forAlice = otherParticipant(live, alice.id);
    expect(forAlice).toStrictEqual({ participant: bob });
    expect(forAlice).not.toHaveProperty('participantDeleted');
    expect(forAlice.participant).toBe(bob);

    const forBob = otherParticipant(live, bob.id);
    expect(forBob).toStrictEqual({ participant: alice });
    expect(forBob).not.toHaveProperty('participantDeleted');
  });

  it('answers the placeholder and participantDeleted: true when the second side is gone', () => {
    const conv = { id: 'conv-7', user1Id: alice.id, user2Id: null, user1: alice, user2: null };
    expect(otherParticipant(conv, alice.id)).toStrictEqual({
      participant: deletedParticipant('conv-7'),
      participantDeleted: true,
    });
  });

  it('answers the placeholder and participantDeleted: true when the first side is gone', () => {
    const conv = { id: 'conv-8', user1Id: null, user2Id: bob.id, user1: null, user2: bob };
    expect(otherParticipant(conv, bob.id)).toStrictEqual({
      participant: deletedParticipant('conv-8'),
      participantDeleted: true,
    });
  });

  it('answers the placeholder when both sides are gone (no route lists such a row: the viewer is no side)', () => {
    const conv = { id: 'conv-9', user1Id: null, user2Id: null, user1: null, user2: null };
    expect(otherParticipant(conv, alice.id)).toStrictEqual({
      participant: deletedParticipant('conv-9'),
      participantDeleted: true,
    });
  });

  it('puts nothing of the deleted account in what it sends: no id, name, avatar or status of it', () => {
    // Bob's account is the one deleted; Alice reads the conversation
    const conv = { id: 'conv-3', user1Id: alice.id, user2Id: null, user1: alice, user2: null };
    const wire = JSON.stringify(otherParticipant(conv, alice.id));
    for (const value of [bob.id, bob.username, bob.displayName, bob.status]) {
      expect(wire).not.toContain(value);
    }
    // and nothing of the viewer either
    for (const value of [alice.id, alice.username, alice.displayName, alice.avatarUrl]) {
      expect(wire).not.toContain(value);
    }
  });
});

describe('isReservedUsername', () => {
  it('the placeholder\'s name, in any case', () => {
    for (const name of ['deleted', 'Deleted', 'DELETED']) expect(isReservedUsername(name), name).toBe(true);
  });

  it('no other name, a name containing it included', () => {
    for (const name of ['deleted_user', 'undeleted', 'delete', 'alice']) expect(isReservedUsername(name), name).toBe(false);
  });
});
