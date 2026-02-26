import { useState, useRef, useEffect, type FormEvent } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { toast } from '../../stores/toastStore';
import { X, Camera } from 'lucide-react';

interface Props {
  onClose: () => void;
}

export function CreateServerModal({ onClose }: Props) {
  const { createServer, setActiveServer, joinServer, uploadServerIcon } = useServerStore();
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [name, setName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Cleanup object URL on unmount
  useEffect(() => {
    return () => {
      if (iconPreview) URL.revokeObjectURL(iconPreview);
    };
  }, [iconPreview]);

  const handleIconSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    if (iconPreview) URL.revokeObjectURL(iconPreview);
    setIconFile(file);
    setIconPreview(URL.createObjectURL(file));
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const server = await createServer(name);
      if (iconFile) {
        try {
          await uploadServerIcon(server.id, iconFile);
        } catch {
          // Server was created but icon upload failed — not critical
          toast.warning('Server created but icon upload failed');
        }
      }
      await setActiveServer(server.id);
      toast.success('Server created!');
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to create server');
    } finally {
      setLoading(false);
    }
  };

  const handleJoin = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      // Extract code from a full invite URL if pasted (e.g. http://localhost:8080/invite/UsLnacI8)
      let code = inviteCode.trim();
      const urlMatch = code.match(/\/invite\/([^\s/]+)/);
      if (urlMatch) code = urlMatch[1];

      await joinServer(code);
      toast.success('Joined server!');
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to join server');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in">
      <div className="w-full max-w-md rounded-2xl border border-vox-border bg-vox-bg-secondary p-6 shadow-2xl animate-slide-up">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-xl font-bold text-vox-text-primary">
            {mode === 'create' ? 'Create a Server' : 'Join a Server'}
          </h2>
          <button onClick={onClose} className="text-vox-text-muted hover:text-vox-text-primary transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Mode Toggle */}
        <div className="mb-6 flex gap-2">
          <button
            className={`flex-1 rounded-lg py-2 text-sm font-medium transition-colors ${
              mode === 'create'
                ? 'bg-vox-accent-primary text-white'
                : 'bg-vox-bg-hover text-vox-text-secondary hover:text-vox-text-primary'
            }`}
            onClick={() => { setMode('create'); setError(''); }}
          >
            Create New
          </button>
          <button
            className={`flex-1 rounded-lg py-2 text-sm font-medium transition-colors ${
              mode === 'join'
                ? 'bg-vox-accent-primary text-white'
                : 'bg-vox-bg-hover text-vox-text-secondary hover:text-vox-text-primary'
            }`}
            onClick={() => { setMode('join'); setError(''); }}
          >
            Join Existing
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-vox-accent-danger/10 border border-vox-accent-danger/20 px-4 py-3 text-sm text-vox-accent-danger">
            {error}
          </div>
        )}

        {mode === 'create' ? (
          <form onSubmit={handleCreate} className="space-y-4">
            {/* Icon Picker */}
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="group relative flex h-20 w-20 items-center justify-center rounded-full border-2 border-dashed border-vox-border hover:border-vox-accent-primary transition-colors overflow-hidden"
              >
                {iconPreview ? (
                  <img src={iconPreview} alt="Preview" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex flex-col items-center gap-1 text-vox-text-muted group-hover:text-vox-accent-primary transition-colors">
                    <Camera size={24} />
                    <span className="text-[10px]">Icon</span>
                  </div>
                )}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                onChange={handleIconSelect}
                className="hidden"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
                Server Name
              </label>
              <input
                type="text"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Awesome Server"
                required
                autoFocus
              />
            </div>
            <button type="submit" disabled={loading} className="btn-primary w-full">
              {loading ? 'Creating...' : 'Create Server'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleJoin} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
                Invite Code
              </label>
              <input
                type="text"
                className="input"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="Enter an invite code or link"
                required
                autoFocus
              />
            </div>
            <button type="submit" disabled={loading} className="btn-primary w-full">
              {loading ? 'Joining...' : 'Join Server'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
