// @vitest-environment node
// Structured E2E plaintext payload (docs/e2e-dm-spec.md §13): text-only
// messages stay raw strings; attachment-bearing messages become a
// control-character-prefixed JSON payload. Both directions validated here.
import { describe, it, expect } from 'vitest';
import { buildE2EPlaintext, parseE2EPlaintext, E2E_PAYLOAD_PREFIX } from '@voxium/shared';
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
