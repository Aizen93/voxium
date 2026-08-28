import { describe, it, expect } from 'vitest';
import {
  buildCallSignalPlaintext,
  parseCallSignalPlaintext,
  E2E_CALL_SIGNAL_PLAINTEXT_MAX,
  type E2ECallSignalPlaintext,
} from '@voxium/shared';

// The call-signal plaintext is what a peer DEVICE authenticates with Olm and
// what the receiver then re-verifies against its own call state. The parser is
// a security boundary: anything it lets through reaches Perfect Negotiation.

function valid(over: Partial<E2ECallSignalPlaintext> = {}): E2ECallSignalPlaintext {
  return {
    v: 1,
    conversationId: 'conv-1',
    senderUserId: 'user-1',
    senderDeviceId: 'device-aaaa1111',
    epoch: 'epoch-abc123',
    seq: 0,
    signal: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n' },
    ...over,
  };
}

describe('call-signal plaintext build/parse', () => {
  it('round-trips offers, answers and candidates', () => {
    for (const signal of [
      { type: 'offer' as const, sdp: 'sdp-offer' },
      { type: 'answer' as const, sdp: 'sdp-answer' },
      { type: 'ice-candidate' as const, candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0' } },
    ]) {
      const p = valid({ signal, seq: 7 });
      expect(parseCallSignalPlaintext(buildCallSignalPlaintext(p))).toEqual(p);
    }
  });

  it('rejects structural garbage', () => {
    for (const raw of ['', 'not json', '[]', 'null', '42', JSON.stringify([valid()])]) {
      expect(parseCallSignalPlaintext(raw)).toBeNull();
    }
  });

  it('rejects wrong version and missing/invalid fields', () => {
    const cases: Array<Partial<E2ECallSignalPlaintext> | Record<string, unknown>> = [
      { v: 2 },
      { conversationId: '' },
      { conversationId: 'x'.repeat(65) },
      { senderUserId: '' },
      { senderDeviceId: 'bad device id!' },
      { senderDeviceId: 'short' },
      { epoch: 'nope!' },
      { epoch: '' },
      { seq: -1 },
      { seq: 1.5 },
      { seq: '3' as unknown as number },
      { signal: { type: 'offer' } }, // no sdp
      { signal: { type: 'offer', sdp: '' } },
      { signal: { type: 'ice-candidate' } }, // no candidate
      { signal: { type: 'ice-candidate', candidate: 'string' } },
      { signal: { type: 'renegotiate', sdp: 'x' } }, // unknown type
      { signal: null },
    ];
    for (const over of cases) {
      const p = { ...valid(), ...over };
      expect(parseCallSignalPlaintext(JSON.stringify(p)), JSON.stringify(over)).toBeNull();
    }
  });

  it('rejects extra fields — no smuggling channel beside the verified ones', () => {
    const p = { ...valid(), extra: 'smuggled' };
    expect(parseCallSignalPlaintext(JSON.stringify(p))).toBeNull();
  });

  it('rejects oversized plaintext', () => {
    const p = valid({ signal: { type: 'offer', sdp: 'x'.repeat(E2E_CALL_SIGNAL_PLAINTEXT_MAX) } });
    expect(parseCallSignalPlaintext(JSON.stringify(p))).toBeNull();
  });

  it('accepts a realistic large audio SDP well under the cap', () => {
    const p = valid({ signal: { type: 'offer', sdp: 'a=candidate\r\n'.repeat(400) } }); // ~5 KB
    expect(parseCallSignalPlaintext(buildCallSignalPlaintext(p))).toEqual(p);
  });
});
