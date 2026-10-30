import type { TFunction } from 'i18next';
import axios from 'axios';
import { LIMITS } from '@voxium/shared';

/**
 * Maps known server error strings → i18n keys under "serverErrors.*".
 * The server sends English error messages; this utility translates them
 * to the user's language on the client side.
 *
 * Keys are exact-match strings from the server. Values are i18n key suffixes
 * (looked up as `serverErrors.<value>`).
 */
const ERROR_MAP: Record<string, string> = {
  // ─── Auth ──────────────────────────────────────────────────────────────
  'Invalid credentials': 'invalidCredentials',
  'Username or email already in use': 'usernameOrEmailTaken',
  'Your account has been banned': 'accountBanned',
  'Token has been revoked': 'tokenRevoked',
  'Invalid refresh token': 'invalidRefreshToken',
  'Refresh token is required': 'refreshTokenRequired',
  'Registration is currently disabled': 'registrationDisabled',

  // ─── Validation ────────────────────────────────────────────────────────
  'Username is required': 'usernameRequired',
  'Email is required': 'emailRequired',
  'Password is required': 'passwordRequired',
  'Current password is required': 'currentPasswordRequired',
  'New password is required': 'newPasswordRequired',
  'Current password is incorrect': 'currentPasswordIncorrect',

  // ─── Password Reset ────────────────────────────────────────────────────
  'Reset token is required': 'resetTokenRequired',
  'Invalid or expired reset token': 'invalidResetToken',

  // ─── Email Verification ────────────────────────────────────────────────
  'Verification token is required': 'verificationTokenRequired',
  'Invalid or expired verification link': 'invalidVerificationLink',

  // ─── TOTP (2FA) ────────────────────────────────────────────────────────
  'TOTP token is required': 'totpTokenRequired',
  'Verification code is required': 'verificationCodeRequired',
  'Invalid or expired TOTP token': 'invalidTotpToken',
  'Invalid token purpose': 'invalidTokenPurpose',
  'Invalid verification code': 'invalidVerificationCode',
  'Two-factor authentication is already enabled': 'totpAlreadyEnabled',
  'Please set up two-factor authentication first': 'totpSetupRequired',
  'Two-factor authentication is not enabled': 'totpNotEnabled',
  'TOTP secret not found': 'totpSecretNotFound',

  // ─── Servers ───────────────────────────────────────────────────────────
  'Server creation is currently disabled': 'serverCreationDisabled',
  'Already a member of this server': 'alreadyMember',
  'Not a member of this server': 'notAMember',

  // ─── Channels ──────────────────────────────────────────────────────────
  'You do not have permission to manage channels': 'noPermissionManageChannels',
  'Cannot send messages to a voice channel': 'cannotSendToVoice',
  'Channel type must be "text" or "voice"': 'invalidChannelType',
  // The opacity answer of the webhook routes too: missing, another server's,
  // secure, or a channel the caller cannot view all read the same
  'Channel not found': 'channelNotFound',

  // ─── Categories ────────────────────────────────────────────────────────
  'You do not have permission to manage categories': 'noPermissionManageCategories',

  // ─── Roles ─────────────────────────────────────────────────────────────
  'You do not have permission to manage roles': 'noPermissionManageRoles',
  'Cannot grant permissions you do not have': 'cannotGrantPermissions',
  'Cannot edit a role at or above your own position': 'cannotEditHigherRole',
  'Cannot delete the @everyone role': 'cannotDeleteEveryone',
  'Cannot delete a role at or above your own position': 'cannotDeleteHigherRole',
  'A role with this name already exists': 'roleNameExists',

  // ─── Messages ──────────────────────────────────────────────────────────
  'You can only edit your own messages': 'canOnlyEditOwnMessages',
  'You do not have permission to send messages in this channel': 'noPermissionSendMessages',
  'You do not have permission to attach files in this channel': 'noPermissionAttachFiles',
  'You do not have permission to add reactions in this channel': 'noPermissionAddReactions',
  'You do not have permission to view this channel': 'noPermissionViewChannel',

  // ─── DM ────────────────────────────────────────────────────────────────
  'Cannot create conversation with yourself': 'cannotDmSelf',
  'Not a participant of this conversation': 'notAParticipant',

  // ─── Voice ─────────────────────────────────────────────────────────────
  'Voice channels are currently disabled': 'voiceDisabled',
  'Voice calls are currently disabled': 'voiceCallsDisabled',
  'Voice channel is full': 'voiceChannelFull',
  'Voice channel not found.': 'voiceChannelNotFound',
  'You are not a member of this server.': 'notServerMember',
  'You do not have permission to join this voice channel.': 'noPermissionJoinVoice',
  'Voice server unavailable. Please try again later.': 'voiceServerUnavailable',
  'Failed to create voice connection.': 'voiceConnectionFailed',
  'This call is already full.': 'callAlreadyFull',
  'Voice service temporarily unavailable.': 'voiceServiceUnavailable',
  'You do not have permission to mute members.': 'noPermissionMuteMembers',
  'Cannot mute a member with an equal or higher role.': 'cannotMuteHigherRole',
  'You do not have permission to deafen members.': 'noPermissionDeafenMembers',
  'Cannot deafen a member with an equal or higher role.': 'cannotDeafenHigherRole',
  'You do not have permission to move members.': 'noPermissionMoveMembers',
  'Cannot move a member with an equal or higher role.': 'cannotMoveHigherRole',
  'User is not in a voice channel.': 'userNotInVoice',
  'Invalid target voice channel.': 'invalidTargetVoiceChannel',
  'Target user does not have permission to join that channel.': 'targetNoPermissionJoinVoice',
  'Target voice channel is full.': 'targetVoiceChannelFull',
  // A newer connection of the SAME account took over the voice session (a
  // second device joined voice or a DM call): this device leaves on it
  'Your voice session moved to another device.': 'voiceSessionTakenOver',

  // ─── Friends ───────────────────────────────────────────────────────────
  'Cannot send friend request to yourself': 'cannotFriendSelf',
  'Already friends': 'alreadyFriends',
  'Friend request already sent': 'friendRequestAlreadySent',
  'Only the addressee can accept a friend request': 'onlyAddresseeCanAccept',
  'This request is not pending': 'requestNotPending',

  // ─── Invites ───────────────────────────────────────────────────────────
  'Server invites are currently disabled': 'invitesDisabled',
  'Invites are locked for this server': 'invitesLocked',
  'You do not have permission to create invites': 'noPermissionCreateInvites',
  'This invite has expired': 'inviteExpired',
  'You are already a member of this server': 'alreadyMemberInvite',

  // ─── Uploads ───────────────────────────────────────────────────────────
  'File type not allowed': 'fileTypeNotAllowed',
  'You do not have permission to change the server icon': 'noPermissionChangeIcon',

  // ─── Reports ───────────────────────────────────────────────────────────
  'You cannot report yourself': 'cannotReportSelf',
  'You already have a pending report against this target': 'reportAlreadyPending',

  // ─── Support ───────────────────────────────────────────────────────────
  'Support tickets are currently disabled': 'supportDisabled',
  'Ticket is closed. Reopen it to send messages.': 'ticketClosed',

  // ─── Server discovery / membership moderation ──────────────────────────
  'Server discovery is currently disabled': 'discoveryDisabled',
  'Listing is disabled by an administrator': 'listingDisabledByAdmin',
  'You are banned from this server': 'bannedFromServer',
  'Your request was declined recently. Please try again later.': 'requestDeclinedRecently',
  'Join request not found': 'joinRequestNotFound',
  'Ban not found': 'banNotFound',
  'Cannot transfer ownership to a banned user': 'cannotTransferToBanned',
  'You cannot report your own server': 'cannotReportOwnServer',
  'You do not have permission to manage members': 'noPermissionManageMembers',
  'You do not have permission to kick members': 'noPermissionKickMembers',
  'Cannot kick a member with an equal or higher role': 'cannotKickHigherRole',
  // Shared validators (packages/shared/src/validators.ts) — run client-side
  // before the request AND server-side; the SAME strings reach both paths.
  'Server name contains unsupported characters': 'serverNameUnsupportedChars',
  'Description contains unsupported characters': 'descriptionUnsupportedChars',
  [`Description must be at most ${LIMITS.SERVER_DESCRIPTION_MAX} characters`]: 'descriptionTooLong',
  'Reason contains unsupported characters': 'reasonUnsupportedChars',
  [`Reason must be at most ${LIMITS.SERVER_BAN_REASON_MAX} characters`]: 'reasonTooLong',
  'Tags must be chosen from the supported list': 'tagsNotSupported',
  [`At most ${LIMITS.DISCOVERY_MAX_TAGS} tags are allowed`]: 'tooManyTags',
  'Message contains unsupported characters': 'joinMessageUnsupportedChars',
  [`Message must be at most ${LIMITS.JOIN_REQUEST_MESSAGE_MAX} characters`]: 'joinMessageTooLong',
  // Explore paging past the depth cap (DISCOVERY_MAX_PAGES × page size)
  'Refine your search': 'refineSearch',
  // The opacity answer: a hidden, blocked or deleted server on join / request / report
  'Server not found': 'serverNotFound',

  // ─── Webhooks ──────────────────────────────────────────────────────────
  // The flag-off answer is a STATE in the Integrations tab (services/webhooks.ts
  // isWebhooksOff), mapped here for any other surface that meets it.
  'Webhooks are currently disabled': 'webhooksDisabled',
  'Webhook is disabled': 'webhookDisabled',
  // An administrator's disable is sticky: the owner's enable is refused
  // until an administrator lifts it (the tab never sends it, another client may)
  'This webhook was disabled by an administrator': 'webhookAdminDisabled',
  'Webhook not found': 'webhookNotFound',
  'You do not have permission to manage webhooks': 'webhookNoPermission',
  'Webhooks can only post to text channels': 'webhookTextOnly',
  'Invalid webhook type': 'webhookInvalidType',
  // A GitHub webhook's secret is stored encrypted: no key on the server, no GitHub webhooks
  'GitHub webhooks are not configured on this server': 'webhookGithubNotConfigured',
  'channelId is required': 'webhookChannelRequired',
  'No fields to update': 'webhookNoFields',
  'enabled must be a boolean': 'webhookEnabledBoolean',
  // Shared validator (validateWebhookName) — client-side AND server-side
  'Webhook name cannot be empty': 'webhookNameEmpty',
  [`Webhook name must be at most ${LIMITS.WEBHOOK_NAME_MAX} characters`]: 'webhookNameTooLong',
  'Webhook name contains unsupported characters': 'webhookNameInvalid',

  // ─── Rate limits ───────────────────────────────────────────────────────
  // The one body every limiter answers its 429 with (middleware/rateLimiter.ts),
  // e.g. webhookManage's 30 changes an hour
  'Too many requests. Please try again later.': 'tooManyRequests',

  // ─── Session & account (middleware/auth.ts, services/authService.ts) ───
  'Email not verified': 'emailNotVerified',
  'Invalid or expired token': 'invalidOrExpiredToken',
  'Session invalidated': 'sessionInvalidated',
  'User not found': 'userNotFound',
  // CONSENT_REQUIRED_MESSAGE: an account that predates consent-at-signup
  'You must accept the Terms of Service and the Privacy Policy to continue': 'consentRequired',
  'You must accept the Terms of Service': 'mustAcceptTerms',
  'You must accept the Privacy Policy': 'mustAcceptPrivacy',
  'You must accept the Terms of Service and the Privacy Policy': 'mustAcceptTermsAndPrivacy',
  'Password is incorrect': 'passwordIncorrect',
  'Two-factor authentication code is required': 'twoFactorCodeRequired',
  'Invalid two-factor authentication code': 'invalidTwoFactorCode',
  'Email already verified': 'emailAlreadyVerified',
  'Too many verification emails requested — try again tomorrow': 'tooManyVerificationEmails',
  'Too many registrations from this email domain today — try again later': 'tooManyDomainRegistrations',
  'Registration challenge is invalid or expired — refresh and try again': 'registrationChallengeInvalid',
  // The registration proof of work fails on the CLIENT too (shared/pow.ts,
  // services/powSolver.ts) and reaches the form through the same helper
  'Registration challenge expired before it was solved': 'powExpired',
  'WebCrypto unavailable — cannot solve registration challenge': 'powUnavailable',
  'Proof-of-work worker failed': 'powWorkerFailed',
  // Shared validators (validateUsername / Email / Password / DisplayName / Bio)
  [`Username must be at least ${LIMITS.USERNAME_MIN} characters`]: 'usernameTooShort',
  [`Username must be at most ${LIMITS.USERNAME_MAX} characters`]: 'usernameTooLong',
  'Username can only contain letters, numbers, underscores, dots, and hyphens': 'usernameInvalidChars',
  'Invalid email address': 'invalidEmail',
  [`Password must be at least ${LIMITS.PASSWORD_MIN} characters`]: 'passwordTooShort',
  [`Password must be at most ${LIMITS.PASSWORD_MAX} bytes (special characters and emoji count as multiple bytes)`]: 'passwordTooLong',
  'Display name cannot be empty': 'displayNameEmpty',
  [`Display name must be at most ${LIMITS.DISPLAY_NAME_MAX} characters`]: 'displayNameTooLong',
  [`Bio must be at most ${LIMITS.BIO_MAX} characters`]: 'bioTooLong',

  // ─── Servers & membership (routes/servers.ts, utils/serverJoin.ts) ─────
  [`Server name must be at least ${LIMITS.SERVER_NAME_MIN} characters`]: 'serverNameTooShort',
  [`Server name must be at most ${LIMITS.SERVER_NAME_MAX} characters`]: 'serverNameTooLong',
  'You do not have permission to manage server settings': 'noPermissionManageServer',
  'You do not have permission to view server settings': 'noPermissionViewServerSettings',
  'Only the server owner can delete it': 'onlyOwnerCanDelete',
  'Only the server owner can transfer ownership': 'onlyOwnerCanTransfer',
  'Only the server owner can change roles': 'onlyOwnerCanChangeRoles',
  'Server owner cannot leave. Transfer ownership first.': 'ownerCannotLeave',
  'Cannot kick yourself': 'cannotKickSelf',
  'Cannot transfer ownership to yourself': 'cannotTransferToSelf',
  'Cannot change your own role': 'cannotChangeOwnRole',
  "Cannot change the owner's role": 'cannotChangeOwnerRole',
  'You do not have permission to change your nickname': 'noPermissionChangeNickname',
  'You do not have permission to manage nicknames': 'noPermissionManageNicknames',
  'Cannot manage the nickname of a member with an equal or higher role': 'cannotManageHigherNickname',
  'Nickname cannot be empty': 'nicknameEmpty',
  [`Nickname must be at most ${LIMITS.NICKNAME_MAX} characters`]: 'nicknameTooLong',
  'Search text is too long': 'searchTextTooLong',
  'Server membership not found': 'membershipNotFound',
  'Member not found': 'memberNotFound',
  'Target member not found': 'memberNotFound',
  'User is not a member of this server': 'userNotServerMember',
  'Not a member': 'notAMember',
  'Not a participant': 'notAParticipant',
  'Not authorized': 'notAuthorized',
  'Invite not found': 'inviteNotFound',

  // ─── Channels & categories (routes/channels.ts, routes/categories.ts) ──
  'You do not have permission to create channels': 'noPermissionCreateChannels',
  'You do not have permission to delete channels': 'noPermissionDeleteChannels',
  'You do not have permission to update channels': 'noPermissionUpdateChannels',
  [`Channel name must be at least ${LIMITS.CHANNEL_NAME_MIN} character`]: 'channelNameTooShort',
  [`Channel name must be at most ${LIMITS.CHANNEL_NAME_MAX} characters`]: 'channelNameTooLong',
  'Channel name contains invalid characters': 'channelNameInvalid',
  'Category not found': 'categoryNotFound',
  'Category not found in this server': 'categoryNotFound',
  [`Category name must be at least ${LIMITS.CATEGORY_NAME_MIN} character`]: 'categoryNameTooShort',
  [`Category name must be at most ${LIMITS.CATEGORY_NAME_MAX} characters`]: 'categoryNameTooLong',
  // A reorder that raced a deletion: the list the client sent is stale
  'One or more channel IDs do not belong to this server': 'reorderStale',
  'One or more category IDs do not belong to this server': 'reorderStale',

  // ─── Roles & permissions (routes/roles.ts) ─────────────────────────────
  'Cannot use reserved role name "everyone"': 'roleNameReserved',
  'Cannot explicitly assign the @everyone role': 'cannotAssignEveryone',
  'Cannot rename the @everyone role': 'cannotRenameEveryone',
  'The @everyone role must stay at position 0': 'everyoneMustStayLast',
  'Cannot assign roles at or above your own position': 'cannotAssignHigherRole',
  "Cannot modify the server owner's roles": 'cannotModifyOwnerRoles',
  'Cannot modify roles of a member with an equal or higher role': 'cannotModifyHigherMember',
  'Cannot reorder roles at or above your own position': 'cannotReorderHigherRoles',
  'Cannot set a role position at or above your own': 'cannotSetHigherPosition',
  'Cannot modify overrides for roles at or above your own position': 'cannotModifyHigherOverrides',
  'Cannot set overrides for roles at or above your own position': 'cannotSetHigherOverrides',
  'Cannot set overrides for permissions you do not have': 'cannotOverrideUnheldPermissions',
  'You do not have permission to manage permissions': 'noPermissionManagePermissions',
  'Role not found': 'roleNotFound',
  'One or more role IDs do not belong to this server': 'reorderStale',
  'One or more role IDs are invalid': 'reorderStale',
  'Role positions must be unique': 'reorderStale',
  [`Role name must be at least ${LIMITS.ROLE_NAME_MIN} character`]: 'roleNameTooShort',
  [`Role name must be at most ${LIMITS.ROLE_NAME_MAX} characters`]: 'roleNameTooLong',
  'Color must be a valid hex color (e.g., #FF5733)': 'invalidRoleColor',

  // ─── Messages, DMs, reactions, uploads, reports ─────────────────────────
  'You can only delete your own messages': 'canOnlyDeleteOwnMessages',
  'System messages cannot be edited': 'systemMessageNoEdit',
  'Message cannot be empty': 'messageEmpty',
  [`Message must be at most ${LIMITS.MESSAGE_MAX} characters`]: 'messageTooLong',
  'Message not found': 'messageNotFound',
  'Conversation not found': 'conversationNotFound',
  'Invalid replyToId': 'replyTargetUnavailable',
  [`Max ${LIMITS.MAX_ATTACHMENTS_PER_MESSAGE} attachments`]: 'maxAttachments',
  [`Maximum of ${LIMITS.MAX_REACTIONS_PER_MESSAGE} different reactions per message`]: 'maxReactions',
  'Invalid emoji': 'invalidEmoji',
  'Emoji cannot be empty': 'invalidEmoji',
  'Emoji is too long': 'invalidEmoji',
  'Invalid file type': 'fileTypeNotAllowed',
  // An older client meeting an end-to-end encrypted conversation or channel
  'This conversation is end-to-end encrypted; update your client to send messages': 'e2eUpdateToSendDm',
  'This channel is end-to-end encrypted; update your client to send messages': 'e2eUpdateToSendChannel',
  'This message is end-to-end encrypted; update your client to edit it': 'e2eUpdateToEdit',
  'This channel is end-to-end encrypted; update your client to upload files': 'e2eUpdateToUpload',
  'You do not have access to this message': 'noAccessToMessage',
  [`Reason must be at least ${LIMITS.REPORT_REASON_MIN} characters`]: 'reportReasonTooShort',
  [`Reason must be at most ${LIMITS.REPORT_REASON_MAX} characters`]: 'reportReasonTooLong',
  'Friendship not found': 'friendshipNotFound',
  'Support ticket not found': 'supportTicketNotFound',

  // ─── Secure channels (routes/secureChannels.ts, routes/e2e.ts) ─────────
  'All invited users must be members of this server': 'secureInviteesMustBeMembers',
  'The creator cannot leave — delete the channel instead': 'secureCreatorCannotLeave',
  'User is already a member of this channel': 'secureAlreadyMember',
  'User is not a member of this channel': 'secureNotMember',
  'Only the channel creator can invite members': 'secureOnlyCreatorInvites',
  'Only the channel creator can remove members': 'secureOnlyCreatorRemoves',
  'Only the channel creator can rename this channel': 'secureOnlyCreatorRenames',
  'You do not have permission to create secure channels': 'noPermissionCreateSecure',
  'Not a member of this channel': 'notChannelMember',
  'Key backup is full': 'keyBackupFull',
  'Too many undelivered key shares — retry once recipients come online': 'tooManyPendingKeyShares',

  // ─── Themes (routes/themes.ts + the shared theme validators) ───────────
  'Name is required': 'nameRequired',
  [`Theme name must be at least ${LIMITS.THEME_NAME_MIN} characters`]: 'themeNameTooShort',
  [`Theme name must be at most ${LIMITS.THEME_NAME_MAX} characters`]: 'themeNameTooLong',
  [`Description must be at most ${LIMITS.THEME_DESCRIPTION_MAX} characters`]: 'themeDescriptionTooLong',
  'Tag cannot be empty': 'tagEmpty',
  [`Tag must be at most ${LIMITS.THEME_TAG_MAX_LENGTH} characters`]: 'tagTooLong',
  'Tag can only contain letters, numbers, spaces, underscores, and hyphens': 'tagInvalidChars',
  [`Maximum ${LIMITS.THEME_MAX_TAGS} tags allowed`]: 'themeTooManyTags',
  [`You can create a maximum of ${LIMITS.THEME_MAX_PER_USER} themes`]: 'themeCap',
  [`SVG data must be at most ${LIMITS.THEME_SVG_MAX_SIZE} characters`]: 'svgTooLong',
  'Invalid or unsafe SVG markup': 'svgUnsafe',
  'You already have a theme with that name': 'themeNameTaken',
  'Theme is already published': 'themeAlreadyPublished',
  'Theme is not published': 'themeNotPublished',
  'This theme has been removed by an admin': 'themeRemovedByAdmin',
  'You can only edit your own themes': 'themeNotOwned',
  'You can only delete your own themes': 'themeNotOwned',
  'You can only publish your own themes': 'themeNotOwned',
  'You can only unpublish your own themes': 'themeNotOwned',
  'Theme not found': 'themeNotFound',

  // ─── Voice (voice:error notices and acks, websocket/voiceHandler.ts) ───
  'This voice channel no longer exists.': 'voiceChannelGone',
  'Voice server restarted — please rejoin the voice channel.': 'voiceServerRestarted',
  'You have been disconnected from this voice channel.': 'voiceDisconnected',
  'This voice channel requires end-to-end encryption support.': 'voiceRequiresE2E',
  'Screen sharing is not available in secure voice channels': 'screenShareNotInSecure',
  'Someone else is already sharing in this channel': 'screenShareTaken',
  'You do not have permission to speak in this channel': 'noPermissionSpeak',

  // ─── Admin ─────────────────────────────────────────────────────────────
  'Cannot ban yourself': 'cannotBanSelf',
  'Cannot ban a super admin': 'cannotBanSuperAdmin',
  'Only super admins can ban other admins': 'onlySuperAdminCanBan',
};

/**
 * Interpolation values for the mapped keys whose text carries a limit — the
 * translations say `{{max}}`, never a literal number, so a changed LIMIT
 * changes every language at once.
 */
const ERROR_VARS: Record<string, Record<string, unknown>> = {
  descriptionTooLong: { max: LIMITS.SERVER_DESCRIPTION_MAX },
  reasonTooLong: { max: LIMITS.SERVER_BAN_REASON_MAX },
  tooManyTags: { max: LIMITS.DISCOVERY_MAX_TAGS },
  joinMessageTooLong: { max: LIMITS.JOIN_REQUEST_MESSAGE_MAX },
  webhookNameTooLong: { max: LIMITS.WEBHOOK_NAME_MAX },
  usernameTooShort: { min: LIMITS.USERNAME_MIN },
  usernameTooLong: { max: LIMITS.USERNAME_MAX },
  passwordTooShort: { min: LIMITS.PASSWORD_MIN },
  passwordTooLong: { max: LIMITS.PASSWORD_MAX },
  displayNameTooLong: { max: LIMITS.DISPLAY_NAME_MAX },
  bioTooLong: { max: LIMITS.BIO_MAX },
  serverNameTooShort: { min: LIMITS.SERVER_NAME_MIN },
  serverNameTooLong: { max: LIMITS.SERVER_NAME_MAX },
  nicknameTooLong: { max: LIMITS.NICKNAME_MAX },
  channelNameTooShort: { min: LIMITS.CHANNEL_NAME_MIN },
  channelNameTooLong: { max: LIMITS.CHANNEL_NAME_MAX },
  categoryNameTooShort: { min: LIMITS.CATEGORY_NAME_MIN },
  categoryNameTooLong: { max: LIMITS.CATEGORY_NAME_MAX },
  roleNameTooShort: { min: LIMITS.ROLE_NAME_MIN },
  roleNameTooLong: { max: LIMITS.ROLE_NAME_MAX },
  messageTooLong: { max: LIMITS.MESSAGE_MAX },
  maxAttachments: { max: LIMITS.MAX_ATTACHMENTS_PER_MESSAGE },
  maxReactions: { max: LIMITS.MAX_REACTIONS_PER_MESSAGE },
  reportReasonTooShort: { min: LIMITS.REPORT_REASON_MIN },
  reportReasonTooLong: { max: LIMITS.REPORT_REASON_MAX },
  themeNameTooShort: { min: LIMITS.THEME_NAME_MIN },
  themeNameTooLong: { max: LIMITS.THEME_NAME_MAX },
  themeDescriptionTooLong: { max: LIMITS.THEME_DESCRIPTION_MAX },
  tagTooLong: { max: LIMITS.THEME_TAG_MAX_LENGTH },
  themeTooManyTags: { max: LIMITS.THEME_MAX_TAGS },
  themeCap: { max: LIMITS.THEME_MAX_PER_USER },
  svgTooLong: { max: LIMITS.THEME_SVG_MAX_SIZE },
};

/**
 * Messages that carry a value the SERVER picks at runtime (an admin-tunable
 * cap, a per-kind upload size, another package's constant), so no exact string
 * can be mapped: matched by pattern, anchored at both ends, and the captured
 * number travels as `{{max}}` (or `{{min}}` where the entry says so).
 */
const ERROR_PATTERNS: ReadonlyArray<{ re: RegExp; key: string; param?: 'max' | 'min' }> = [
  { re: /^Server can have at most (\d+) webhooks$/, key: 'webhookCap' },
  { re: /^Server can have at most (\d+) channels$/, key: 'channelCap' },
  { re: /^Server can have at most (\d+) secure channels$/, key: 'secureChannelCap' },
  { re: /^Server can have at most (\d+) categories$/, key: 'categoryCap' },
  { re: /^Server can have at most (\d+) roles$/, key: 'roleCap' },
  { re: /^You can only create up to (\d+) servers$/, key: 'serverCap' },
  { re: /^This server has reached its member limit \((\d+)\)$/, key: 'memberCap' },
  { re: /^A secure channel can have at most (\d+) members$/, key: 'secureChannelMemberCap' },
  { re: /^Device limit reached \((\d+)\) — revoke a device first$/, key: 'deviceLimit' },
  // routes/uploads.ts: the cap depends on the kind of file (video or not, avatar, icon)
  { re: /^Invalid file size \(max (\d+(?:\.\d+)?)MB\)$/, key: 'fileTooLarge' },
  // validateSearchQuery (message search) and the directory search share the sentence, not the numbers
  { re: /^Search query must be at least (\d+) characters$/, key: 'searchQueryTooShort', param: 'min' },
  { re: /^Search query must be at most (\d+) characters$/, key: 'searchQueryTooLong' },
];

/**
 * Every `serverErrors.*` key this module can produce — exact strings AND
 * patterns — for the locale parity test: the keys are reached through a
 * template no static scan sees.
 */
export const ALL_ERROR_KEYS: readonly string[] = [
  ...new Set([...Object.values(ERROR_MAP), ...ERROR_PATTERNS.map((p) => p.key)]),
];

/** The server-discovery subset of the map, for the locale parity test. */
export const DISCOVERY_ERROR_KEYS: readonly string[] = [
  'discoveryDisabled', 'listingDisabledByAdmin', 'bannedFromServer', 'requestDeclinedRecently', 'joinRequestNotFound',
  'banNotFound', 'cannotTransferToBanned', 'cannotReportOwnServer', 'noPermissionManageMembers', 'noPermissionKickMembers',
  'cannotKickHigherRole', 'serverNameUnsupportedChars', 'descriptionUnsupportedChars', 'descriptionTooLong', 'reasonUnsupportedChars', 'reasonTooLong',
  'tagsNotSupported', 'tooManyTags', 'joinMessageUnsupportedChars', 'joinMessageTooLong', 'refineSearch', 'serverNotFound',
];

/** The incoming-webhooks subset (exact strings AND patterns), for the locale parity test. */
export const WEBHOOK_ERROR_KEYS: readonly string[] = [
  'webhooksDisabled', 'webhookDisabled', 'webhookAdminDisabled', 'webhookNotFound', 'webhookNoPermission', 'webhookTextOnly',
  'webhookInvalidType', 'webhookGithubNotConfigured', 'webhookChannelRequired', 'webhookNoFields', 'webhookEnabledBoolean',
  'webhookNameEmpty', 'webhookNameTooLong', 'webhookNameInvalid', 'webhookCap', 'channelNotFound',
  // Shared with the message routes: what create, move, rotate and enable answer
  // for a channel the caller can see but not send in
  'noPermissionSendMessages',
];

/**
 * Translate a server error message to the user's language.
 * Falls back to the raw server message if no mapping exists,
 * or to a generic fallback key if provided.
 */
export function translateServerError(
  serverMessage: string | undefined,
  t: TFunction,
  fallbackKey = 'common.somethingWentWrong',
): string {
  if (!serverMessage) return t(fallbackKey);

  const key = Object.hasOwn(ERROR_MAP, serverMessage) ? ERROR_MAP[serverMessage] : undefined;
  if (key) return t(`serverErrors.${key}`, { defaultValue: serverMessage, ...ERROR_VARS[key] });

  for (const { re, key: patternKey, param = 'max' } of ERROR_PATTERNS) {
    const match = re.exec(serverMessage);
    if (match) return t(`serverErrors.${patternKey}`, { defaultValue: serverMessage, [param]: Number(match[1]) });
  }

  // A message no mapping knows (a newer server's): the raw text is still more
  // useful than a generic failure
  return serverMessage;
}

/**
 * Extract and translate an error from an Axios error or generic Error.
 * Use this as the single entry point for all catch blocks.
 */
export function getTranslatedError(
  err: unknown,
  t: TFunction,
  fallbackKey = 'common.somethingWentWrong',
): string {
  if (axios.isAxiosError(err)) {
    return translateServerError(err.response?.data?.error, t, fallbackKey);
  }
  if (err instanceof Error) {
    return translateServerError(err.message, t, fallbackKey);
  }
  return t(fallbackKey);
}
