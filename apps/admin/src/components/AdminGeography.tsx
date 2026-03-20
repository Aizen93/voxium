import { useEffect, useState } from 'react';
import { useAdminStore } from '../stores/adminStore';
import { useAuthStore } from '../stores/authStore';
import { AdminGlobe } from './AdminGlobe';
import { toast } from '../stores/toastStore';
import type { InfraServer } from '@voxium/shared';

const PROVIDERS = ['OVH', 'AWS', 'Azure', 'GCP', 'Hetzner', 'DigitalOcean', 'Other'];

function InfraServerForm({ onSubmit }: { onSubmit: (data: Omit<InfraServer, 'id' | 'createdAt'>) => Promise<void> }) {
  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [city, setCity] = useState('');
  const [provider, setProvider] = useState('OVH');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    if (!name.trim() || !country.trim() || !city.trim()) {
      toast.error('Name, country, and city are required');
      return;
    }
    if (isNaN(lat) || lat < -90 || lat > 90) {
      toast.error('Latitude must be between -90 and 90');
      return;
    }
    if (isNaN(lng) || lng < -180 || lng > 180) {
      toast.error('Longitude must be between -180 and 180');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({ name: name.trim(), country: country.trim(), city: city.trim(), provider, latitude: lat, longitude: lng });
      setName('');
      setCountry('');
      setCity('');
      setProvider('OVH');
      setLatitude('');
      setLongitude('');
      toast.success('Infrastructure server added');
    } catch (err) {
      console.error('Failed to create infra server:', err);
      toast.error('Failed to add infrastructure server');
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass = 'bg-vox-bg-primary border border-vox-border rounded px-2 py-1.5 text-sm text-vox-text-primary placeholder:text-vox-text-muted focus:outline-none focus:border-vox-accent-primary';

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2 bg-vox-bg-tertiary rounded-lg p-3">
      <div className="flex flex-col gap-1">
        <label className="text-[11px] text-vox-text-muted">Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="EU-West-1" className={`${inputClass} w-28`} />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-[11px] text-vox-text-muted">Country</label>
        <input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="France" className={`${inputClass} w-24`} />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-[11px] text-vox-text-muted">City</label>
        <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Paris" className={`${inputClass} w-24`} />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-[11px] text-vox-text-muted">Provider</label>
        <select value={provider} onChange={(e) => setProvider(e.target.value)} className={`${inputClass} w-32`}>
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-[11px] text-vox-text-muted">Lat</label>
        <input value={latitude} onChange={(e) => setLatitude(e.target.value)} type="number" step="any" placeholder="48.86" className={`${inputClass} w-20`} />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-[11px] text-vox-text-muted">Lng</label>
        <input value={longitude} onChange={(e) => setLongitude(e.target.value)} type="number" step="any" placeholder="2.35" className={`${inputClass} w-20`} />
      </div>
      <button
        type="submit"
        disabled={submitting}
        className="bg-vox-accent-primary hover:bg-vox-accent-primary/80 text-white text-sm font-medium px-3 py-1.5 rounded disabled:opacity-50 transition-colors"
      >
        {submitting ? 'Adding...' : 'Add'}
      </button>
    </form>
  );
}

export function AdminGeography() {
  const { geoStats, fetchGeoStats, infraServers, fetchInfraServers, createInfraServer, deleteInfraServer } = useAdminStore();
  const isSuperAdmin = useAuthStore((s) => s.user?.role === 'superadmin');

  useEffect(() => {
    fetchGeoStats();
    fetchInfraServers();
  }, [fetchGeoStats, fetchInfraServers]);

  const totalUsers = geoStats.reduce((sum, g) => sum + g.count, 0);
  const totalCountries = geoStats.length;

  const handleDelete = async (id: string) => {
    try {
      await deleteInfraServer(id);
      toast.success('Infrastructure server removed');
    } catch (err) {
      console.error('Failed to delete infra server:', err);
      toast.error('Failed to remove infrastructure server');
    }
  };

  return (
    <div className="space-y-6 h-full">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-vox-text-primary">Geography</h2>
        <div className="flex gap-4 text-sm">
          <span className="text-vox-text-muted">
            <span className="font-semibold text-vox-text-primary">{totalUsers}</span> tracked users
          </span>
          <span className="text-vox-text-muted">
            <span className="font-semibold text-vox-text-primary">{totalCountries}</span> countries
          </span>
        </div>
      </div>

      <AdminGlobe geoStats={geoStats} infraServers={infraServers} fullPage />

      {/* Infrastructure Server Management */}
      <div className="rounded-lg bg-vox-bg-secondary border border-vox-border p-4 space-y-3">
        <h3 className="text-sm font-semibold text-vox-text-primary flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-green-500" />
          Infrastructure Servers
          <span className="text-vox-text-muted font-normal">({infraServers.length})</span>
        </h3>

        {infraServers.length > 0 && (
          <div className="space-y-1">
            {infraServers.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-xs text-vox-text-secondary bg-vox-bg-tertiary rounded px-3 py-2">
                <span className="h-2 w-2 rounded-full bg-green-500 shrink-0" />
                <span className="font-medium text-vox-text-primary">{s.name}</span>
                <span>{s.city}, {s.country}</span>
                <span className="text-vox-text-muted">{s.provider}</span>
                <span className="text-vox-text-muted ml-auto tabular-nums">{s.latitude.toFixed(2)}, {s.longitude.toFixed(2)}</span>
                {isSuperAdmin && <button onClick={() => handleDelete(s.id)} className="text-vox-accent-danger hover:underline ml-2">Remove</button>}
              </div>
            ))}
          </div>
        )}

        {isSuperAdmin && <InfraServerForm onSubmit={createInfraServer} />}
      </div>
    </div>
  );
}
