import type { LucideIcon } from 'lucide-react';

interface AdminStatCardProps {
  label: string;
  value: number | string;
  icon: LucideIcon;
  color?: string;
}

export function AdminStatCard({ label, value, icon: Icon, color = 'text-vox-accent-primary' }: AdminStatCardProps) {
  return (
    <div className="rounded-lg bg-vox-bg-secondary border border-vox-border p-4 flex items-center gap-4">
      <div className={`flex h-10 w-10 items-center justify-center rounded-lg bg-vox-bg-hover ${color}`}>
        <Icon size={20} />
      </div>
      <div>
        <p className="text-2xl font-bold text-vox-text-primary">{typeof value === 'number' ? value.toLocaleString() : value}</p>
        <p className="text-xs text-vox-text-muted">{label}</p>
      </div>
    </div>
  );
}
