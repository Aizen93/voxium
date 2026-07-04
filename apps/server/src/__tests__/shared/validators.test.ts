import { describe, it, expect } from 'vitest';
import { validatePassword, LIMITS } from '@voxium/shared';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Shared validators — validatePassword (P2 — bcrypt 72-BYTE limit)', () => {
  it('accepts a normal short password', () => {
    expect(validatePassword('password123')).toBeNull();
  });

  it('accepts exactly 72 ASCII characters (72 bytes)', () => {
    expect(validatePassword('a'.repeat(72))).toBeNull();
  });

  it('rejects 73 ASCII characters (73 bytes)', () => {
    expect(validatePassword('a'.repeat(73))).not.toBeNull();
  });

  it('rejects a multi-byte password that is under 72 chars but over 72 UTF-8 bytes', () => {
    // 30 CJK chars = 30 UTF-16 code units, but 90 UTF-8 bytes — bcrypt would
    // silently truncate at byte 72, so this must be rejected
    const password = '密'.repeat(30);
    expect(password.length).toBeLessThanOrEqual(LIMITS.PASSWORD_MAX);

    const err = validatePassword(password);
    expect(err).not.toBeNull();
    expect(err).toContain('bytes');
  });

  it('rejects passwords below PASSWORD_MIN', () => {
    const err = validatePassword('a'.repeat(LIMITS.PASSWORD_MIN - 1));
    expect(err).not.toBeNull();
    expect(err).toContain(`at least ${LIMITS.PASSWORD_MIN}`);
  });
});
