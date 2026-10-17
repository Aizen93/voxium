import type { Channel, Message } from '@voxium/shared';
import { isPinnedSecure } from './securePins';

/**
 * The one answer to "is this channel end-to-end encrypted?" for decisions
 * that must not downgrade: the server's flag on the loaded channel list OR
 * this device's pin (`utils/securePins.ts`). The pin is what stops a server
 * that flips `secure` to false from turning a secure channel into a plaintext
 * one under the user — and it answers for channels whose server is not the
 * one being viewed, where the store holds no record at all.
 */
export function isSecureChannelId(
  channelId: string | null | undefined,
  channels: readonly Pick<Channel, 'id' | 'secure'>[],
): boolean {
  if (typeof channelId !== 'string' || channelId.length === 0) return false;
  if (isPinnedSecure(channelId)) return true;
  return channels.some((c) => c.id === channelId && c.secure === true);
}

/**
 * Whether a channel message must go through the decrypt-or-refuse path. The
 * message's own `encrypted` flag is always a safe reason to decrypt (it can
 * only route the row INTO the crypto, whose refusal rule keeps a plaintext
 * row out of a secure channel); its absence is never a reason to skip it.
 */
export function isSecureChannelMessage(
  message: Pick<Message, 'encrypted' | 'channelId'>,
  channels: readonly Pick<Channel, 'id' | 'secure'>[],
): boolean {
  if (message.encrypted === true) return true;
  return isSecureChannelId(message.channelId, channels);
}
