import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { useServerStore } from '../../stores/serverStore';
import { toast } from '../../stores/toastStore';
import { ImageUploadButton } from '../common/ImageUploadButton';
import { X } from 'lucide-react';

interface Props {
  onClose: () => void;
}

export function CreateServerModal({ onClose }: Props) {
  const { t } = useTranslation();
  const { createServer, setActiveServer, joinServer, uploadServerIcon } = useServerStore();
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [name, setName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [iconFile, setIconFile] = useState<File | null>(null);

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
          toast.warning(t('server.create.iconUploadFailed'));
        }
      }
      await setActiveServer(server.id);
      toast.success(t('server.create.serverCreated'));
      onClose();
    } catch (err) {
      setError(axios.isAxiosError(err) ? err.response?.data?.error || t('server.create.failedToCreate') : t('server.create.failedToCreate'));
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
      toast.success(t('server.create.joinedServer'));
      onClose();
    } catch (err) {
      setError(axios.isAxiosError(err) ? err.response?.data?.error || t('server.create.failedToJoin') : t('server.create.failedToJoin'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-2xl border border-vox-border bg-vox-bg-secondary p-6 shadow-2xl animate-slide-up">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-xl font-bold text-vox-text-primary">
            {mode === 'create' ? t('server.create.createTitle') : t('server.create.joinTitle')}
          </h2>
          <button onClick={onClose} className="text-vox-text-muted hover:text-vox-text-primary transition-colors" aria-label={t('common.close')}>
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
            {t('server.create.createNew')}
          </button>
          <button
            className={`flex-1 rounded-lg py-2 text-sm font-medium transition-colors ${
              mode === 'join'
                ? 'bg-vox-accent-primary text-white'
                : 'bg-vox-bg-hover text-vox-text-secondary hover:text-vox-text-primary'
            }`}
            onClick={() => { setMode('join'); setError(''); }}
          >
            {t('server.create.joinExisting')}
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
              <ImageUploadButton
                displayName={name || 'Server'}
                onFileChange={setIconFile}
                variant="create"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
                {t('server.create.serverName')}
              </label>
              <input
                type="text"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('server.create.serverNamePlaceholder')}
                required
                autoFocus
              />
            </div>
            <button type="submit" disabled={loading} className="btn-primary w-full">
              {loading ? t('server.create.creating') : t('server.create.createServer')}
            </button>
          </form>
        ) : (
          <form onSubmit={handleJoin} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-vox-text-secondary">
                {t('server.create.inviteCode')}
              </label>
              <input
                type="text"
                className="input"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder={t('server.create.inviteCodePlaceholder')}
                required
                autoFocus
              />
            </div>
            <button type="submit" disabled={loading} className="btn-primary w-full">
              {loading ? t('server.create.joining') : t('server.create.joinServer')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
