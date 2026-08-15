import { useTranslation } from 'react-i18next';
import { useVoiceStore } from '../../stores/voiceStore';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';
import { ConnectionQuality } from './ConnectionQuality';
import { Mic, MicOff, Headphones, HeadphoneOff, PhoneOff, Monitor, MonitorOff, Lock, ShieldAlert } from 'lucide-react';
import { clsx } from 'clsx';

export function VoicePanel() {
  const { t } = useTranslation();
  const {
    activeChannelId, channelUsers, selfMute, selfDeaf,
    toggleMute, toggleDeaf, leaveChannel, latency,
    isScreenSharing, screenSharingUserId, startScreenShare, stopScreenShare,
  } = useVoiceStore();
  const secureVoicePeerIssues = useVoiceStore((s) => s.secureVoicePeerIssues);
  const secureVoiceActive = useVoiceStore((s) => s.secureVoiceActive);
  const { channels } = useServerStore();
  const { user } = useAuthStore();
  const servers = useServerStore((s) => s.servers);
  const activeVoiceServerId = useVoiceStore((s) => s.activeVoiceServerId);

  if (!activeChannelId) return null;

  const channel = channels.find((c) => c.id === activeChannelId);
  const voiceServer = activeVoiceServerId ? servers.find((s) => s.id === activeVoiceServerId) : null;
  const users = channelUsers.get(activeChannelId) || [];

  const latencyColor = latency === null ? 'text-vox-text-muted' :
    latency < 100 ? 'text-vox-voice-connected' :
    latency < 200 ? 'text-vox-accent-warning' :
    'text-vox-accent-danger';

  // Check if local user is server-muted/deafened
  const localVoiceUser = users.find((u) => u.id === user?.id);
  const isServerMuted = localVoiceUser?.serverMuted ?? false;
  const isServerDeafened = localVoiceUser?.serverDeafened ?? false;

  const otherSharing = screenSharingUserId && screenSharingUserId !== user?.id;
  // From the live voice session, NOT the viewed server's channel list: a user
  // browsing another server still has `channels` swapped out from under them,
  // which would drop the E2E lock and the un-keyed-member warning mid-call and
  // put the screen-share button back in an audio-only encrypted channel.
  const isSecureVoice = secureVoiceActive || channel?.secure === true;

  return (
    <div data-testid="voice-panel" className="mx-1 mb-1 rounded-xl border border-vox-border bg-vox-bg-tertiary">
      {/* Connection info row */}
      <div className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          <ConnectionQuality latency={latency} />
          <p className="text-xs font-semibold text-vox-voice-connected">
            {t('voice.connected')}
          </p>
          {isSecureVoice && (
            <span
              className="shrink-0"
              data-testid="secure-voice-e2e-lock"
              title={t('secureVoice.locked')}
              aria-label={t('secureVoice.locked')}
            >
              <Lock size={10} className="text-vox-voice-connected" />
            </span>
          )}
          {latency !== null && (
            <span className={clsx('text-[10px] font-medium', latencyColor)}>
              {latency}ms
            </span>
          )}
        </div>
        <div className="min-w-0">
          <button
            onClick={() => { if (activeVoiceServerId) useServerStore.getState().setActiveServer(activeVoiceServerId).catch((err) => console.warn('[VoicePanel] Failed to navigate to voice server:', err)); }}
            className="truncate text-[10px] text-vox-text-muted hover:text-vox-text-primary transition-colors text-left"
            title={t('voice.goToChannel')}
          >
            {voiceServer?.name ? `${voiceServer.name} / ` : ''}{channel?.name || t('voice.voiceChannel')}
            <span className="ml-1 text-vox-text-muted/60">({users.length})</span>
          </button>
        </div>
      </div>

      {/* Server-muted/deafened warning */}
      {(isServerMuted || isServerDeafened) && (
        <div className="mx-3 mb-2 rounded-md bg-vox-accent-danger/10 border border-vox-accent-danger/20 px-2.5 py-1.5">
          <p className="text-[11px] text-vox-accent-danger font-medium">
            {isServerDeafened ? t('voice.serverDeafenedAndMuted') : t('voice.serverMuted')}
          </p>
          <p className="text-[10px] text-vox-text-muted">{t('voice.moderatorRestricted')}</p>
        </div>
      )}

      {/* Secure voice: members we could not exchange keys with (spec §21) */}
      {isSecureVoice && Object.keys(secureVoicePeerIssues).length > 0 && (
        <div className="mx-3 mb-2 rounded-md bg-vox-accent-warning/10 border border-vox-accent-warning/20 px-2.5 py-1.5" data-testid="secure-voice-issues">
          <p className="flex items-center gap-1 text-[11px] font-medium text-vox-accent-warning">
            <ShieldAlert size={11} className="shrink-0" />
            {t('secureVoice.peerIssues', { count: Object.keys(secureVoicePeerIssues).length })}
          </p>
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center justify-between px-2.5 pb-2.5 pt-0.5">
        <div className="flex items-center gap-1">
          {/* Mute */}
          <button
            onClick={toggleMute}
            disabled={isServerMuted}
            className={clsx(
              'rounded-md p-1.5 transition-colors',
              isServerMuted
                ? 'bg-vox-accent-danger/20 text-vox-accent-danger cursor-not-allowed'
                : selfMute
                  ? 'bg-vox-accent-danger/20 text-vox-accent-danger hover:bg-vox-accent-danger/30'
                  : 'bg-vox-bg-hover text-vox-text-secondary hover:bg-vox-bg-active hover:text-vox-text-primary'
            )}
            title={isServerMuted ? t('voice.mutedByModerator') : selfMute ? t('voice.unmute') : t('voice.mute')}
            aria-label={isServerMuted ? t('voice.mutedByModerator') : selfMute ? t('voice.unmute') : t('voice.mute')}
          >
            {selfMute || isServerMuted ? <MicOff size={16} /> : <Mic size={16} />}
          </button>

          {/* Deafen */}
          <button
            onClick={toggleDeaf}
            disabled={isServerDeafened}
            className={clsx(
              'rounded-md p-1.5 transition-colors',
              isServerDeafened
                ? 'bg-vox-accent-danger/20 text-vox-accent-danger cursor-not-allowed'
                : selfDeaf
                  ? 'bg-vox-accent-danger/20 text-vox-accent-danger hover:bg-vox-accent-danger/30'
                  : 'bg-vox-bg-hover text-vox-text-secondary hover:bg-vox-bg-active hover:text-vox-text-primary'
            )}
            title={isServerDeafened ? t('voice.deafenedByModerator') : selfDeaf ? t('voice.undeafen') : t('voice.deafen')}
            aria-label={isServerDeafened ? t('voice.deafenedByModerator') : selfDeaf ? t('voice.undeafen') : t('voice.deafen')}
          >
            {selfDeaf || isServerDeafened ? <HeadphoneOff size={16} /> : <Headphones size={16} />}
          </button>

          {/* Screen Share — hidden in secure voice channels (audio-only v1,
              spec §21; the server rejects screen producers there anyway) */}
          {!isSecureVoice && (
          <button
            onClick={() => isScreenSharing ? stopScreenShare() : startScreenShare()}
            disabled={!!otherSharing}
            className={clsx(
              'rounded-md p-1.5 transition-colors',
              isScreenSharing
                ? 'bg-vox-voice-connected/20 text-vox-voice-connected hover:bg-vox-accent-danger/20 hover:text-vox-accent-danger'
                : otherSharing
                  ? 'bg-vox-bg-hover text-vox-text-muted cursor-not-allowed opacity-50'
                  : 'bg-vox-bg-hover text-vox-text-secondary hover:bg-vox-bg-active hover:text-vox-text-primary'
            )}
            title={isScreenSharing ? t('voice.stopSharing') : otherSharing ? t('voice.someoneSharing') : t('voice.shareScreen')}
            aria-label={isScreenSharing ? t('voice.stopSharing') : otherSharing ? t('voice.someoneSharing') : t('voice.shareScreen')}
          >
            {isScreenSharing ? <MonitorOff size={16} /> : <Monitor size={16} />}
          </button>
          )}
        </div>

        {/* Disconnect */}
        <button
          onClick={leaveChannel}
          className="rounded-md p-1.5 bg-vox-accent-danger/20 text-vox-accent-danger hover:bg-vox-accent-danger/30 transition-colors"
          title={t('voice.disconnect')}
          aria-label={t('voice.disconnectFromVoice')}
        >
          <PhoneOff size={16} />
        </button>
      </div>
    </div>
  );
}
