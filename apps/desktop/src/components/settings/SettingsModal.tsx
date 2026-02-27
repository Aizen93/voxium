import { useState, useEffect, useRef, useCallback } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import { Avatar } from '../common/Avatar';
import { X, Keyboard, Volume2, Bell, User, Headphones, Lock, Eye, EyeOff } from 'lucide-react';
import { LIMITS } from '@voxium/shared';

interface DeviceInfo {
  deviceId: string;
  label: string;
}

type SettingsTab = 'account' | 'audio';

function formatKeyCode(code: string): string {
  const map: Record<string, string> = {
    Backquote: '` (Backtick)',
    Space: 'Space',
    Tab: 'Tab',
    CapsLock: 'Caps Lock',
    ShiftLeft: 'Left Shift',
    ShiftRight: 'Right Shift',
    ControlLeft: 'Left Ctrl',
    ControlRight: 'Right Ctrl',
    AltLeft: 'Left Alt',
    AltRight: 'Right Alt',
    MetaLeft: 'Left Meta',
    MetaRight: 'Right Meta',
    Backslash: '\\',
    BracketLeft: '[',
    BracketRight: ']',
    Minus: '-',
    Equal: '=',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
  };
  if (map[code]) return map[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Numpad ' + code.slice(6);
  return code;
}

function KeyBindingPicker({ value, onChange }: { value: string; onChange: (code: string) => void }) {
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (!listening) return;

    function onKeyDown(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        setListening(false);
        return;
      }
      onChange(e.code);
      setListening(false);
    }

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [listening, onChange]);

  return (
    <button
      type="button"
      onClick={() => setListening(true)}
      className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
        listening
          ? 'border-vox-accent-primary bg-vox-accent-primary/10 text-vox-accent-primary animate-pulse'
          : 'border-vox-border bg-vox-bg-secondary text-vox-text-primary hover:border-vox-accent-primary'
      }`}
    >
      <Keyboard size={14} />
      {listening ? 'Press a key...' : formatKeyCode(value)}
    </button>
  );
}

// ─── Change Password Form ────────────────────────────────────────────────────

function ChangePasswordForm() {
  const { changePassword } = useAuthStore();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const [showPasswords, setShowPasswords] = useState(false);

  const handleChangePassword = async () => {
    setPasswordError(null);

    if (newPassword.length < LIMITS.PASSWORD_MIN) {
      setPasswordError(`New password must be at least ${LIMITS.PASSWORD_MIN} characters.`);
      return;
    }

    if (newPassword !== confirmNewPassword) {
      setPasswordError('New passwords do not match.');
      return;
    }

    setChangingPassword(true);
    try {
      await changePassword(currentPassword, newPassword);
      toast.success('Password changed successfully');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
    } catch (err: any) {
      setPasswordError(err.response?.data?.error || 'Failed to change password');
    } finally {
      setChangingPassword(false);
    }
  };

  return (
    <div className="border-t border-vox-border pt-5">
      <div className="flex items-center gap-2 mb-4">
        <Lock size={16} className="text-vox-text-muted" />
        <h3 className="text-sm font-semibold text-vox-text-primary">Change Password</h3>
      </div>

      {passwordError && (
        <div className="mb-3 rounded-lg bg-vox-accent-danger/10 border border-vox-accent-danger/20 px-3 py-2 text-xs text-vox-accent-danger">
          {passwordError}
        </div>
      )}

      <div className="space-y-3">
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-vox-text-muted mb-1.5">
            Current Password
          </label>
          <div className="relative">
            <input
              type={showPasswords ? 'text' : 'password'}
              value={currentPassword}
              onChange={(e) => { setCurrentPassword(e.target.value); setPasswordError(null); }}
              className="w-full rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 pr-10 text-sm text-vox-text-primary focus:outline-none focus:border-vox-accent-primary"
              placeholder="Current password"
            />
            <button
              type="button"
              onClick={() => setShowPasswords(!showPasswords)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-vox-text-muted hover:text-vox-text-secondary"
            >
              {showPasswords ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-vox-text-muted mb-1.5">
            New Password
          </label>
          <input
            type={showPasswords ? 'text' : 'password'}
            value={newPassword}
            onChange={(e) => { setNewPassword(e.target.value); setPasswordError(null); }}
            className="w-full rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-sm text-vox-text-primary focus:outline-none focus:border-vox-accent-primary"
            placeholder="New password"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-vox-text-muted mb-1.5">
            Confirm New Password
          </label>
          <input
            type={showPasswords ? 'text' : 'password'}
            value={confirmNewPassword}
            onChange={(e) => { setConfirmNewPassword(e.target.value); setPasswordError(null); }}
            className="w-full rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-sm text-vox-text-primary focus:outline-none focus:border-vox-accent-primary"
            placeholder="Confirm new password"
          />
        </div>

        <button
          onClick={handleChangePassword}
          disabled={changingPassword || !currentPassword || !newPassword || !confirmNewPassword}
          className="btn-primary w-full disabled:opacity-50"
        >
          {changingPassword ? 'Changing...' : 'Change Password'}
        </button>
      </div>
    </div>
  );
}

// ─── Profile Tab ──────────────────────────────────────────────────────────────

function ProfileTab() {
  const { user, uploadAvatar, updateProfile } = useAuthStore();
  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [bio, setBio] = useState(user?.bio || '');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleAvatarClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset input so re-selecting the same file triggers change
    e.target.value = '';

    setUploading(true);
    try {
      await uploadAvatar(file);
      toast.success('Avatar updated');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to upload avatar');
    } finally {
      setUploading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateProfile({
        displayName: displayName.trim() || undefined,
        bio: bio.trim(),
      });
      toast.success('Profile updated');
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update profile');
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = displayName.trim() !== (user?.displayName || '') || bio.trim() !== (user?.bio || '');

  return (
    <div className="space-y-6">
      {/* Avatar */}
      <div className="flex flex-col items-center gap-3">
        <button
          type="button"
          onClick={handleAvatarClick}
          className="relative group"
          disabled={uploading}
        >
          <Avatar avatarUrl={user?.avatarUrl} displayName={user?.displayName} size="lg" />
          {uploading ? (
            <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-white border-t-transparent" />
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/0 group-hover:bg-black/40 transition-colors">
              <span className="text-xs font-medium text-white opacity-0 group-hover:opacity-100 transition-opacity">
                Change
              </span>
            </div>
          )}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          onChange={handleFileChange}
          className="hidden"
        />
        <p className="text-[10px] text-vox-text-muted">Click to change avatar</p>
      </div>

      {/* Display Name */}
      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-vox-text-muted mb-1.5">
          Display Name
        </label>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={LIMITS.DISPLAY_NAME_MAX}
          className="w-full rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-sm text-vox-text-primary focus:outline-none focus:border-vox-accent-primary"
          placeholder={user?.username}
        />
      </div>

      {/* Bio */}
      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-vox-text-muted mb-1.5">
          About Me
        </label>
        <textarea
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          maxLength={LIMITS.BIO_MAX}
          rows={3}
          className="w-full resize-none rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-sm text-vox-text-primary focus:outline-none focus:border-vox-accent-primary"
          placeholder="Tell others about yourself"
        />
        <p className="mt-1 text-right text-[10px] text-vox-text-muted">
          {bio.length}/{LIMITS.BIO_MAX}
        </p>
      </div>

      {/* Save */}
      <button
        onClick={handleSave}
        disabled={!hasChanges || saving}
        className="btn-primary w-full disabled:opacity-50"
      >
        {saving ? 'Saving...' : 'Save Changes'}
      </button>

      <ChangePasswordForm />
    </div>
  );
}

// ─── Audio Tab ────────────────────────────────────────────────────────────────

function AudioTab() {
  const {
    audioInputDeviceId,
    audioOutputDeviceId,
    noiseGateThreshold,
    voiceMode,
    pushToTalkKey,
    enableNotificationSounds,
    enableDesktopNotifications,
    setAudioInputDeviceId,
    setAudioOutputDeviceId,
    setNoiseGateThreshold,
    setVoiceMode,
    setPushToTalkKey,
    setEnableNotificationSounds,
    setEnableDesktopNotifications,
  } = useSettingsStore();

  const [inputDevices, setInputDevices] = useState<DeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<DeviceInfo[]>([]);
  const [micLevel, setMicLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const micStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const stopMicPreview = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    setMicLevel(0);
  }, []);

  const startMicPreview = useCallback(async (deviceId: string) => {
    stopMicPreview();

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Microphone access not available (insecure context?)');
      return;
    }

    try {
      const constraints: MediaStreamConstraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      micStreamRef.current = stream;

      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);

      const dataArray = new Float32Array(analyser.fftSize);

      function tick() {
        analyser.getFloatTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i] * dataArray[i];
        }
        const rms = Math.sqrt(sum / dataArray.length);
        setMicLevel(Math.min(rms / 0.15, 1));
        rafRef.current = requestAnimationFrame(tick);
      }
      rafRef.current = requestAnimationFrame(tick);
      setError(null);
    } catch {
      toast.error('Could not access microphone');
      setError('Could not access microphone');
    }
  }, [stopMicPreview]);

  useEffect(() => {
    async function loadDevices() {
      if (!navigator.mediaDevices?.enumerateDevices) {
        setError('Device enumeration not available');
        return;
      }

      try {
        if (navigator.mediaDevices.getUserMedia) {
          const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          tempStream.getTracks().forEach((t) => t.stop());
        }

        const devices = await navigator.mediaDevices.enumerateDevices();
        setInputDevices(
          devices
            .filter((d) => d.kind === 'audioinput')
            .map((d) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${d.deviceId.slice(0, 8)}` }))
        );
        setOutputDevices(
          devices
            .filter((d) => d.kind === 'audiooutput')
            .map((d) => ({ deviceId: d.deviceId, label: d.label || `Speaker ${d.deviceId.slice(0, 8)}` }))
        );
      } catch (err) {
        console.warn('[Settings] enumerateDevices failed:', err);
        setError('Could not list audio devices');
      }
    }

    loadDevices();
  }, []);

  useEffect(() => {
    startMicPreview(audioInputDeviceId);
    return () => stopMicPreview();
  }, [audioInputDeviceId, startMicPreview, stopMicPreview]);

  return (
    <div>
      {error && (
        <div className="mb-4 rounded-lg bg-vox-accent-danger/10 px-3 py-2 text-xs text-vox-accent-danger">
          {error}
        </div>
      )}

      {/* Input Device */}
      <div className="mb-5">
        <label className="block text-xs font-semibold uppercase tracking-wide text-vox-text-muted mb-1.5">
          Input Device
        </label>
        <select
          value={audioInputDeviceId}
          onChange={(e) => setAudioInputDeviceId(e.target.value)}
          className="w-full rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-sm text-vox-text-primary focus:outline-none focus:border-vox-accent-primary"
        >
          <option value="">System Default</option>
          {inputDevices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
          ))}
        </select>

        <div className="mt-2 h-2 rounded-full bg-vox-bg-secondary overflow-hidden">
          <div
            className="h-full rounded-full bg-vox-voice-connected transition-all duration-75"
            style={{ width: `${Math.max(micLevel * 100, 0)}%` }}
          />
        </div>
        <p className="mt-1 text-[10px] text-vox-text-muted">Speak to test your microphone</p>
      </div>

      {/* Output Device */}
      <div className="mb-5">
        <label className="block text-xs font-semibold uppercase tracking-wide text-vox-text-muted mb-1.5">
          Output Device
        </label>
        <select
          value={audioOutputDeviceId}
          onChange={(e) => setAudioOutputDeviceId(e.target.value)}
          className="w-full rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-sm text-vox-text-primary focus:outline-none focus:border-vox-accent-primary"
        >
          <option value="">System Default</option>
          {outputDevices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
          ))}
        </select>
      </div>

      {/* Voice Mode */}
      <div className="mb-5">
        <label className="block text-xs font-semibold uppercase tracking-wide text-vox-text-muted mb-1.5">
          Input Mode
        </label>
        <div className="flex rounded-lg border border-vox-border overflow-hidden">
          <button
            type="button"
            onClick={() => setVoiceMode('voice_activity')}
            className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
              voiceMode === 'voice_activity'
                ? 'bg-vox-accent-primary text-white'
                : 'bg-vox-bg-secondary text-vox-text-muted hover:text-vox-text-primary'
            }`}
          >
            Voice Activity
          </button>
          <button
            type="button"
            onClick={() => setVoiceMode('push_to_talk')}
            className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
              voiceMode === 'push_to_talk'
                ? 'bg-vox-accent-primary text-white'
                : 'bg-vox-bg-secondary text-vox-text-muted hover:text-vox-text-primary'
            }`}
          >
            Push to Talk
          </button>
        </div>
      </div>

      {/* PTT Key Picker */}
      {voiceMode === 'push_to_talk' && (
        <div className="mb-5">
          <label className="block text-xs font-semibold uppercase tracking-wide text-vox-text-muted mb-1.5">
            Push to Talk Key
          </label>
          <KeyBindingPicker value={pushToTalkKey} onChange={setPushToTalkKey} />
          <p className="mt-1 text-[10px] text-vox-text-muted">
            Hold this key to transmit audio
          </p>
        </div>
      )}

      {/* Mic Sensitivity */}
      {voiceMode === 'voice_activity' && <div className="mb-2">
        <label className="block text-xs font-semibold uppercase tracking-wide text-vox-text-muted mb-1.5">
          Mic Sensitivity
        </label>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min="0.005"
            max="0.1"
            step="0.005"
            value={noiseGateThreshold}
            onChange={(e) => setNoiseGateThreshold(parseFloat(e.target.value))}
            className="flex-1 accent-vox-accent-primary"
          />
          <span className="text-xs text-vox-text-secondary w-8 text-right">
            {Math.round(noiseGateThreshold * 1000)}
          </span>
        </div>
        <p className="mt-1 text-[10px] text-vox-text-muted">
          Lower = more sensitive (picks up quieter sounds)
        </p>
      </div>}

      {/* Notifications */}
      <div className="border-t border-vox-border pt-5 mt-5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-vox-text-muted mb-3">
          Notifications
        </h3>

        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Volume2 size={16} className="text-vox-text-muted" />
            <div>
              <p className="text-sm text-vox-text-primary">Notification Sounds</p>
              <p className="text-[10px] text-vox-text-muted">Play sounds for voice join/leave and new messages</p>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enableNotificationSounds}
            onClick={() => setEnableNotificationSounds(!enableNotificationSounds)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
              enableNotificationSounds ? 'bg-vox-accent-primary' : 'bg-vox-bg-secondary'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform mt-0.5 ${
                enableNotificationSounds ? 'translate-x-[22px]' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bell size={16} className="text-vox-text-muted" />
            <div>
              <p className="text-sm text-vox-text-primary">Desktop Notifications</p>
              <p className="text-[10px] text-vox-text-muted">Show Windows notifications for messages and voice events</p>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enableDesktopNotifications}
            onClick={() => setEnableDesktopNotifications(!enableDesktopNotifications)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
              enableDesktopNotifications ? 'bg-vox-accent-primary' : 'bg-vox-bg-secondary'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform mt-0.5 ${
                enableDesktopNotifications ? 'translate-x-[22px]' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Settings Modal ──────────────────────────────────────────────────────

export function SettingsModal() {
  const { closeSettings } = useSettingsStore();
  const [activeTab, setActiveTab] = useState<SettingsTab>('account');

  const tabs: { id: SettingsTab; label: string; icon: typeof User }[] = [
    { id: 'account', label: 'My Account', icon: User },
    { id: 'audio', label: 'Audio & Video', icon: Headphones },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in">
      <div className="absolute inset-0 bg-black/60" onClick={closeSettings} />
      <div className="relative flex w-full max-w-2xl rounded-xl border border-vox-border bg-vox-bg-floating shadow-2xl animate-slide-up" style={{ maxHeight: '85vh' }}>
        {/* Left sidebar nav */}
        <div className="w-40 shrink-0 border-r border-vox-border p-3">
          <h2 className="mb-3 px-2 text-xs font-bold uppercase tracking-wide text-vox-text-muted">Settings</h2>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors ${
                activeTab === tab.id
                  ? 'bg-vox-bg-active text-vox-text-primary font-medium'
                  : 'text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-secondary'
              }`}
            >
              <tab.icon size={16} />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-bold text-vox-text-primary">
              {tabs.find((t) => t.id === activeTab)?.label}
            </h2>
            <button
              onClick={closeSettings}
              className="rounded-md p-1 text-vox-text-muted hover:text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          {activeTab === 'account' ? <ProfileTab /> : <AudioTab />}
        </div>
      </div>
    </div>
  );
}
