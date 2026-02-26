import { useState, useRef, useEffect } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { toast } from '../../stores/toastStore';
import { Avatar } from '../common/Avatar';
import { X } from 'lucide-react';

interface Props {
  serverId: string;
  onClose: () => void;
}

export function ServerSettingsModal({ serverId, onClose }: Props) {
  const { servers, uploadServerIcon, updateServer } = useServerStore();
  const server = servers.find((s) => s.id === serverId);

  const [name, setName] = useState(server?.name || '');
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (iconPreview) URL.revokeObjectURL(iconPreview);
    };
  }, [iconPreview]);

  if (!server) return null;

  const handleIconSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    if (iconPreview) URL.revokeObjectURL(iconPreview);
    setIconFile(file);
    setIconPreview(URL.createObjectURL(file));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Upload icon first if changed
      if (iconFile) {
        setUploading(true);
        try {
          await uploadServerIcon(serverId, iconFile);
          setIconFile(null);
        } catch (err: any) {
          toast.error(err.response?.data?.error || 'Failed to upload icon');
          setSaving(false);
          setUploading(false);
          return;
        }
        setUploading(false);
      }

      // Update name if changed
      if (name.trim() && name.trim() !== server.name) {
        await updateServer(serverId, { name: name.trim() });
      }

      toast.success('Server updated');
      onClose();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to update server');
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = (name.trim() && name.trim() !== server.name) || iconFile !== null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-xl border border-vox-border bg-vox-bg-floating p-6 shadow-2xl animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-bold text-vox-text-primary">Server Settings</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-vox-text-muted hover:text-vox-text-primary hover:bg-vox-bg-hover transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Icon */}
        <div className="flex flex-col items-center gap-3 mb-6">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="relative group"
            disabled={uploading}
          >
            {iconPreview ? (
              <img src={iconPreview} alt="Preview" className="h-20 w-20 rounded-full object-cover" />
            ) : (
              <Avatar avatarUrl={server.iconUrl} displayName={server.name} size="lg" />
            )}
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
            onChange={handleIconSelect}
            className="hidden"
          />
        </div>

        {/* Name */}
        <div className="mb-6">
          <label className="block text-xs font-semibold uppercase tracking-wide text-vox-text-muted mb-1.5">
            Server Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-vox-border bg-vox-bg-secondary px-3 py-2 text-sm text-vox-text-primary focus:outline-none focus:border-vox-accent-primary"
          />
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
    </div>
  );
}
