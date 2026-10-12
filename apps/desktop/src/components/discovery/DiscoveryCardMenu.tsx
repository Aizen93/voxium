import { useEffect, useRef, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';

/**
 * The "…" menu of a directory card: a list of actions, so a new one is one
 * more entry here rather than another button on the card. The list itself is
 * portaled to the body (the Explore grid scrolls and clips), anchored under
 * the button and right-aligned to it, repositioned on window resize only.
 * Closes on an outside press, on Escape, and after any choice.
 */

export interface DiscoveryCardMenuItem {
  key: string;
  label: string;
  icon?: ComponentType<{ size?: number; className?: string }>;
  /** Red: an action against the space (report, …). */
  danger?: boolean;
  onSelect: () => void;
  testid?: string;
}

interface Props {
  /** The accessible name of the button and the list ("More actions"). */
  label: string;
  items: DiscoveryCardMenuItem[];
}

export function DiscoveryCardMenu({ label, items }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = buttonRef.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    };
    place();
    const onPress = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    // Capture phase, and the event stops here: the Explore modal closes on
    // Escape too, and an open menu must take the key before it does.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('mousedown', onPress);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', onPress);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  // The first action takes focus once the list is placed
  useEffect(() => {
    if (open && pos) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open, pos]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        className={`shrink-0 rounded-md px-1.5 py-0.5 text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-secondary ${open ? 'bg-vox-bg-hover text-vox-text-secondary' : ''}`}
        data-testid="discovery-card-menu"
      >
        <MoreHorizontal size={14} />
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          className="fixed z-[10002] min-w-44 rounded-lg border border-vox-border bg-vox-bg-floating p-1.5 shadow-xl animate-fade-in"
          style={{ top: pos.top, right: pos.right }}
          data-testid="discovery-card-menu-list"
        >
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                onClick={() => { setOpen(false); item.onSelect(); }}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                  item.danger
                    ? 'text-vox-accent-danger hover:bg-vox-accent-danger/10'
                    : 'text-vox-text-secondary hover:bg-vox-bg-hover hover:text-vox-text-primary'
                }`}
                data-testid={item.testid}
              >
                {Icon && <Icon size={13} />}
                {item.label}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
