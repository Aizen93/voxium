import { useState, useEffect, useRef, useCallback } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import { Avatar } from '../common/Avatar';
import { X, Keyboard, Volume2, Bell, User, Headphones, Shield, ShieldCheck, ShieldOff, Lock, Eye, EyeOff, AudioLines, Copy, Check, Radio, Palette } from 'lucide-react';
import { THEMES } from '../../stores/settingsStore';
import type { VoiceQuality } from '../../stores/settingsStore';
import { LIMITS } from '@voxium/shared';
import axios from 'axios';

interface DeviceInfo {
  deviceId: string;
  label: string;
}

type SettingsTab = 'account' | 'security' | 'appearance' | 'audio';

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
    } catch (err) {
      setPasswordError(axios.isAxiosError(err) ? err.response?.data?.error || 'Failed to change password' : 'Failed to change password');
    } finally {
      setChangingPassword(false);
    }
  };

  return (
    <div>
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
    } catch (err) {
      toast.error(axios.isAxiosError(err) ? err.response?.data?.error || 'Failed to upload avatar' : 'Failed to upload avatar');
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
    } catch (err) {
      toast.error(axios.isAxiosError(err) ? err.response?.data?.error || 'Failed to update profile' : 'Failed to update profile');
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

    </div>
  );
}

// ─── Two-Factor Authentication ──────────────────────────────────────────────

function TwoFactorSection() {
  const { user, setupTOTP, enableTOTP, disableTOTP } = useAuthStore();
  const [step, setStep] = useState<'idle' | 'setup' | 'backup' | 'disable'>('idle');
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleSetup = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await setupTOTP();
      setQrCodeDataUrl(data.qrCodeDataUrl);
      setSecret(data.secret);
      setStep('setup');
    } catch (err) {
      setError(axios.isAxiosError(err) ? err.response?.data?.error || 'Failed to set up 2FA' : 'Failed to set up 2FA');
    } finally {
      setLoading(false);
    }
  };

  const handleEnable = async () => {
    if (code.length < 6) return;
    setLoading(true);
    setError(null);
    try {
      const codes = await enableTOTP(code);
      setBackupCodes(codes);
      setStep('backup');
      setCode('');
    } catch (err) {
      setError(axios.isAxiosError(err) ? err.response?.data?.error || 'Invalid verification code' : 'Invalid verification code');
    } finally {
      setLoading(false);
    }
  };

  const handleDisable = async () => {
    if (code.length < 6) return;
    setLoading(true);
    setError(null);
    try {
      await disableTOTP(code);
      toast.success('Two-factor authentication disabled');
      setStep('idle');
      setCode('');
    } catch (err) {
      setError(axios.isAxiosError(err) ? err.response?.data?.error || 'Invalid verification code' : 'Invalid verification code');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyBackupCodes = async () => {
    const text = backupCodes.join('\n');
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(textArea);
        if (!ok) throw new Error('copy failed');
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Unable to copy backup codes to clipboard');
    }
  };

  const isEnabled = user?.totpEnabled;

  return (
    <div className="border-t border-vox-border pt-5">
      <div className="flex items-center gap-2 mb-4">
        <ShieldCheck size={16} className="text-vox-text-muted" />
        <h3 className="text-sm font-semibold text-vox-text-primary">Two-Factor Authentication</h3>
        {isEnabled && (
          <span className="ml-auto rounded-full bg-vox-voice-connected/20 px-2 py-0.5 text-[10px] font-medium text-vox-voice-connected">
            Enabled
          </span>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded-lg bg-vox-accent-danger/10 border border-vox-accent-danger/20 px-3 py-2 text-xs text-vox-accent-danger">
          {error}
        </div>
      )}

      {step === 'idle' && !isEnabled && (
        <div>
          <p className="text-xs text-vox-text-muted mb-3">
            Add an extra layer of security to your account by requiring a verification code from an authenticator app when you sign in.
          </p>
          <button onClick={handleSetup} disabled={loading} className="btn-primary w-full disabled:opacity-50">
            {loading ? 'Setting up...' : 'Enable Two-Factor Authentication'}
          </button>
        </div>
      )}

      {step === 'idle' && isEnabled && (
        <div>
          <p className="text-xs text-vox-text-muted mb-3">
            Two-factor authentication is currently enabled. You will be asked for a verification code each time you sign in.
          </p>
          <button
            onClick={() => { setStep('disable'); setError(null); setCode(''); }}
            className="flex items-center gap-2 rounded-lg border border-vox-accent-danger/30 bg-vox-accent-danger/10 px-3 py-2 text-xs text-vox-accent-danger hover:bg-vox-accent-danger/20 transition-colors w-full justify-center"
          >
            <ShieldOff size={14} />
            Disable Two-Factor Authentication
          </button>
        </div>
      )}

      {step === 'setup' && (
        <div className="space-y-4">
          <p className="text-xs text-vox-text-muted">
            Scan the QR code below with your authenticator app (Google Authenticator, Authy, etc.), then enter the 6-digit code to verify.
          </p>

          <div className="flex justify-center">
            <div className="rounded-xl bg-white p-3">
              <img src={qrCodeDataUrl} alt="TOTP QR Code" className="h-48 w-48" />
            </div>
          </div>

          <div>
            <p className="text-[10px] text-vox-text-muted mb-1">Can't scan? Enter this key manually:</p>
            <code className="block rounded-lg bg-vox-bg-secondary border border-vox-border px-3 py-2 text-xs text-vox-text-primary font-mono break-all select-all">
              {secret}
            </code>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-vox-text-muted mb-1.5">
              Verification Code
            </label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => { setCode(e.target.value.replace(/\D/g, '')); setError(null); }}
              className="w-full rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-sm text-vox-text-primary text-center tracking-[0.3em] font-mono focus:outline-none focus:border-vox-accent-primary"
              placeholder="000000"
              autoFocus
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => { setStep('idle'); setCode(''); setError(null); }}
              className="flex-1 rounded-lg border border-vox-border px-3 py-2 text-xs text-vox-text-secondary hover:bg-vox-bg-hover transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleEnable}
              disabled={loading || code.length < 6}
              className="btn-primary flex-1 disabled:opacity-50"
            >
              {loading ? 'Verifying...' : 'Enable'}
            </button>
          </div>
        </div>
      )}

      {step === 'backup' && (
        <div className="space-y-4">
          <div className="rounded-lg bg-vox-accent-warning/10 border border-vox-accent-warning/20 px-3 py-2">
            <p className="text-xs text-vox-accent-warning font-medium">Save your backup codes!</p>
            <p className="text-[10px] text-vox-accent-warning/80 mt-1">
              These codes can be used to access your account if you lose your authenticator device. Each code can only be used once. Store them somewhere safe.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {backupCodes.map((c) => (
              <code key={c} className="rounded-md bg-vox-bg-secondary border border-vox-border px-3 py-1.5 text-xs text-vox-text-primary font-mono text-center">
                {c}
              </code>
            ))}
          </div>

          <button
            onClick={handleCopyBackupCodes}
            className="flex items-center justify-center gap-2 w-full rounded-lg border border-vox-border px-3 py-2 text-xs text-vox-text-secondary hover:bg-vox-bg-hover transition-colors"
          >
            {copied ? <Check size={14} className="text-vox-voice-connected" /> : <Copy size={14} />}
            {copied ? 'Copied!' : 'Copy all codes'}
          </button>

          <button
            onClick={() => { setStep('idle'); setBackupCodes([]); }}
            className="btn-primary w-full"
          >
            I've saved my backup codes
          </button>
        </div>
      )}

      {step === 'disable' && (
        <div className="space-y-4">
          <p className="text-xs text-vox-text-muted">
            Enter a verification code from your authenticator app or a backup code to disable two-factor authentication.
          </p>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-vox-text-muted mb-1.5">
              Verification Code
            </label>
            <input
              type="text"
              maxLength={8}
              value={code}
              onChange={(e) => { setCode(e.target.value.replace(/[^a-zA-Z0-9]/g, '')); setError(null); }}
              className="w-full rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-sm text-vox-text-primary text-center tracking-[0.3em] font-mono focus:outline-none focus:border-vox-accent-primary"
              placeholder="000000"
              autoFocus
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => { setStep('idle'); setCode(''); setError(null); }}
              className="flex-1 rounded-lg border border-vox-border px-3 py-2 text-xs text-vox-text-secondary hover:bg-vox-bg-hover transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleDisable}
              disabled={loading || code.length < 6}
              className="flex-1 rounded-lg bg-vox-accent-danger px-3 py-2 text-xs text-white hover:bg-vox-accent-danger/80 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Disabling...' : 'Disable'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Security Tab ────────────────────────────────────────────────────────────

function SecurityTab() {
  return (
    <div className="space-y-6">
      <ChangePasswordForm />
      <TwoFactorSection />
    </div>
  );
}

// ─── Audio Tab ────────────────────────────────────────────────────────────────

function AppearanceTab() {
  const { theme, setTheme } = useSettingsStore();

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-vox-text-primary mb-1">Theme</h3>
        <p className="text-xs text-vox-text-muted mb-3">Choose how Voxium looks to you</p>
        <div className="flex gap-3">
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => setTheme(t.id)}
              className={`relative flex flex-col items-center gap-2 rounded-xl border-2 p-3 transition-colors ${
                theme === t.id
                  ? 'border-vox-accent-primary bg-vox-accent-primary/10'
                  : 'border-vox-border hover:border-vox-text-muted'
              }`}
              style={{ width: 120 }}
            >
              {/* Theme preview */}
              {(() => {
                const p: Record<string, { bg: string; sidebar: string; channel: string; line: string }> = {
                  dark:     { bg: '#1a1a2e', sidebar: '#12122a', channel: '#151530', line: '#2a2a4a' },
                  light:    { bg: '#f2f3f5', sidebar: '#e3e5eb', channel: '#ebedf2', line: '#c8c8d8' },
                  midnight: { bg: '#0a0a12', sidebar: '#060610', channel: '#0c0c18', line: '#1a1a30' },
                };
                const c = p[t.id] || p.dark;
                return (
                  <div className="w-full h-16 rounded-lg overflow-hidden flex" style={{ background: c.bg }}>
                    <div className="w-1/4 h-full" style={{ background: c.sidebar }} />
                    <div className="w-1/4 h-full" style={{ background: c.channel }} />
                    <div className="flex-1 h-full p-1.5 flex flex-col justify-end gap-0.5">
                      <div className="h-1.5 w-3/4 rounded-full" style={{ background: c.line }} />
                      <div className="h-1.5 w-1/2 rounded-full" style={{ background: c.line }} />
                    </div>
                  </div>
                );
              })()}
              <span className={`text-xs font-medium ${theme === t.id ? 'text-vox-accent-primary' : 'text-vox-text-secondary'}`}>
                {t.label}
              </span>
              {theme === t.id && (
                <div className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-vox-accent-primary flex items-center justify-center">
                  <Check size={12} className="text-white" />
                </div>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-vox-border bg-vox-bg-secondary/50 p-4">
        <p className="text-xs text-vox-text-muted">
          More themes coming soon — including community-created custom themes.
        </p>
      </div>
    </div>
  );
}

function AudioTab() {
  const {
    audioInputDeviceId,
    audioOutputDeviceId,
    noiseGateThreshold,
    voiceMode,
    voiceQuality,
    pushToTalkKey,
    enableNoiseSuppression,
    enableNotificationSounds,
    enableDesktopNotifications,
    setAudioInputDeviceId,
    setAudioOutputDeviceId,
    setNoiseGateThreshold,
    setVoiceMode,
    setVoiceQuality,
    setPushToTalkKey,
    setEnableNoiseSuppression,
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

      {/* Noise Suppression */}
      <div className="mb-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AudioLines size={16} className="text-vox-text-muted" />
            <div>
              <p className="text-sm text-vox-text-primary">AI Noise Suppression</p>
              <p className="text-[10px] text-vox-text-muted">ML-powered filter (RNNoise) removes keyboard, mouse, and background noise</p>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enableNoiseSuppression}
            onClick={() => setEnableNoiseSuppression(!enableNoiseSuppression)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
              enableNoiseSuppression ? 'bg-vox-accent-primary' : 'bg-vox-bg-secondary'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform mt-0.5 ${
                enableNoiseSuppression ? 'translate-x-[22px]' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      </div>

      {/* Voice Quality */}
      <div className="mb-5">
        <div className="flex items-center gap-2 mb-1.5">
          <Radio size={16} className="text-vox-text-muted" />
          <label className="text-xs font-semibold uppercase tracking-wide text-vox-text-muted">
            Voice Quality
          </label>
        </div>
        <div className="flex rounded-lg border border-vox-border overflow-hidden">
          {([
            { id: 'low' as VoiceQuality, label: 'Low', desc: '16 kbps' },
            { id: 'medium' as VoiceQuality, label: 'Medium', desc: '32 kbps' },
            { id: 'high' as VoiceQuality, label: 'High', desc: '64 kbps' },
          ]).map((q) => (
            <button
              key={q.id}
              type="button"
              onClick={() => setVoiceQuality(q.id)}
              className={`flex-1 px-3 py-2 transition-colors ${
                voiceQuality === q.id
                  ? 'bg-vox-accent-primary text-white'
                  : 'bg-vox-bg-secondary text-vox-text-muted hover:text-vox-text-primary'
              }`}
            >
              <span className="text-sm font-medium">{q.label}</span>
              <span className={`block text-[10px] ${voiceQuality === q.id ? 'text-white/70' : 'text-vox-text-muted'}`}>{q.desc}</span>
            </button>
          ))}
        </div>
        <p className="mt-1 text-[10px] text-vox-text-muted">
          Higher quality uses more bandwidth. Takes effect on next voice join.
        </p>
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
          <span className="text-[10px] text-vox-text-muted">Sensitive</span>
          <input
            type="range"
            min="0.002"
            max="0.05"
            step="0.001"
            value={noiseGateThreshold}
            onChange={(e) => setNoiseGateThreshold(parseFloat(e.target.value))}
            className="flex-1 accent-vox-accent-primary"
          />
          <span className="text-[10px] text-vox-text-muted">Aggressive</span>
        </div>
        <p className="mt-1 text-[10px] text-vox-text-muted">
          Filters background noise (keyboard, mouse). Move right to filter more.
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
    { id: 'security', label: 'Security', icon: Shield },
    { id: 'appearance', label: 'Appearance', icon: Palette },
    { id: 'audio', label: 'Audio & Video', icon: Headphones },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in">
      <div className="absolute inset-0 bg-black/60" onClick={closeSettings} />
      <div className="relative flex w-full max-w-4xl rounded-xl border border-vox-border bg-vox-bg-floating shadow-2xl animate-slide-up" style={{ maxHeight: '85vh' }}>
        {/* Left sidebar nav */}
        <div className="w-48 shrink-0 border-r border-vox-border p-4">
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

          {activeTab === 'account' && <ProfileTab />}
          {activeTab === 'security' && <SecurityTab />}
          {activeTab === 'appearance' && <AppearanceTab />}
          {activeTab === 'audio' && <AudioTab />}
        </div>
      </div>
    </div>
  );
}
