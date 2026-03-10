import { Heart } from 'lucide-react';

export function SupporterBadge() {
  return (
    <span
      className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] font-semibold bg-pink-500/20 text-pink-400"
      title="Supporter"
    >
      <Heart size={10} />
      Supporter
    </span>
  );
}
