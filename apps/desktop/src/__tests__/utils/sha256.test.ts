import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256Hex } from '../../utils/sha256';

// The synchronous SHA-256 the desktop app names its E2E vault with
// (services/e2e/vault.ts): it must give what node:crypto gives, which is also
// what the self-hosted build overlay hashes the same origin with
// (scripts/tauriSelfHosted.mjs).

const reference = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('sha256Hex', () => {
  it('matches the published test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('matches node:crypto on every padding boundary and across several blocks', () => {
    for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000]) {
      const text = Array.from({ length }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
      expect(sha256Hex(text), String(length)).toBe(reference(text));
    }
  });

  it('digests the UTF-8 bytes, like node:crypto does for a string', () => {
    for (const text of ['https://xn--bcher-kva.example', 'Bücher', '日本語', '🎙️ voice', 'https://chat.example.org.']) {
      expect(sha256Hex(text), text).toBe(reference(text));
    }
  });
});
