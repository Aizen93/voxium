import { AppShellMock } from '../common/AppShellMock';

/**
 * The landing hero's product window: the shared app-shell miniature
 * (`AppShellMock`) inside the landing bezel, with the browser-style title bar
 * the marketing shot has always had.
 *
 * The shell itself lives in AppShellMock so the theme editor's live preview and
 * this screenshot cannot drift apart — the mock a theme author judges their
 * colors on IS the mock a visitor sees on the landing page.
 */
export function HeroAppMock() {
  return (
    <div className="lp-frame">
      <div className="lp-frame-inner">
        {/* Title bar */}
        <div className="flex items-center gap-2 px-4 py-3 bg-vox-bg-secondary border-b border-vox-border">
          <div className="h-3 w-3 rounded-full bg-vox-accent-danger" />
          <div className="h-3 w-3 rounded-full bg-vox-accent-warning" />
          <div className="h-3 w-3 rounded-full bg-vox-accent-success" />
          <img src="/logo_static.svg" alt="" className="ml-2 h-4 w-4 rounded-sm" />
          <span className="text-xs text-vox-text-muted">Voxium</span>
        </div>

        <AppShellMock variant="hero" />
      </div>
    </div>
  );
}
