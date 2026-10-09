import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { Mic, MicOff, Headphones, HeadphoneOff, Settings, LogOut } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { getConnectionStatus, onConnectionStatusChange } from '../../services/socket';
import { useServerStore } from '../../stores/serverStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { toast } from '../../stores/toastStore';
import { Avatar } from '../common/Avatar';
import { APP_VERSION } from '@voxium/shared';

/**
 * The signed-in user card at the bottom of the unified sidebar (2026 redesign).
 *
 * Extracted from ChannelSidebar's footer so it is visible in BOTH the server
 * view and the DM view — it carries everything the old ChannelSidebar footer
 * and ServerSidebar rail bottom did between them: settings (avatar or gear),
 * per-server nickname editing, mute/deafen, logout, and the app version.
 * MainLayout renders it once per sidebar column; keep it store-driven.
 */
export function UserCard() {
  const { t } = useTranslation();
  const { user, logout } = useAuthStore();
  const activeServerId = useServerStore((s) => s.activeServerId);
  const currentMember = useServerStore((s) =>
    s.activeServerId ? s.members.find((m) => m.userId === useAuthStore.getState().user?.id) : undefined,
  );
  const selfMute = useVoiceStore((s) => s.selfMute);
  const selfDeaf = useVoiceStore((s) => s.selfDeaf);
  const toggleMute = useVoiceStore((s) => s.toggleMute);
  const toggleDeaf = useVoiceStore((s) => s.toggleDeaf);
  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameInput, setNicknameInput] = useState('');

  // Your OWN presence is connection-driven: the server marks you online when
  // this socket connects. authStore's user.status is the DB snapshot from the
  // login fetch — taken BEFORE the socket connected and never updated since —
  // so rendering it pins the dot to "offline" forever.
  const [connection, setConnection] = useState(getConnectionStatus);
  useEffect(() => onConnectionStatusChange(setConnection), []);
  const ownStatus = connection === 'connected' ? 'online' : 'offline';

  const iconBtn = (active: boolean) =>
    clsx(
      'flex h-[26px] w-[26px] items-center justify-center rounded-md transition-colors',
      active
        ? 'text-vox-accent-danger bg-vox-accent-danger/15 hover:bg-vox-accent-danger/25'
        : 'text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary',
    );

  return (
    <div className="flex-none px-1 pt-1.5">
      <div className="flex items-center gap-2.5 rounded-xl border border-vox-border bg-vox-bg-secondary px-2.5 py-2">
        <button
          onClick={() => useSettingsStore.getState().openSettings()}
          title={t('common.settings')}
          aria-label={t('common.settings')}
          className="shrink-0 hover:opacity-80 transition-opacity"
        >
          <Avatar avatarUrl={user?.avatarUrl} displayName={user?.displayName} size="sm" status={ownStatus} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold leading-tight text-vox-text-primary">
            {user?.displayName || t('channel.user')}
          </p>
          {activeServerId && !editingNickname && (
            <button
              onClick={() => { setEditingNickname(true); setNicknameInput(currentMember?.nickname || ''); }}
              className="block max-w-full truncate text-[11px] leading-tight text-vox-text-muted hover:text-vox-text-secondary transition-colors"
            >
              {currentMember?.nickname ? currentMember.nickname : t('channel.setNickname')}
            </button>
          )}
          {activeServerId && editingNickname && (
            <input
              type="text"
              value={nicknameInput}
              onChange={(e) => setNicknameInput(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  try {
                    await useServerStore.getState().setNickname(activeServerId, nicknameInput.trim() || null);
                    toast.success(nicknameInput.trim() ? t('channel.nicknameSet') : t('channel.nicknameCleared'));
                  } catch { toast.error(t('channel.failedToSetNickname')); }
                  setEditingNickname(false);
                } else if (e.key === 'Escape') {
                  setEditingNickname(false);
                }
              }}
              onBlur={async () => {
                try {
                  await useServerStore.getState().setNickname(activeServerId, nicknameInput.trim() || null);
                } catch { /* ignore on blur */ }
                setEditingNickname(false);
              }}
              placeholder={t('channel.nickname')}
              className="w-full rounded-sm border border-vox-border bg-vox-bg-tertiary px-1 py-0.5 text-[11px] text-vox-text-primary focus:outline-none focus:border-vox-border-strong"
              autoFocus
            />
          )}
          {!activeServerId && (
            <p className="truncate text-[11px] leading-tight text-vox-text-muted">
              {ownStatus === 'online' ? t('channel.online') : t('userProfile.status.offline')}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            onClick={toggleMute}
            className={iconBtn(selfMute)}
            title={selfMute ? t('voice.unmute') : t('voice.mute')}
            aria-label={selfMute ? t('voice.unmute') : t('voice.mute')}
          >
            {selfMute ? <MicOff size={14} /> : <Mic size={14} />}
          </button>
          <button
            onClick={toggleDeaf}
            className={iconBtn(selfDeaf)}
            title={selfDeaf ? t('voice.undeafen') : t('voice.deafen')}
            aria-label={selfDeaf ? t('voice.undeafen') : t('voice.deafen')}
          >
            {selfDeaf ? <HeadphoneOff size={14} /> : <Headphones size={14} />}
          </button>
          <button
            onClick={() => useSettingsStore.getState().openSettings()}
            className={iconBtn(false)}
            title={t('common.settings')}
            aria-label={t('common.settings')}
          >
            <Settings size={14} />
          </button>
          <button
            onClick={logout}
            className="flex h-[26px] w-[26px] items-center justify-center rounded-md text-vox-text-muted hover:bg-vox-accent-danger/15 hover:text-vox-accent-danger transition-colors"
            title="Logout"
            aria-label="Logout"
          >
            <LogOut size={14} />
          </button>
        </div>
      </div>
      <p className="select-none pb-0.5 pt-1 text-center text-[9px] text-vox-text-muted/70">v{APP_VERSION}</p>
    </div>
  );
}
