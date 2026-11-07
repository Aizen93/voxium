import { describe, it, expect, beforeEach } from 'vitest';
import { isSecureChannelId, isSecureChannelMessage } from '../../utils/secureChannelGate';
import { activateSecurePins, deactivateSecurePins, forgetSecurePins, pinSecure } from '../../utils/securePins';

const plain = { id: 'ch-plain', secure: false };
const flagged = { id: 'ch-flag', secure: true };

describe('secureChannelGate', () => {
  beforeEach(() => {
    deactivateSecurePins();
    forgetSecurePins('alice');
    activateSecurePins('alice');
  });

  it('flag only → secure', () => {
    expect(isSecureChannelId('ch-flag', [plain, flagged])).toBe(true);
    expect(isSecureChannelMessage({ channelId: 'ch-flag', encrypted: false }, [flagged])).toBe(true);
  });

  it('pin only → secure, even when the server lists it as plaintext or not at all', () => {
    pinSecure('ch-plain');
    expect(isSecureChannelId('ch-plain', [plain])).toBe(true);
    expect(isSecureChannelId('ch-plain', [])).toBe(true);
    expect(isSecureChannelMessage({ channelId: 'ch-plain' }, [plain])).toBe(true);
  });

  it('encrypted: true only → secure message', () => {
    expect(isSecureChannelMessage({ channelId: 'ch-plain', encrypted: true }, [plain])).toBe(true);
    expect(isSecureChannelMessage({ channelId: null, encrypted: true }, [])).toBe(true);
  });

  it('none → not secure', () => {
    expect(isSecureChannelId('ch-plain', [plain])).toBe(false);
    expect(isSecureChannelId('ch-unknown', [plain, flagged])).toBe(false);
    expect(isSecureChannelId(null, [flagged])).toBe(false);
    expect(isSecureChannelId(undefined, [flagged])).toBe(false);
    expect(isSecureChannelMessage({ channelId: 'ch-plain', encrypted: false }, [plain])).toBe(false);
    expect(isSecureChannelMessage({ channelId: null }, [plain])).toBe(false);
  });

  it('a pin of another account does not count', () => {
    pinSecure('ch-plain');
    deactivateSecurePins();
    activateSecurePins('bob');
    expect(isSecureChannelId('ch-plain', [plain])).toBe(false);
    deactivateSecurePins();
    forgetSecurePins('bob');
  });
});
