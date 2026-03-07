import { useEffect } from 'react';
import { useAdminStore } from '../stores/adminStore';
import { AdminGlobe } from './AdminGlobe';

export function AdminGeography() {
  const { geoStats, fetchGeoStats } = useAdminStore();

  useEffect(() => {
    fetchGeoStats();
  }, [fetchGeoStats]);

  const totalUsers = geoStats.reduce((sum, g) => sum + g.count, 0);
  const totalCountries = geoStats.length;

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

      <AdminGlobe geoStats={geoStats} fullPage />
    </div>
  );
}
