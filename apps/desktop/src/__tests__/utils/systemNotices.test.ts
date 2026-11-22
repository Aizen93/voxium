import { describe, it, expect } from 'vitest';
import { DM_SYSTEM_NOTICES } from '@voxium/shared';
import { dmNoticeTranslation, supportNoticeTranslation } from '../../utils/systemNotices';

describe('dmNoticeTranslation', () => {
  it('maps every sentence of the shared closed list to a key of its own', () => {
    const keys = DM_SYSTEM_NOTICES.map((s) => dmNoticeTranslation(s)?.key);
    expect(keys.every((k) => typeof k === 'string')).toBe(true);
    expect(new Set(keys).size).toBe(DM_SYSTEM_NOTICES.length);
  });

  it('shows anything else as it is (exact match only)', () => {
    for (const s of ['voice call started', 'Voice call started ', 'Voice call', '', 'constructor', '__proto__', 'Alice: hi']) {
      expect(dmNoticeTranslation(s)).toBeNull();
    }
  });
});

describe('supportNoticeTranslation', () => {
  it('maps the two fixed sentences', () => {
    expect(supportNoticeTranslation('Support ticket opened')).toEqual({ key: 'support.noticeOpened' });
    expect(supportNoticeTranslation('Support ticket reopened')).toEqual({ key: 'support.noticeReopened' });
  });

  it('maps both templates and hands the name back as plain text', () => {
    expect(supportNoticeTranslation('Staff member Dana has joined the conversation')).toEqual({
      key: 'support.noticeStaffJoined',
      params: { name: 'Dana' },
    });
    expect(supportNoticeTranslation('Ticket closed by Dana')).toEqual({
      key: 'support.noticeClosedBy',
      params: { name: 'Dana' },
    });
    // a name is never parsed: markup and template syntax stay text
    expect(supportNoticeTranslation('Ticket closed by <b>x</b> {{y}}')?.params?.name).toBe('<b>x</b> {{y}}');
    expect(supportNoticeTranslation('Staff member has has joined the conversation')?.params?.name).toBe('has');
  });

  it('shows an unknown sentence, or a template with no name, as it is', () => {
    for (const s of [
      'Ticket closed by ',
      'Staff member  has joined the conversation',
      'Staff member Dana has joined',
      'Hello Ticket closed by Dana',
      'Support ticket opened.',
      'constructor',
      '',
    ]) {
      expect(supportNoticeTranslation(s)).toBeNull();
    }
  });
});
