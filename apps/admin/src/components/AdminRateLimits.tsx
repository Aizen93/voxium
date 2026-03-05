import { useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Gauge, RotateCcw, Trash2, Save, HelpCircle } from 'lucide-react';
import { useAdminStore } from '../stores/adminStore';
import { toast } from '../stores/toastStore';

interface EditState {
  name: string;
  points: number;
  duration: number;
  blockDuration: number;
}

const RULE_DESCRIPTIONS: Record<string, string> = {
  login: 'Limits login attempts to prevent brute-force password guessing.',
  register: 'Limits account creation to prevent spam registrations.',
  forgotPassword: 'Limits password reset email requests to prevent email flooding.',
  resetPassword: 'Limits password reset submissions to prevent token brute-forcing.',
  refresh: 'Limits auth token refresh requests.',
  changePassword: 'Limits password change attempts for logged-in users.',
  messageSend: 'Limits how many messages a user can send per time window.',
  upload: 'Limits file upload requests (avatars, server icons).',
  friendRequest: 'Limits friend request sending to prevent spam.',
  memberManage: 'Limits server member actions (kick, role change, etc).',
  categoryManage: 'Limits channel/category create, update, delete, and reorder actions.',
  search: 'Limits search queries to prevent abuse.',
  stats: 'Limits stats/health endpoint requests.',
  admin: 'Limits admin panel API requests.',
  report: 'Limits how often a user can submit reports.',
  support: 'Limits support ticket message sending.',
  general: 'Catch-all limiter applied to all other API routes.',
};

function Tip({ text }: { text: string }) {
  const iconRef = useRef<HTMLSpanElement>(null);
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const handleEnter = useCallback(() => {
    if (!iconRef.current) return;
    const rect = iconRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 6, left: rect.left + rect.width / 2 });
    setShow(true);
  }, []);

  return (
    <span ref={iconRef} className="inline-flex ml-1 cursor-help" onMouseEnter={handleEnter} onMouseLeave={() => setShow(false)}>
      <HelpCircle size={12} className="text-vox-text-muted" />
      {show && createPortal(
        <div
          style={{ position: 'fixed', top: pos.top, left: pos.left, transform: 'translateX(-50%)' }}
          className="w-48 px-2 py-1.5 text-[10px] leading-tight text-vox-text-primary bg-vox-bg-primary border border-vox-border rounded shadow-lg z-[9999] normal-case font-normal tracking-normal whitespace-normal"
        >
          {text}
        </div>,
        document.body
      )}
    </span>
  );
}

export function AdminRateLimits() {
  const { rateLimits, fetchRateLimits, updateRateLimit, resetRateLimit, clearUserRateLimits } = useAdminStore();
  const [editing, setEditing] = useState<EditState | null>(null);
  const [clearKey, setClearKey] = useState('');
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    fetchRateLimits();
  }, [fetchRateLimits]);

  const handleEdit = (rule: typeof rateLimits[number]) => {
    setEditing({
      name: rule.name,
      points: rule.points,
      duration: rule.duration,
      blockDuration: rule.blockDuration,
    });
  };

  const handleSave = async () => {
    if (!editing) return;
    try {
      await updateRateLimit(editing.name, {
        points: editing.points,
        duration: editing.duration,
        blockDuration: editing.blockDuration,
      });
      toast.success(`Rate limit "${editing.name}" updated`);
      setEditing(null);
    } catch {
      toast.error('Failed to update rate limit');
    }
  };

  const handleReset = async (name: string) => {
    try {
      await resetRateLimit(name);
      toast.success(`Rate limit "${name}" reset to default`);
    } catch {
      toast.error('Failed to reset rate limit');
    }
  };

  const handleClearUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clearKey.trim() || clearing) return;
    setClearing(true);
    try {
      const cleared = await clearUserRateLimits(clearKey.trim());
      toast.success(`Cleared ${cleared} rate limit key(s) for "${clearKey.trim()}"`);
      setClearKey('');
    } catch {
      toast.error('Failed to clear user rate limits');
    } finally {
      setClearing(false);
    }
  };

  const formatDuration = (seconds: number) => {
    if (seconds >= 3600) return `${seconds / 3600}h`;
    if (seconds >= 60) return `${seconds / 60}m`;
    return `${seconds}s`;
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-vox-text-primary flex items-center gap-2">
        <Gauge size={20} /> Rate Limit Controls
      </h2>

      {/* Clear user rate limits */}
      <div className="rounded-lg bg-vox-bg-secondary border border-vox-border p-4">
        <h3 className="text-sm font-semibold text-vox-text-primary mb-2 inline-flex items-center">Clear User Rate Limits<Tip text="This resets the user's request counters back to zero, giving them a fresh quota. It does NOT remove rate limiting — the rules still apply, the user just gets a clean slate." /></h3>
        <p className="text-xs text-vox-text-muted mb-3">Reset all rate limit counters for a specific user ID or IP address.</p>
        <form onSubmit={handleClearUser} className="flex gap-2">
          <input
            type="text"
            value={clearKey}
            onChange={(e) => setClearKey(e.target.value)}
            placeholder="User ID or IP address"
            className="flex-1 rounded-md border border-vox-border bg-vox-bg-hover px-3 py-1.5 text-sm text-vox-text-primary placeholder:text-vox-text-muted focus:border-vox-accent-primary focus:outline-none"
          />
          <button
            type="submit"
            disabled={!clearKey.trim() || clearing}
            className="flex items-center gap-1.5 rounded-md bg-vox-accent-primary px-3 py-1.5 text-sm text-white hover:bg-vox-accent-primary/90 disabled:opacity-50 transition-colors"
          >
            <Trash2 size={14} /> Clear
          </button>
        </form>
      </div>

      {/* Rate limits table */}
      <div className="rounded-lg bg-vox-bg-secondary border border-vox-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-vox-border">
              <th className="px-4 py-3 text-left text-xs font-medium text-vox-text-muted uppercase">Rule</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-vox-text-muted uppercase">Key Type</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-vox-text-muted uppercase"><span className="inline-flex items-center">Max Requests<Tip text="Maximum number of requests allowed within the time window before the user gets rate limited." /></span></th>
              <th className="px-4 py-3 text-left text-xs font-medium text-vox-text-muted uppercase"><span className="inline-flex items-center">Time Window<Tip text="The rolling time period (in seconds) during which requests are counted. Counters reset after this period." /></span></th>
              <th className="px-4 py-3 text-left text-xs font-medium text-vox-text-muted uppercase"><span className="inline-flex items-center">Block Duration<Tip text="How long (in seconds) the user is locked out after exceeding the max requests. Set to 0 for no lockout." /></span></th>
              <th className="px-4 py-3 text-left text-xs font-medium text-vox-text-muted uppercase w-[140px]">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rateLimits.map((rule) => {
              const isEditing = editing?.name === rule.name;
              return (
                <tr key={rule.name} className="border-b border-vox-border/50 hover:bg-vox-bg-hover transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-vox-text-primary font-medium text-xs inline-flex items-center">{rule.label}{RULE_DESCRIPTIONS[rule.name] && <Tip text={RULE_DESCRIPTIONS[rule.name]} />}</span>
                      {rule.isCustom && (
                        <span className="rounded bg-vox-accent-warning/20 px-1 py-0.5 text-[9px] font-bold text-vox-accent-warning uppercase">Custom</span>
                      )}
                    </div>
                    <span className="text-[10px] text-vox-text-muted">{rule.name}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      rule.keyType === 'ip' ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400'
                    }`}>
                      {rule.keyType === 'ip' ? 'IP' : 'User'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {isEditing ? (
                      <input
                        type="number"
                        min={1}
                        value={editing.points}
                        onChange={(e) => setEditing({ ...editing, points: parseInt(e.target.value) || 1 })}
                        className="w-16 rounded border border-vox-border bg-vox-bg-hover px-2 py-0.5 text-xs text-vox-text-primary focus:border-vox-accent-primary focus:outline-none"
                      />
                    ) : (
                      <span className="text-vox-text-secondary text-xs">{rule.points}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {isEditing ? (
                      <input
                        type="number"
                        min={1}
                        value={editing.duration}
                        onChange={(e) => setEditing({ ...editing, duration: parseInt(e.target.value) || 1 })}
                        className="w-16 rounded border border-vox-border bg-vox-bg-hover px-2 py-0.5 text-xs text-vox-text-primary focus:border-vox-accent-primary focus:outline-none"
                        title="Duration in seconds"
                      />
                    ) : (
                      <span className="text-vox-text-secondary text-xs">{formatDuration(rule.duration)}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {isEditing ? (
                      <input
                        type="number"
                        min={0}
                        value={editing.blockDuration}
                        onChange={(e) => setEditing({ ...editing, blockDuration: parseInt(e.target.value) || 0 })}
                        className="w-16 rounded border border-vox-border bg-vox-bg-hover px-2 py-0.5 text-xs text-vox-text-primary focus:border-vox-accent-primary focus:outline-none"
                        title="Block duration in seconds"
                      />
                    ) : (
                      <span className="text-vox-text-secondary text-xs">{rule.blockDuration > 0 ? formatDuration(rule.blockDuration) : '-'}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1.5">
                      {isEditing ? (
                        <>
                          <button
                            onClick={handleSave}
                            className="p-1 rounded text-green-400 hover:bg-green-500/20 transition-colors"
                            title="Save"
                          >
                            <Save size={14} />
                          </button>
                          <button
                            onClick={() => setEditing(null)}
                            className="px-2 py-0.5 rounded text-xs text-vox-text-muted hover:bg-vox-bg-active transition-colors"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => handleEdit(rule)}
                            className="px-2 py-0.5 rounded text-xs bg-vox-bg-hover text-vox-text-secondary hover:text-vox-text-primary transition-colors"
                          >
                            Edit
                          </button>
                          {rule.isCustom && (
                            <button
                              onClick={() => handleReset(rule.name)}
                              className="p-1 rounded text-vox-text-muted hover:text-vox-accent-warning hover:bg-vox-accent-warning/10 transition-colors"
                              title="Reset to default"
                            >
                              <RotateCcw size={14} />
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
