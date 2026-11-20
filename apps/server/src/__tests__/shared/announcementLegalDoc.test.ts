import { describe, it, expect } from 'vitest';
import { ANNOUNCEMENT_LEGAL_DOCS, isAnnouncementLegalDoc } from '@voxium/shared';

describe('announcement legal documents', () => {
  it('lists the three documents', () => {
    expect([...ANNOUNCEMENT_LEGAL_DOCS]).toEqual(['privacy', 'terms', 'cookies']);
  });

  it.each(['privacy', 'terms', 'cookies'])('accepts %s', (v) => {
    expect(isAnnouncementLegalDoc(v)).toBe(true);
  });

  it.each([['Privacy'], [''], ['imprint'], [null], [undefined], [1], [{}], [['privacy']], ['privacy ']])(
    'refuses %j',
    (v) => {
      expect(isAnnouncementLegalDoc(v)).toBe(false);
    },
  );
});
