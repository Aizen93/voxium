// @vitest-environment node
// Structured E2E plaintext payload (docs/e2e-dm-spec.md §13): text-only
// messages stay raw strings; attachment-bearing messages become a
// control-character-prefixed JSON payload. Both directions validated here.
import { describe, it, expect } from 'vitest';
import {
  buildE2EPlaintext,
  parseE2EPlaintext,
  E2E_PAYLOAD_PREFIX,
  buildE2EEnvelope,
  buildMegolmEnvelope,
  parseE2EEnvelope,
  e2eDeviceCanonical,
  e2eKeyCanonical,
  E2E_LIMITS,
  E2E_DEVICE_ID_RE,
} from '@voxium/shared';
import type { E2EAttachmentMeta } from '@voxium/shared';

const meta: E2EAttachmentMeta = {
  s3Key: 'attachments/dm-conv1/abc123-encrypted.bin',
  fileName: 'vacation photo.png',
  fileSize: 123_456,
  mimeType: 'image/png',
  key: 'q83vEjRWeJq83vEjRWeJq83vEjRWeJq83vEjRWeJq83',
  iv: 'q83vEjRWeJq83vEj',
};

describe('E2E plaintext payload', () => {
  it('keeps text-only messages as raw strings (wire compatibility)', () => {
    expect(buildE2EPlaintext('hello')).toBe('hello');
    expect(buildE2EPlaintext('hello', [])).toBe('hello');
    expect(parseE2EPlaintext('hello')).toEqual({ text: 'hello', attachments: [] });
  });

  it('round-trips text + attachment metas through the structured format', () => {
    const raw = buildE2EPlaintext('check this out', [meta]);
    expect(raw.startsWith(E2E_PAYLOAD_PREFIX)).toBe(true);
    const parsed = parseE2EPlaintext(raw);
    expect(parsed.text).toBe('check this out');
    expect(parsed.attachments).toEqual([meta]);
  });

  it('round-trips attachment-only messages (empty text)', () => {
    const parsed = parseE2EPlaintext(buildE2EPlaintext('', [meta]));
    expect(parsed.text).toBe('');
    expect(parsed.attachments).toHaveLength(1);
  });

  it('raw text can never collide with the structured format', () => {
    // the prefix is a control character — not typeable in a message input
    expect(E2E_PAYLOAD_PREFIX.charCodeAt(0)).toBe(1);
    // user text that LOOKS like the JSON shape passes through as text
    const jsonish = '{"v":1,"t":"fake","a":[]}';
    expect(parseE2EPlaintext(jsonish)).toEqual({ text: jsonish, attachments: [] });
  });

  it('treats malformed structured payloads as unrenderable, not as text', () => {
    for (const bad of [
      E2E_PAYLOAD_PREFIX + 'not json',
      E2E_PAYLOAD_PREFIX + JSON.stringify({ v: 2, t: 'x', a: [] }),
      E2E_PAYLOAD_PREFIX + JSON.stringify({ v: 1, t: 42, a: [] }),
      E2E_PAYLOAD_PREFIX + JSON.stringify({ v: 1, t: 'x', a: 'nope' }),
    ]) {
      expect(parseE2EPlaintext(bad)).toEqual({ text: '', attachments: [] });
    }
  });

  it('drops individually invalid metas (peer-authored input is untrusted)', () => {
    const bad = { ...meta, key: 'not-a-key' };
    const missing = { ...meta } as Record<string, unknown>;
    delete missing.iv;
    const raw = buildE2EPlaintext('mixed', [bad as E2EAttachmentMeta, meta, missing as unknown as E2EAttachmentMeta]);
    const parsed = parseE2EPlaintext(raw);
    expect(parsed.text).toBe('mixed');
    expect(parsed.attachments).toEqual([meta]);
  });
});

// ─── Envelopes (both engines) ───────────────────────────────────────────────

describe('E2E envelope', () => {
  it('round-trips an olm1 envelope (legacy history + key-share transport)', () => {
    for (const t of [0, 1] as const) {
      const raw = buildE2EEnvelope(t, 'QWJjZGVm');
      expect(parseE2EEnvelope(raw)).toEqual({ v: 1, e: 'olm1', t, b: 'QWJjZGVm' });
    }
  });

  it('round-trips a megolm1 envelope', () => {
    const raw = buildMegolmEnvelope('c2Vzc2lvbklk', 'QWJjZGVm');
    expect(JSON.parse(raw)).toEqual({ v: 1, e: 'megolm1', sid: 'c2Vzc2lvbklk', b: 'QWJjZGVm' });
    expect(parseE2EEnvelope(raw)).toEqual({ v: 1, e: 'megolm1', sid: 'c2Vzc2lvbklk', b: 'QWJjZGVm' });
  });

  it('rejects structurally invalid envelopes', () => {
    for (const bad of [
      '',
      'not json',
      '[]',
      JSON.stringify({ v: 2, e: 'olm1', t: 0, b: 'QWJj' }),
      JSON.stringify({ v: 1, e: 'other', t: 0, b: 'QWJj' }),
      JSON.stringify({ v: 1, e: 'olm1', t: 2, b: 'QWJj' }),
      JSON.stringify({ v: 1, e: 'olm1', t: 0, b: '' }),
      JSON.stringify({ v: 1, e: 'olm1', t: 0, b: 'not base64 !!' }),
      JSON.stringify({ v: 1, e: 'olm1', t: 0, b: 'QWJj', x: 1 }), // extra key
      JSON.stringify({ v: 1, e: 'olm1', b: 'QWJj' }), // too few keys
      JSON.stringify({ v: 1, e: 'megolm1', b: 'QWJj' }), // sid missing
      JSON.stringify({ v: 1, e: 'megolm1', sid: '', b: 'QWJj' }),
      JSON.stringify({ v: 1, e: 'megolm1', sid: 'bad sid!', b: 'QWJj' }),
      JSON.stringify({ v: 1, e: 'megolm1', sid: 'AAAA', t: 0, b: 'QWJj' }), // extra key
      // the two engines never share fields — an olm1 `t` cannot ride on megolm1
      JSON.stringify({ v: 1, e: 'megolm1', sid: 'A'.repeat(65), b: 'QWJj' }),
    ]) {
      expect(parseE2EEnvelope(bad)).toBeNull();
    }
  });

  it('caps envelope size', () => {
    const oversized = buildMegolmEnvelope('AAAA', 'A'.repeat(E2E_LIMITS.ENVELOPE_MAX));
    expect(parseE2EEnvelope(oversized)).toBeNull();
  });
});

// ─── Canonical signature payloads (v2 binds the deviceId) ───────────────────

describe('E2E canonical strings', () => {
  it('binds userId, deviceId and both identity keys', () => {
    expect(e2eDeviceCanonical('u1', 'device-aaaa1111', 'CURVE', 'ED')).toBe(
      'voxium-e2e-v2|device|u1|device-aaaa1111|CURVE|ED'
    );
    expect(e2eKeyCanonical('u1', 'device-aaaa1111', 'CURVE', 'kid', 'PUB')).toBe(
      'voxium-e2e-v2|key|u1|device-aaaa1111|CURVE|kid|PUB'
    );
  });

  it('produces a different canonical per device slot (no cross-device replay)', () => {
    expect(e2eDeviceCanonical('u1', 'device-aaaa1111', 'C', 'E')).not.toBe(
      e2eDeviceCanonical('u1', 'device-bbbb2222', 'C', 'E')
    );
    expect(e2eKeyCanonical('u1', 'device-aaaa1111', 'C', 'k', 'P')).not.toBe(
      e2eKeyCanonical('u1', 'device-bbbb2222', 'C', 'k', 'P')
    );
  });

  it('accepts only URL-safe device ids of 8–32 chars', () => {
    for (const ok of ['abcd1234', 'A-_'.padEnd(8, 'x'), 'x'.repeat(32)]) {
      expect(E2E_DEVICE_ID_RE.test(ok)).toBe(true);
    }
    for (const bad of ['short', 'x'.repeat(33), 'has space', 'plus+slash/', '']) {
      expect(E2E_DEVICE_ID_RE.test(bad)).toBe(false);
    }
  });
});
