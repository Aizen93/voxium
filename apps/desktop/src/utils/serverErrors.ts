import type { TFunction } from 'i18next';
import axios from 'axios';

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

  // ─── Admin ─────────────────────────────────────────────────────────────
  'Cannot ban yourself': 'cannotBanSelf',
  'Cannot ban a super admin': 'cannotBanSuperAdmin',
  'Only super admins can ban other admins': 'onlySuperAdminCanBan',
};

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

  const key = ERROR_MAP[serverMessage];
  if (key) return t(`serverErrors.${key}`, { defaultValue: serverMessage });

  // Handle dynamic messages with variables (e.g., "Server can have at most 20 channels")
  // Return raw message as fallback — at least it's informative
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
