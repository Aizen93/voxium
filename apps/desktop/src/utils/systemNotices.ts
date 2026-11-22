import { DM_NOTICE_CALL_STARTED, DM_NOTICE_CALL_ENDED } from '@voxium/shared';

/**
 * Display-only translation of the server's fixed notice sentences. The server
 * stores these as English text; nothing here changes what a row may carry (the
 * display gate and `DM_SYSTEM_NOTICES` still decide that). A sentence is
 * mapped by EXACT match against the known fixed parts, a name inside one is
 * handed back as plain text for interpolation, and anything unknown is left
 * for the caller to show as it is.
 */

export interface NoticeTranslation {
  key: string;
  params?: { name: string };
}

const DM_NOTICE_KEYS: Readonly<Record<string, string>> = {
  [DM_NOTICE_CALL_STARTED]: 'dm.callStarted',
  [DM_NOTICE_CALL_ENDED]: 'dm.callEnded',
};

const SUPPORT_NOTICE_KEYS: Readonly<Record<string, string>> = {
  'Support ticket opened': 'support.noticeOpened',
  'Support ticket reopened': 'support.noticeReopened',
};

const STAFF_JOINED_PREFIX = 'Staff member ';
const STAFF_JOINED_SUFFIX = ' has joined the conversation';
const TICKET_CLOSED_PREFIX = 'Ticket closed by ';

// Own-property lookup: a sentence like "constructor" must not hit the prototype.
function lookup(table: Readonly<Record<string, string>>, content: string): string | null {
  return Object.prototype.hasOwnProperty.call(table, content) ? table[content] : null;
}

/** The key of a call notice sentence, or null for anything else. */
export function dmNoticeTranslation(content: string): NoticeTranslation | null {
  const key = lookup(DM_NOTICE_KEYS, content);
  return key ? { key } : null;
}

/** The key (and name) of a support-ticket notice sentence, or null for anything else. */
export function supportNoticeTranslation(content: string): NoticeTranslation | null {
  const key = lookup(SUPPORT_NOTICE_KEYS, content);
  if (key) return { key };
  if (
    content.startsWith(STAFF_JOINED_PREFIX) &&
    content.endsWith(STAFF_JOINED_SUFFIX) &&
    content.length > STAFF_JOINED_PREFIX.length + STAFF_JOINED_SUFFIX.length
  ) {
    return {
      key: 'support.noticeStaffJoined',
      params: { name: content.slice(STAFF_JOINED_PREFIX.length, content.length - STAFF_JOINED_SUFFIX.length) },
    };
  }
  if (content.startsWith(TICKET_CLOSED_PREFIX) && content.length > TICKET_CLOSED_PREFIX.length) {
    return { key: 'support.noticeClosedBy', params: { name: content.slice(TICKET_CLOSED_PREFIX.length) } };
  }
  return null;
}
