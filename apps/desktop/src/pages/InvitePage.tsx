import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useServerStore } from '../stores/serverStore';
import { api } from '../services/api';
import { Users } from 'lucide-react';
import axios from 'axios';

interface InvitePreview {
  code: string;
  server: {
    id: string;
    name: string;
    iconUrl: string | null;
    memberCount: number;
  };
}

export function InvitePage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { joinServer, setActiveServer } = useServerStore();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!code) return;
    api.get(`/invites/${code}`)
      .then(({ data }) => {
        setPreview(data.data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(axios.isAxiosError(err) ? err.response?.data?.error || 'This invite is invalid or has expired' : 'This invite is invalid or has expired');
        setLoading(false);
      });
  }, [code]);

  const handleJoin = async () => {
    if (!code) return;
    setJoining(true);
    setError('');
    try {
      await joinServer(code);
      if (preview?.server.id) {
        await setActiveServer(preview.server.id);
      }
      navigate('/', { replace: true });
    } catch (err) {
      setError(axios.isAxiosError(err) ? err.response?.data?.error || 'Failed to join server' : 'Failed to join server');
      setJoining(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-vox-bg-primary">
      <div className="w-full max-w-md animate-fade-in">
        <div className="rounded-2xl border border-vox-border bg-vox-bg-secondary p-8 shadow-2xl">
          {/* Logo */}
          <div className="mb-6 flex flex-col items-center">
            <img src="/logo.svg" alt="Voxium" className="h-16 w-16 rounded-2xl shadow-lg shadow-vox-accent-primary/20" />
            <h1 className="mt-4 text-xl font-bold text-vox-text-primary">You've been invited!</h1>
          </div>

          {loading && (
            <div className="flex items-center justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-vox-accent-primary border-t-transparent" />
              <span className="ml-3 text-sm text-vox-text-secondary">Loading invite...</span>
            </div>
          )}

          {error && !preview && (
            <div className="space-y-4">
              <div className="rounded-lg bg-vox-accent-danger/10 border border-vox-accent-danger/20 px-4 py-3 text-sm text-vox-accent-danger text-center">
                {error}
              </div>
              <button onClick={() => navigate('/', { replace: true })} className="btn-primary w-full">
                Go Home
              </button>
            </div>
          )}

          {preview && (
            <div className="space-y-6">
              {/* Server preview card */}
              <div className="flex flex-col items-center rounded-xl bg-vox-bg-hover p-6">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-vox-accent-primary text-2xl font-bold text-white">
                  {preview.server.name[0]?.toUpperCase() || '?'}
                </div>
                <h2 className="mt-3 text-lg font-bold text-vox-text-primary">{preview.server.name}</h2>
                <div className="mt-1 flex items-center gap-1 text-sm text-vox-text-secondary">
                  <Users size={14} />
                  <span>{preview.server.memberCount} {preview.server.memberCount === 1 ? 'member' : 'members'}</span>
                </div>
              </div>

              {error && (
                <div className="rounded-lg bg-vox-accent-danger/10 border border-vox-accent-danger/20 px-4 py-3 text-sm text-vox-accent-danger text-center">
                  {error}
                </div>
              )}

              <button
                onClick={handleJoin}
                disabled={joining}
                className="btn-primary w-full py-2.5"
              >
                {joining ? 'Joining...' : `Join ${preview.server.name}`}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
