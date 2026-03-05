import { Shield } from 'lucide-react';

export function StaffBadge() {
  return (
    <span
      className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] font-semibold bg-vox-accent-primary/20 text-vox-accent-primary"
      title="Staff"
    >
      <Shield size={10} />
      Staff
    </span>
  );
}
