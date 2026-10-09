import { describe, it, expect } from 'vitest';
import {
  buildVoiceKeyPlaintext,
  parseVoiceKeyPlaintext,
  parseE2EScope,
  e2eVoiceScope,
  e2eChannelScope,
  voiceFrameAadPrefix,
  E2E_VOICE_KEY_PLAINTEXT_MAX,
  VOICE_KEY_ID_MAX,
  VOICE_FRAME_MIN_BYTES,
  VOICE_FRAME_HEADER_BYTES,
  VOICE_FRAME_TAG_BYTES,
  type E2EVoiceKeyPlaintext,
} from '@voxium/shared';

// The voice-key plaintext distributes a media sender key to one peer device.
// The parser is a security boundary: anything it lets through installs an
// AES-GCM key in the receiver's frame-decryption worker.

const KEY_B64 = 'A'.repeat(43); // 32 bytes, unpadded standard base64

function valid(over: Partial<E2EVoiceKeyPlaintext> = {}): E2EVoiceKeyPlaintext {
  return {
    v: 1,
    scope: 'chv:channel-1',
    senderUserId: 'user-1',
    senderDeviceId: 'device-aaaa1111',
    epoch: 'epoch-abc123',
    recipientEpoch: 'epoch-xyz789',
    seq: 0,
    keyId: 0,
    keyB64: KEY_B64,
    reason: 'initial',
    ...over,
  };
}

describe('voice-key plaintext build/parse', () => {
  it('round-trips all three reasons', () => {
    for (const reason of ['initial', 'ratchet', 'fresh'] as const) {
      const p = valid({ reason, seq: 3, keyId: 7 });
      expect(parseVoiceKeyPlaintext(buildVoiceKeyPlaintext(p))).toEqual(p);
    }
  });

  it('rejects structural garbage', () => {
    for (const raw of ['', 'not json', '[]', 'null', '42', JSON.stringify([valid()])]) {
      expect(parseVoiceKeyPlaintext(raw)).toBeNull();
    }
  });

  it('rejects every field deviation', () => {
    const bad: Array<Partial<Record<keyof E2EVoiceKeyPlaintext, unknown>>> = [
      { v: 2 },
      { scope: 'ch:channel-1' },        // MESSAGE scope must never install a media key
      { scope: 'conv-1' },              // DM scope likewise
      { scope: 'chv:' + 'x'.repeat(80) },
      { senderUserId: '' },
      { senderDeviceId: 'bad device!' },
      { epoch: 'no' },                  // too short for the epoch regex
      { recipientEpoch: 'no' },         // the recipient-session binding (§21)
      { seq: -1 },
      { seq: 1.5 },
      { keyId: -1 },
      { keyId: VOICE_KEY_ID_MAX },
      { keyB64: 'short' },
      { keyB64: KEY_B64 + '=' },        // padded — not the canonical encoding
      { reason: 'rotate' },
    ];
    for (const over of bad) {
      const raw = JSON.stringify({ ...valid(), ...over });
      expect(parseVoiceKeyPlaintext(raw), JSON.stringify(over)).toBeNull();
    }
  });

  it('rejects extra and missing keys (smuggling / truncation)', () => {
    const extra = JSON.stringify({ ...valid(), smuggled: true });
    expect(parseVoiceKeyPlaintext(extra)).toBeNull();

    const missing = { ...valid() } as Record<string, unknown>;
    delete missing.keyB64;
    expect(parseVoiceKeyPlaintext(JSON.stringify(missing))).toBeNull();

    // A pre-binding sender (no recipientEpoch) must not parse: accepting it
    // would reopen dead-session key installs (spec §21).
    const unbound = { ...valid() } as Record<string, unknown>;
    delete unbound.recipientEpoch;
    expect(parseVoiceKeyPlaintext(JSON.stringify(unbound))).toBeNull();
  });

  it('rejects oversized plaintexts', () => {
    const raw = JSON.stringify({ ...valid(), senderUserId: 'x'.repeat(E2E_VOICE_KEY_PLAINTEXT_MAX) });
    expect(parseVoiceKeyPlaintext(raw)).toBeNull();
  });
});

describe('voice scope separation', () => {
  it('chv: and ch: scopes never collapse into each other', () => {
    expect(parseE2EScope(e2eVoiceScope('abc'))).toEqual({ kind: 'voice-channel', channelId: 'abc' });
    expect(parseE2EScope(e2eChannelScope('abc'))).toEqual({ kind: 'channel', channelId: 'abc' });
    expect(parseE2EScope('abc')).toEqual({ kind: 'dm', conversationId: 'abc' });
    // A channel id that HAPPENS to start with 'v:' must not turn a message
    // scope into a voice scope: 'ch:' + 'v:x' === 'chv' + ':x'? No — verify.
    expect(parseE2EScope('ch:' + 'v-x')).toEqual({ kind: 'channel', channelId: 'v-x' });
  });

  it('frame AAD prefix binds channel and sender through the voice scope', () => {
    expect(voiceFrameAadPrefix('chan-9', 'user-2')).toBe('voxv1|chv:chan-9|user-2');
  });

  it('frame constants are internally consistent', () => {
    expect(VOICE_FRAME_MIN_BYTES).toBe(VOICE_FRAME_HEADER_BYTES + VOICE_FRAME_TAG_BYTES);
  });
});
