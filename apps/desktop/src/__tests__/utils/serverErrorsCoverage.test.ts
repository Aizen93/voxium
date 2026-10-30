// @vitest-environment node
// Filesystem checks against the server source and the locale files — no DOM.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TFunction } from 'i18next';
import { LIMITS } from '@voxium/shared';
import { translateServerError, ALL_ERROR_KEYS } from '../../utils/serverErrors';

/**
 * Every English sentence a normal user can receive from the server is shown in
 * the user's language. A mapping that differs from the server's sentence by
 * one character is dead (the raw English shows instead), so each row below
 * also names WHERE the sentence is written: the test finds that exact source
 * text in the server, the shared package or the desktop's own throw sites.
 */

const t = vi.fn((key: string, opts?: Record<string, unknown>) => `${key}|${JSON.stringify(opts ?? {})}`) as unknown as TFunction;

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const LOCALE_DIR = fileURLToPath(new URL('../../i18n/locales/', import.meta.url));

/** All .ts sources (tests, generated code and this mapping module excluded) the sentences can come from. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'generated' || entry === 'locales' || entry === 'node_modules' || entry === 'dist') continue;
      out.push(...sources(full));
    } else if (/\.tsx?$/.test(entry) && !full.endsWith(join('utils', 'serverErrors.ts'))) {
      out.push(full);
    }
  }
  return out;
}
// `\'` inside a single-quoted literal reads as `'` (e.g. "the owner\'s role")
const SOURCE_TEXT = [
  join(ROOT, 'apps', 'server', 'src'),
  join(ROOT, 'packages', 'shared', 'src'),
  join(ROOT, 'apps', 'desktop', 'src'),
].flatMap(sources).map((f) => readFileSync(f, 'utf8')).join('\n').replace(/\\'/g, "'");

/** Present as a quoted literal ('…', "…" or `…`), or as the raw fragment `src` names. */
function written(message: string, src?: string): boolean {
  if (src) return SOURCE_TEXT.includes(src);
  return [`'${message}'`, `"${message}"`, `\`${message}\``].some((q) => SOURCE_TEXT.includes(q));
}

type Row = { msg: string; key: string; vars?: Record<string, number>; src?: string };

const EXACT: Row[] = [
  // ─── Session & account ───
  { msg: 'Email not verified', key: 'emailNotVerified' },
  { msg: 'Invalid or expired token', key: 'invalidOrExpiredToken' },
  { msg: 'Session invalidated', key: 'sessionInvalidated' },
  { msg: 'User not found', key: 'userNotFound' },
  { msg: 'You must accept the Terms of Service and the Privacy Policy to continue', key: 'consentRequired' },
  { msg: 'You must accept the Terms of Service', key: 'mustAcceptTerms' },
  { msg: 'You must accept the Privacy Policy', key: 'mustAcceptPrivacy' },
  { msg: 'You must accept the Terms of Service and the Privacy Policy', key: 'mustAcceptTermsAndPrivacy' },
  { msg: 'Password is incorrect', key: 'passwordIncorrect' },
  { msg: 'Two-factor authentication code is required', key: 'twoFactorCodeRequired' },
  { msg: 'Invalid two-factor authentication code', key: 'invalidTwoFactorCode' },
  { msg: 'Email already verified', key: 'emailAlreadyVerified' },
  { msg: 'Too many verification emails requested — try again tomorrow', key: 'tooManyVerificationEmails' },
  { msg: 'Too many registrations from this email domain today — try again later', key: 'tooManyDomainRegistrations' },
  { msg: 'Registration challenge is invalid or expired — refresh and try again', key: 'registrationChallengeInvalid' },
  { msg: 'Registration challenge expired before it was solved', key: 'powExpired' },
  { msg: 'WebCrypto unavailable — cannot solve registration challenge', key: 'powUnavailable' },
  { msg: 'Proof-of-work worker failed', key: 'powWorkerFailed' },
  { msg: `Username must be at least ${LIMITS.USERNAME_MIN} characters`, key: 'usernameTooShort', vars: { min: LIMITS.USERNAME_MIN }, src: 'Username must be at least ${LIMITS.USERNAME_MIN} characters' },
  { msg: `Username must be at most ${LIMITS.USERNAME_MAX} characters`, key: 'usernameTooLong', vars: { max: LIMITS.USERNAME_MAX }, src: 'Username must be at most ${LIMITS.USERNAME_MAX} characters' },
  { msg: 'Username can only contain letters, numbers, underscores, dots, and hyphens', key: 'usernameInvalidChars' },
  { msg: 'Invalid email address', key: 'invalidEmail' },
  { msg: `Password must be at least ${LIMITS.PASSWORD_MIN} characters`, key: 'passwordTooShort', vars: { min: LIMITS.PASSWORD_MIN }, src: 'Password must be at least ${LIMITS.PASSWORD_MIN} characters' },
  { msg: `Password must be at most ${LIMITS.PASSWORD_MAX} bytes (special characters and emoji count as multiple bytes)`, key: 'passwordTooLong', vars: { max: LIMITS.PASSWORD_MAX }, src: 'Password must be at most ${LIMITS.PASSWORD_MAX} bytes (special characters and emoji count as multiple bytes)' },
  { msg: 'Display name cannot be empty', key: 'displayNameEmpty' },
  { msg: `Display name must be at most ${LIMITS.DISPLAY_NAME_MAX} characters`, key: 'displayNameTooLong', vars: { max: LIMITS.DISPLAY_NAME_MAX }, src: 'Display name must be at most ${LIMITS.DISPLAY_NAME_MAX} characters' },
  { msg: `Bio must be at most ${LIMITS.BIO_MAX} characters`, key: 'bioTooLong', vars: { max: LIMITS.BIO_MAX }, src: 'Bio must be at most ${LIMITS.BIO_MAX} characters' },

  // ─── Servers & membership ───
  { msg: `Server name must be at least ${LIMITS.SERVER_NAME_MIN} characters`, key: 'serverNameTooShort', vars: { min: LIMITS.SERVER_NAME_MIN }, src: 'Server name must be at least ${LIMITS.SERVER_NAME_MIN} characters' },
  { msg: `Server name must be at most ${LIMITS.SERVER_NAME_MAX} characters`, key: 'serverNameTooLong', vars: { max: LIMITS.SERVER_NAME_MAX }, src: 'Server name must be at most ${LIMITS.SERVER_NAME_MAX} characters' },
  { msg: 'You do not have permission to manage server settings', key: 'noPermissionManageServer' },
  { msg: 'You do not have permission to view server settings', key: 'noPermissionViewServerSettings' },
  { msg: 'Only the server owner can delete it', key: 'onlyOwnerCanDelete' },
  { msg: 'Only the server owner can transfer ownership', key: 'onlyOwnerCanTransfer' },
  { msg: 'Only the server owner can change roles', key: 'onlyOwnerCanChangeRoles' },
  { msg: 'Server owner cannot leave. Transfer ownership first.', key: 'ownerCannotLeave' },
  { msg: 'Cannot kick yourself', key: 'cannotKickSelf' },
  { msg: 'Cannot transfer ownership to yourself', key: 'cannotTransferToSelf' },
  { msg: 'Cannot change your own role', key: 'cannotChangeOwnRole' },
  { msg: "Cannot change the owner's role", key: 'cannotChangeOwnerRole' },
  { msg: 'You do not have permission to change your nickname', key: 'noPermissionChangeNickname' },
  { msg: 'You do not have permission to manage nicknames', key: 'noPermissionManageNicknames' },
  { msg: 'Cannot manage the nickname of a member with an equal or higher role', key: 'cannotManageHigherNickname' },
  { msg: 'Nickname cannot be empty', key: 'nicknameEmpty' },
  { msg: `Nickname must be at most ${LIMITS.NICKNAME_MAX} characters`, key: 'nicknameTooLong', vars: { max: LIMITS.NICKNAME_MAX }, src: 'Nickname must be at most ${LIMITS.NICKNAME_MAX} characters' },
  { msg: 'Search text is too long', key: 'searchTextTooLong' },
  { msg: 'Server membership not found', key: 'membershipNotFound', src: "NotFoundError('Server membership')" },
  { msg: 'Member not found', key: 'memberNotFound', src: "NotFoundError('Member')" },
  { msg: 'Target member not found', key: 'memberNotFound', src: "NotFoundError('Target member')" },
  { msg: 'User is not a member of this server', key: 'userNotServerMember' },
  { msg: 'Not a member', key: 'notAMember' },
  { msg: 'Not a participant', key: 'notAParticipant' },
  { msg: 'Not authorized', key: 'notAuthorized' },
  { msg: 'Invite not found', key: 'inviteNotFound', src: "NotFoundError('Invite')" },

  // ─── Channels & categories ───
  { msg: 'You do not have permission to create channels', key: 'noPermissionCreateChannels' },
  { msg: 'You do not have permission to delete channels', key: 'noPermissionDeleteChannels' },
  { msg: 'You do not have permission to update channels', key: 'noPermissionUpdateChannels' },
  { msg: `Channel name must be at least ${LIMITS.CHANNEL_NAME_MIN} character`, key: 'channelNameTooShort', vars: { min: LIMITS.CHANNEL_NAME_MIN }, src: 'Channel name must be at least ${LIMITS.CHANNEL_NAME_MIN} character' },
  { msg: `Channel name must be at most ${LIMITS.CHANNEL_NAME_MAX} characters`, key: 'channelNameTooLong', vars: { max: LIMITS.CHANNEL_NAME_MAX }, src: 'Channel name must be at most ${LIMITS.CHANNEL_NAME_MAX} characters' },
  { msg: 'Channel name contains invalid characters', key: 'channelNameInvalid' },
  { msg: 'Category not found', key: 'categoryNotFound', src: "NotFoundError('Category')" },
  { msg: 'Category not found in this server', key: 'categoryNotFound' },
  { msg: `Category name must be at least ${LIMITS.CATEGORY_NAME_MIN} character`, key: 'categoryNameTooShort', vars: { min: LIMITS.CATEGORY_NAME_MIN }, src: 'Category name must be at least ${LIMITS.CATEGORY_NAME_MIN} character' },
  { msg: `Category name must be at most ${LIMITS.CATEGORY_NAME_MAX} characters`, key: 'categoryNameTooLong', vars: { max: LIMITS.CATEGORY_NAME_MAX }, src: 'Category name must be at most ${LIMITS.CATEGORY_NAME_MAX} characters' },
  { msg: 'One or more channel IDs do not belong to this server', key: 'reorderStale' },
  { msg: 'One or more category IDs do not belong to this server', key: 'reorderStale' },
  // the secure-channel route's type refusal now answers with the quoted form too
  { msg: 'Channel type must be "text" or "voice"', key: 'invalidChannelType' },

  // ─── Roles & permissions ───
  { msg: 'Cannot use reserved role name "everyone"', key: 'roleNameReserved' },
  { msg: 'Cannot explicitly assign the @everyone role', key: 'cannotAssignEveryone' },
  { msg: 'Cannot rename the @everyone role', key: 'cannotRenameEveryone' },
  { msg: 'The @everyone role must stay at position 0', key: 'everyoneMustStayLast' },
  { msg: 'Cannot assign roles at or above your own position', key: 'cannotAssignHigherRole' },
  { msg: "Cannot modify the server owner's roles", key: 'cannotModifyOwnerRoles' },
  { msg: 'Cannot modify roles of a member with an equal or higher role', key: 'cannotModifyHigherMember' },
  { msg: 'Cannot reorder roles at or above your own position', key: 'cannotReorderHigherRoles' },
  { msg: 'Cannot set a role position at or above your own', key: 'cannotSetHigherPosition' },
  { msg: 'Cannot modify overrides for roles at or above your own position', key: 'cannotModifyHigherOverrides' },
  { msg: 'Cannot set overrides for roles at or above your own position', key: 'cannotSetHigherOverrides' },
  { msg: 'Cannot set overrides for permissions you do not have', key: 'cannotOverrideUnheldPermissions' },
  { msg: 'You do not have permission to manage permissions', key: 'noPermissionManagePermissions' },
  { msg: 'Role not found', key: 'roleNotFound', src: "NotFoundError('Role')" },
  { msg: 'One or more role IDs do not belong to this server', key: 'reorderStale' },
  { msg: 'One or more role IDs are invalid', key: 'reorderStale' },
  { msg: 'Role positions must be unique', key: 'reorderStale' },
  { msg: `Role name must be at least ${LIMITS.ROLE_NAME_MIN} character`, key: 'roleNameTooShort', vars: { min: LIMITS.ROLE_NAME_MIN }, src: 'Role name must be at least ${LIMITS.ROLE_NAME_MIN} character' },
  { msg: `Role name must be at most ${LIMITS.ROLE_NAME_MAX} characters`, key: 'roleNameTooLong', vars: { max: LIMITS.ROLE_NAME_MAX }, src: 'Role name must be at most ${LIMITS.ROLE_NAME_MAX} characters' },
  { msg: 'Color must be a valid hex color (e.g., #FF5733)', key: 'invalidRoleColor' },

  // ─── Messages, DMs, reactions, uploads, reports ───
  { msg: 'You can only delete your own messages', key: 'canOnlyDeleteOwnMessages' },
  { msg: 'System messages cannot be edited', key: 'systemMessageNoEdit' },
  { msg: 'Message cannot be empty', key: 'messageEmpty' },
  { msg: `Message must be at most ${LIMITS.MESSAGE_MAX} characters`, key: 'messageTooLong', vars: { max: LIMITS.MESSAGE_MAX }, src: 'Message must be at most ${LIMITS.MESSAGE_MAX} characters' },
  { msg: 'Message not found', key: 'messageNotFound', src: "NotFoundError('Message')" },
  { msg: 'Conversation not found', key: 'conversationNotFound', src: "NotFoundError('Conversation')" },
  { msg: 'Invalid replyToId', key: 'replyTargetUnavailable' },
  { msg: `Max ${LIMITS.MAX_ATTACHMENTS_PER_MESSAGE} attachments`, key: 'maxAttachments', vars: { max: LIMITS.MAX_ATTACHMENTS_PER_MESSAGE }, src: 'Max ${LIMITS.MAX_ATTACHMENTS_PER_MESSAGE} attachments' },
  { msg: `Maximum of ${LIMITS.MAX_REACTIONS_PER_MESSAGE} different reactions per message`, key: 'maxReactions', vars: { max: LIMITS.MAX_REACTIONS_PER_MESSAGE }, src: 'Maximum of ${LIMITS.MAX_REACTIONS_PER_MESSAGE} different reactions per message' },
  { msg: 'Invalid emoji', key: 'invalidEmoji' },
  { msg: 'Emoji cannot be empty', key: 'invalidEmoji' },
  { msg: 'Emoji is too long', key: 'invalidEmoji' },
  { msg: 'Invalid file type', key: 'fileTypeNotAllowed' },
  { msg: 'This conversation is end-to-end encrypted; update your client to send messages', key: 'e2eUpdateToSendDm' },
  { msg: 'This channel is end-to-end encrypted; update your client to send messages', key: 'e2eUpdateToSendChannel' },
  { msg: 'This message is end-to-end encrypted; update your client to edit it', key: 'e2eUpdateToEdit' },
  { msg: 'This channel is end-to-end encrypted; update your client to upload files', key: 'e2eUpdateToUpload' },
  { msg: 'You do not have access to this message', key: 'noAccessToMessage' },
  { msg: `Reason must be at least ${LIMITS.REPORT_REASON_MIN} characters`, key: 'reportReasonTooShort', vars: { min: LIMITS.REPORT_REASON_MIN }, src: 'Reason must be at least ${LIMITS.REPORT_REASON_MIN} characters' },
  { msg: `Reason must be at most ${LIMITS.REPORT_REASON_MAX} characters`, key: 'reportReasonTooLong', vars: { max: LIMITS.REPORT_REASON_MAX }, src: 'Reason must be at most ${LIMITS.REPORT_REASON_MAX} characters' },
  { msg: 'Friendship not found', key: 'friendshipNotFound', src: "NotFoundError('Friendship')" },
  { msg: 'Support ticket not found', key: 'supportTicketNotFound', src: "NotFoundError('Support ticket')" },

  // ─── Secure channels & E2E ───
  { msg: 'All invited users must be members of this server', key: 'secureInviteesMustBeMembers' },
  { msg: 'The creator cannot leave — delete the channel instead', key: 'secureCreatorCannotLeave' },
  { msg: 'User is already a member of this channel', key: 'secureAlreadyMember' },
  { msg: 'User is not a member of this channel', key: 'secureNotMember' },
  { msg: 'Only the channel creator can invite members', key: 'secureOnlyCreatorInvites' },
  { msg: 'Only the channel creator can remove members', key: 'secureOnlyCreatorRemoves' },
  { msg: 'Only the channel creator can rename this channel', key: 'secureOnlyCreatorRenames' },
  { msg: 'You do not have permission to create secure channels', key: 'noPermissionCreateSecure' },
  { msg: 'Not a member of this channel', key: 'notChannelMember' },
  { msg: 'Key backup is full', key: 'keyBackupFull' },
  { msg: 'Too many undelivered key shares — retry once recipients come online', key: 'tooManyPendingKeyShares' },

  // ─── Themes ───
  { msg: 'Name is required', key: 'nameRequired' },
  { msg: `Theme name must be at least ${LIMITS.THEME_NAME_MIN} characters`, key: 'themeNameTooShort', vars: { min: LIMITS.THEME_NAME_MIN }, src: 'Theme name must be at least ${LIMITS.THEME_NAME_MIN} characters' },
  { msg: `Theme name must be at most ${LIMITS.THEME_NAME_MAX} characters`, key: 'themeNameTooLong', vars: { max: LIMITS.THEME_NAME_MAX }, src: 'Theme name must be at most ${LIMITS.THEME_NAME_MAX} characters' },
  { msg: `Description must be at most ${LIMITS.THEME_DESCRIPTION_MAX} characters`, key: 'themeDescriptionTooLong', vars: { max: LIMITS.THEME_DESCRIPTION_MAX }, src: 'Description must be at most ${LIMITS.THEME_DESCRIPTION_MAX} characters' },
  { msg: 'Tag cannot be empty', key: 'tagEmpty' },
  { msg: `Tag must be at most ${LIMITS.THEME_TAG_MAX_LENGTH} characters`, key: 'tagTooLong', vars: { max: LIMITS.THEME_TAG_MAX_LENGTH }, src: 'Tag must be at most ${LIMITS.THEME_TAG_MAX_LENGTH} characters' },
  { msg: 'Tag can only contain letters, numbers, spaces, underscores, and hyphens', key: 'tagInvalidChars' },
  { msg: `Maximum ${LIMITS.THEME_MAX_TAGS} tags allowed`, key: 'themeTooManyTags', vars: { max: LIMITS.THEME_MAX_TAGS }, src: 'Maximum ${LIMITS.THEME_MAX_TAGS} tags allowed' },
  { msg: `You can create a maximum of ${LIMITS.THEME_MAX_PER_USER} themes`, key: 'themeCap', vars: { max: LIMITS.THEME_MAX_PER_USER }, src: 'You can create a maximum of ${LIMITS.THEME_MAX_PER_USER} themes' },
  { msg: `SVG data must be at most ${LIMITS.THEME_SVG_MAX_SIZE} characters`, key: 'svgTooLong', vars: { max: LIMITS.THEME_SVG_MAX_SIZE }, src: 'SVG data must be at most ${LIMITS.THEME_SVG_MAX_SIZE} characters' },
  { msg: 'Invalid or unsafe SVG markup', key: 'svgUnsafe' },
  { msg: 'You already have a theme with that name', key: 'themeNameTaken' },
  { msg: 'Theme is already published', key: 'themeAlreadyPublished' },
  { msg: 'Theme is not published', key: 'themeNotPublished' },
  { msg: 'This theme has been removed by an admin', key: 'themeRemovedByAdmin' },
  { msg: 'You can only edit your own themes', key: 'themeNotOwned' },
  { msg: 'You can only delete your own themes', key: 'themeNotOwned' },
  { msg: 'You can only publish your own themes', key: 'themeNotOwned' },
  { msg: 'You can only unpublish your own themes', key: 'themeNotOwned' },
  { msg: 'Theme not found', key: 'themeNotFound', src: "NotFoundError('Theme')" },

  // ─── Voice: voice:error notices and acks ───
  { msg: 'This voice channel no longer exists.', key: 'voiceChannelGone' },
  { msg: 'Voice server restarted — please rejoin the voice channel.', key: 'voiceServerRestarted' },
  { msg: 'You have been disconnected from this voice channel.', key: 'voiceDisconnected' },
  { msg: 'This voice channel requires end-to-end encryption support.', key: 'voiceRequiresE2E' },
  { msg: 'Screen sharing is not available in secure voice channels', key: 'screenShareNotInSecure' },
  { msg: 'Someone else is already sharing in this channel', key: 'screenShareTaken' },
  { msg: 'You do not have permission to speak in this channel', key: 'noPermissionSpeak' },

  // ─── Older rows whose text carries a limit (tested in serverErrors.test.ts too) ───
  { msg: `Description must be at most ${LIMITS.SERVER_DESCRIPTION_MAX} characters`, key: 'descriptionTooLong', vars: { max: LIMITS.SERVER_DESCRIPTION_MAX }, src: 'Description must be at most ${LIMITS.SERVER_DESCRIPTION_MAX} characters' },
  { msg: `Reason must be at most ${LIMITS.SERVER_BAN_REASON_MAX} characters`, key: 'reasonTooLong', vars: { max: LIMITS.SERVER_BAN_REASON_MAX }, src: 'Reason must be at most ${LIMITS.SERVER_BAN_REASON_MAX} characters' },
  { msg: `At most ${LIMITS.DISCOVERY_MAX_TAGS} tags are allowed`, key: 'tooManyTags', vars: { max: LIMITS.DISCOVERY_MAX_TAGS }, src: 'At most ${LIMITS.DISCOVERY_MAX_TAGS} tags are allowed' },
  { msg: `Message must be at most ${LIMITS.JOIN_REQUEST_MESSAGE_MAX} characters`, key: 'joinMessageTooLong', vars: { max: LIMITS.JOIN_REQUEST_MESSAGE_MAX }, src: 'Message must be at most ${LIMITS.JOIN_REQUEST_MESSAGE_MAX} characters' },
  { msg: `Webhook name must be at most ${LIMITS.WEBHOOK_NAME_MAX} characters`, key: 'webhookNameTooLong', vars: { max: LIMITS.WEBHOOK_NAME_MAX }, src: 'Webhook name must be at most ${LIMITS.WEBHOOK_NAME_MAX} characters' },
];

/** Sentences carrying a number the server picks: [sample message, key, the variable it lands in, the source template]. */
const PATTERNS: Array<{ msg: string; key: string; vars: Record<string, number>; src: string }> = [
  { msg: 'Server can have at most 20 channels', key: 'channelCap', vars: { max: 20 }, src: 'Server can have at most ${limits.maxChannelsPerServer} channels' },
  { msg: 'Server can have at most 5 secure channels', key: 'secureChannelCap', vars: { max: 5 }, src: 'Server can have at most ${limits.maxSecureChannelsPerServer} secure channels' },
  { msg: 'Server can have at most 7 categories', key: 'categoryCap', vars: { max: 7 }, src: 'Server can have at most ${limits.maxCategoriesPerServer} categories' },
  { msg: 'Server can have at most 25 roles', key: 'roleCap', vars: { max: 25 }, src: 'Server can have at most ${LIMITS.MAX_ROLES_PER_SERVER} roles' },
  { msg: 'Server can have at most 3 webhooks', key: 'webhookCap', vars: { max: 3 }, src: 'Server can have at most ${limits.maxWebhooksPerServer} webhooks' },
  { msg: 'You can only create up to 5 servers', key: 'serverCap', vars: { max: 5 }, src: 'You can only create up to ${LIMITS.MAX_SERVERS_PER_USER} servers' },
  { msg: 'This server has reached its member limit (150)', key: 'memberCap', vars: { max: 150 }, src: 'This server has reached its member limit (${limits.maxMembersPerServer})' },
  { msg: 'A secure channel can have at most 25 members', key: 'secureChannelMemberCap', vars: { max: 25 }, src: 'A secure channel can have at most ${E2E_LIMITS.SECURE_CHANNEL_MEMBER_CAP} members' },
  { msg: 'Device limit reached (5) — revoke a device first', key: 'deviceLimit', vars: { max: 5 }, src: 'Device limit reached (${E2E_LIMITS.MAX_DEVICES}) — revoke a device first' },
  { msg: 'Invalid file size (max 8MB)', key: 'fileTooLarge', vars: { max: 8 }, src: 'Invalid file size (max ${maxSize / 1024 / 1024}MB)' },
  { msg: 'Invalid file size (max 12MB)', key: 'fileTooLarge', vars: { max: 12 }, src: 'Invalid file size (max ${LIMITS.MAX_VIDEO_ATTACHMENT_SIZE / 1024 / 1024}MB)' },
  { msg: 'Invalid file size (max 0.5MB)', key: 'fileTooLarge', vars: { max: 0.5 }, src: 'Invalid file size (max ${maxSize / 1024 / 1024}MB)' },
  { msg: 'Search query must be at least 2 characters', key: 'searchQueryTooShort', vars: { min: 2 }, src: 'Search query must be at least ${LIMITS.SEARCH_QUERY_MIN} characters' },
  { msg: 'Search query must be at least 3 characters', key: 'searchQueryTooShort', vars: { min: 3 }, src: 'Search query must be at least ${DISCOVERY_SEARCH_MIN} characters' },
  { msg: 'Search query must be at most 200 characters', key: 'searchQueryTooLong', vars: { max: 200 }, src: 'Search query must be at most ${LIMITS.SEARCH_QUERY_MAX} characters' },
];

describe('translateServerError — every sentence a member can receive', () => {
  it.each(EXACT)('maps "$msg" → serverErrors.$key', ({ msg, key, vars }) => {
    expect(translateServerError(msg, t)).toBe(`serverErrors.${key}|${JSON.stringify({ defaultValue: msg, ...vars })}`);
  });

  it.each(EXACT)('"$msg" is written verbatim where it is sent from', ({ msg, src }) => {
    expect(written(msg, src), src ?? msg).toBe(true);
  });

  it.each(PATTERNS)('matches "$msg" by pattern and carries the number', ({ msg, key, vars }) => {
    expect(translateServerError(msg, t)).toBe(`serverErrors.${key}|${JSON.stringify({ defaultValue: msg, ...vars })}`);
  });

  it.each(PATTERNS)('the template behind "$msg" is the one the server writes', ({ src }) => {
    expect(SOURCE_TEXT.includes(src), src).toBe(true);
  });

  it('patterns are anchored: a longer or reworded sentence stays raw', () => {
    for (const raw of [
      'Server can have at most 20 channels!',
      'The server can have at most 20 channels',
      'Server can have at most many roles',
      'Invalid file size (max 8 MB)',
      'Device limit reached (5)',
      'This server has reached its member limit',
    ]) {
      expect(translateServerError(raw, t)).toBe(raw);
    }
  });

  it('getTranslatedError reaches the new rows from an axios answer and from a thrown Error', async () => {
    const { getTranslatedError } = await import('../../utils/serverErrors');
    const axiosErr = Object.assign(new Error('Request failed with status code 400'), {
      isAxiosError: true,
      response: { status: 400, data: { success: false, error: 'Cannot kick yourself' } },
    });
    expect(getTranslatedError(axiosErr, t)).toMatch(/^serverErrors\.cannotKickSelf\|/);
    // the client-side proof of work reaches the registration form the same way
    expect(getTranslatedError(new Error('Proof-of-work worker failed'), t)).toMatch(/^serverErrors\.powWorkerFailed\|/);
  });
});

describe('the serverErrors.* keys exist in all 11 locales', () => {
  const files = readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.json'));
  const bundles = files.map((f) => ({
    name: f.replace(/\.json$/, ''),
    errors: (JSON.parse(readFileSync(join(LOCALE_DIR, f), 'utf8')) as { serverErrors: Record<string, string> }).serverErrors,
  }));
  const en = bundles.find((b) => b.name === 'en')!.errors;
  const placeholders = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

  it('covers 11 locales and every key the module can produce', () => {
    expect(bundles).toHaveLength(11);
    expect(ALL_ERROR_KEYS.length).toBeGreaterThan(250);
    const missing = bundles.flatMap((b) => ALL_ERROR_KEYS.filter((k) => !(typeof b.errors[k] === 'string' && b.errors[k].length > 0)).map((k) => `${b.name}: ${k}`));
    expect(missing).toEqual([]);
  });

  it('every translation names the same {{placeholders}} as English', () => {
    const drift = bundles.flatMap((b) => ALL_ERROR_KEYS
      .filter((k) => placeholders(b.errors[k] ?? '').join() !== placeholders(en[k]).join())
      .map((k) => `${b.name}: ${k}`));
    expect(drift).toEqual([]);
  });

  it('every key whose English text needs a number is given one by its mapping', () => {
    const withVars = new Set([...EXACT, ...PATTERNS].filter((r) => r.vars).map((r) => r.key));
    const needy = ALL_ERROR_KEYS.filter((k) => placeholders(en[k]).length > 0);
    expect(needy.filter((k) => !withVars.has(k))).toEqual([]);
    // and only {{max}} / {{min}} ever travel
    expect([...new Set(needy.flatMap((k) => placeholders(en[k])))].sort()).toEqual(['max', 'min']);
  });
});
