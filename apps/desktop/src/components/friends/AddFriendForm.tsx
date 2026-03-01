import { useState } from 'react';
import { useFriendStore } from '../../stores/friendStore';
import { toast } from '../../stores/toastStore';
import { UserPlus } from 'lucide-react';

export function AddFriendForm() {
  const [username, setUsername] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const sendRequest = useFriendStore((s) => s.sendRequest);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = username.trim();
    if (!trimmed) return;

    setIsLoading(true);
    try {
      const status = await sendRequest(trimmed);
      toast.success(status === 'accepted' ? `You and ${trimmed} are now friends!` : `Friend request sent to ${trimmed}`);
      setUsername('');
    } catch (err: any) {
      const msg = err.response?.data?.error || 'Failed to send friend request';
      toast.error(msg);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="p-6">
      <h3 className="text-sm font-bold uppercase tracking-wide text-vox-text-primary">
        Add Friend
      </h3>
      <p className="mt-1 text-xs text-vox-text-muted">
        You can add friends with their Voxium username.
      </p>

      <form onSubmit={handleSubmit} className="mt-4 flex gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Enter a username"
            className="w-full rounded-md border border-vox-border bg-vox-bg-primary px-3 py-2 text-sm text-vox-text-primary placeholder-vox-text-muted outline-none focus:border-vox-accent-primary"
            disabled={isLoading}
          />
        </div>
        <button
          type="submit"
          disabled={!username.trim() || isLoading}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-vox-accent-success px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-vox-accent-success/80 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <UserPlus size={14} />
          Send Friend Request
        </button>
      </form>
    </div>
  );
}
