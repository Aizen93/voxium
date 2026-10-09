import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Palette } from 'lucide-react';
import { useAnnotationStore } from '../../stores/annotationStore';
import { normalizeHexColor } from '../../utils/annotationPrefs';
import { ANNOTATION_COLORS } from './annotationPresets';

/**
 * "More colours": a portaled popover under its button with 16 presets, the
 * recently used colours, and a native picker. Every colour that leaves here
 * is '#rrggbb' — the only form the wire accepts.
 *
 * Portal rules (see CLAUDE.md): body-level, position: fixed, placed from the
 * button's bounding rect, re-placed on window resize only.
 */

export const PALETTE_PRESETS: readonly string[] = [
  '#ff3b30', '#ff9500', '#ffd60a', '#34c759', '#00c7be', '#0a84ff', '#5e5ce6', '#bf5af2',
  '#ff2d55', '#a2845e', '#8e8e93', '#ffffff', '#d1d1d6', '#636366', '#1c1c1e', '#111111',
];

export function ColorPalettePopover() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const customRef = useRef<HTMLInputElement>(null);
  const color = useAnnotationStore((s) => s.color);
  const recentColors = useAnnotationStore((s) => s.recentColors);
  const setColor = useAnnotationStore((s) => s.setColor);

  const place = () => {
    const r = buttonRef.current?.getBoundingClientRect();
    if (!r) return;
    // Measured when already rendered (place runs from a layout effect and
    // from resize while open); the estimate only covers the first paint
    const height = popoverRef.current?.offsetHeight || 240;
    setPos({
      left: Math.max(8, Math.min(window.innerWidth - 8 - 232, r.left)),
      // Below the button, unless a short window would push it off-screen
      top: Math.max(8, Math.min(window.innerHeight - 8 - height, r.bottom + 6)),
    });
  };

  useLayoutEffect(() => {
    if (open) place();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => place();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('resize', onResize);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (c: string) => {
    const normalized = normalizeHexColor(c);
    if (!normalized) return;
    // Recents are for colours the six quick swatches do not already offer
    setColor(normalized, { recent: !(ANNOTATION_COLORS as readonly string[]).includes(normalized) });
  };

  // The native picker fires `input` for every wheel drag tick: previewing the
  // default colour on each is fine, but applying it to a selected object on
  // each would ship an op and push a history entry per tick. The commit (the
  // native `change`, which React does not expose separately) applies it.
  useEffect(() => {
    const el = customRef.current;
    if (!open || !el) return;
    const onCommit = () => pick(el.value);
    el.addEventListener('change', onCommit);
    return () => el.removeEventListener('change', onCommit);
  }, [open]); // `pick` reads the latest store action on each call

  const swatch = (c: string, label: string) => (
    <button
      key={c}
      type="button"
      onClick={() => { pick(c); setOpen(false); }}
      className={`h-5 w-5 rounded-full border transition-transform ${color === c ? 'scale-110 border-white' : 'border-vox-border hover:scale-110'}`}
      style={{ backgroundColor: c }}
      title={c}
      aria-label={`${label} ${c}`}
      aria-pressed={color === c}
    />
  );

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`rounded p-1.5 transition-colors ${open ? 'bg-vox-accent-primary/20 text-vox-accent-primary' : 'text-vox-text-muted hover:bg-vox-bg-hover hover:text-vox-text-primary'}`}
        title={t('voice.annotations.moreColors')}
        aria-label={t('voice.annotations.moreColors')}
        aria-expanded={open}
        data-testid="palette-toggle"
      >
        <Palette size={15} />
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          data-testid="palette-popover"
          className="fixed z-50 w-[232px] rounded-lg border border-vox-border bg-vox-bg-floating p-3 shadow-xl"
          style={{ left: pos.left, top: pos.top }}
          role="dialog"
          aria-label={t('voice.annotations.moreColors')}
        >
          <div className="grid grid-cols-8 gap-1.5">
            {PALETTE_PRESETS.map((c) => swatch(c, t('voice.annotations.color')))}
          </div>
          {recentColors.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-vox-text-muted">{t('voice.annotations.recentColors')}</div>
              <div className="flex gap-1.5" data-testid="palette-recents">
                {recentColors.map((c) => swatch(c, t('voice.annotations.recentColors')))}
              </div>
            </div>
          )}
          <label className="mt-3 flex items-center gap-2 text-xs text-vox-text-secondary">
            <input
              ref={customRef}
              type="color"
              value={color}
              onChange={(e) => {
                const normalized = normalizeHexColor(e.target.value);
                if (normalized) setColor(normalized, { selection: false });
              }}
              className="h-6 w-8 cursor-pointer rounded border border-vox-border bg-transparent p-0"
              aria-label={t('voice.annotations.customColor')}
              data-testid="palette-custom"
            />
            {t('voice.annotations.customColor')}
          </label>
        </div>,
        document.body,
      )}
    </>
  );
}
