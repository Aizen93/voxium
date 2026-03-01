import { useState, useEffect } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { X, Copy, Check } from 'lucide-react';

interface Props {
  serverId: string;
  onClose: () => void;
}

export function InviteModal({ serverId, onClose }: Props) {
  const { createInvite } = useServerStore();
  const [inviteCode, setInviteCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const baseUrl = import.meta.env.VITE_WS_URL || window.location.origin;
  const inviteLink = `${baseUrl}/invite/${inviteCode}`;

  useEffect(() => {
    createInvite(serverId)
      .then((code) => {
        setInviteCode(code);
        setLoading(false);
      })
      .catch((err: any) => {
        setError(err.response?.data?.error || 'Failed to create invite');
        setLoading(false);
      });
  }, [serverId, createInvite]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for non-secure contexts
      const textarea = document.createElement('textarea');
      textarea.value = inviteLink;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in">
      <div className="w-full max-w-md rounded-2xl border border-vox-border bg-vox-bg-secondary p-6 shadow-2xl animate-slide-up">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-xl font-bold text-vox-text-primary">Invite People</h2>
          <button onClick={onClose} className="text-vox-text-muted hover:text-vox-text-primary transition-colors">
            <X size={20} />
          </button>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-vox-accent-primary border-t-transparent" />
            <span className="ml-3 text-sm text-vox-text-secondary">Generating invite link...</span>
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-vox-accent-danger/10 border border-vox-accent-danger/20 px-4 py-3 text-sm text-vox-accent-danger">
            {error}
          </div>
        )}

        {!loading && !error && (
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
                Invite Link
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  className="input flex-1"
                  value={inviteLink}
                  readOnly
                  onFocus={(e) => e.target.select()}
                />
                <button
                  onClick={handleCopy}
                  className={`flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                    copied
                      ? 'bg-vox-voice-connected/20 text-vox-voice-connected'
                      : 'btn-primary'
                  }`}
                >
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
                Invite Code
              </label>
              <p className="rounded-lg bg-vox-bg-hover px-3 py-2 text-sm font-mono text-vox-text-primary select-all">
                {inviteCode}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
