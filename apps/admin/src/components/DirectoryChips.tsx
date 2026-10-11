import type { AdminServer } from '@voxium/shared';

/** The four inputs of the listing column plus the two curation stamps and the join mode. */
export type DirectoryState = Pick<AdminServer, 'discoverable' | 'discoveryListed' | 'featuredAt' | 'discoveryBlockedAt' | 'invitesLocked' | 'joinMode'>;

export type DirectoryChipKey = 'listed' | 'featured' | 'blocked' | 'hidden' | 'hidden-invites-locked' | 'hidden-owner-banned';

export interface DirectoryChip {
  key: DirectoryChipKey;
  label: string;
  className: string;
}

const CHIP: Record<DirectoryChipKey, DirectoryChip> = {
  listed: { key: 'listed', label: 'Listed', className: 'bg-green-500/20 text-green-400' },
  featured: { key: 'featured', label: 'Featured', className: 'bg-purple-500/20 text-purple-400' },
  blocked: { key: 'blocked', label: 'Blocked', className: 'bg-orange-500/20 text-orange-400' },
  hidden: { key: 'hidden', label: 'Hidden', className: 'bg-gray-500/20 text-gray-400' },
  'hidden-invites-locked': { key: 'hidden-invites-locked', label: 'Hidden: invites locked', className: 'bg-gray-500/20 text-gray-400' },
  'hidden-owner-banned': { key: 'hidden-owner-banned', label: 'Hidden: owner banned', className: 'bg-vox-accent-danger/20 text-vox-accent-danger' },
};

/**
 * The directory chips for one server, read off the materialised listing
 * column and its inputs. Blocked wins (a block forces the owner switch off
 * too); a listed server may also be Featured; a hidden one says WHY it is
 * hidden, in the order the listing inputs are checked: the owner switch,
 * the invites lock, and (the only input left) the owner platform ban.
 */
export function directoryChips(s: DirectoryState): DirectoryChip[] {
  if (s.discoveryBlockedAt) return [CHIP.blocked];
  if (s.discoveryListed) return s.featuredAt ? [CHIP.listed, CHIP.featured] : [CHIP.listed];
  if (!s.discoverable) return [CHIP.hidden];
  if (s.invitesLocked) return [CHIP['hidden-invites-locked']];
  return [CHIP['hidden-owner-banned']];
}

export function DirectoryChips({ server, showJoinMode = true }: { server: DirectoryState; showJoinMode?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="directory-chips">
      {directoryChips(server).map((chip) => (
        <span
          key={chip.key}
          className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${chip.className}`}
          data-testid={`directory-chip-${chip.key}`}
        >
          {chip.label}
        </span>
      ))}
      {showJoinMode && (
        <span className="text-[10px] text-vox-text-muted" data-testid="directory-join-mode">
          {server.joinMode === 'open' ? 'open join' : 'approval'}
        </span>
      )}
    </div>
  );
}
