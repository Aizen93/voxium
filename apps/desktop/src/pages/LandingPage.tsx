import { useEffect, useState, useRef, useCallback, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Mic2,
  MessageSquare,
  Shield,
  Users,
  PhoneCall,
  Zap,
  Lock,
  Code2,
  HeartHandshake,
  CheckCircle2,
  ArrowRight,
  Server,
  BrainCircuit,
  Check,
  X,
  Menu,
  Heart,
  Sparkles,
  Palette,
  Globe,
  KeyRound,
} from 'lucide-react';
import { APP_VERSION } from '@voxium/shared';
import { SoundWaveCanvas } from '../components/landing/SoundWaveCanvas';
import { SUPPORTED_LANGUAGES } from '../i18n';

/* ─── Animated SVG Illustrations ─── */

/** Animated audio waveform bars */
function WaveformSvg({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 200 80"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <style>{`
        @keyframes bar1{0%,100%{height:16px;y:32px}50%{height:60px;y:10px}}
        @keyframes bar2{0%,100%{height:32px;y:24px}50%{height:70px;y:5px}}
        @keyframes bar3{0%,100%{height:24px;y:28px}50%{height:50px;y:15px}}
        @keyframes bar4{0%,100%{height:40px;y:20px}50%{height:72px;y:4px}}
        @keyframes bar5{0%,100%{height:20px;y:30px}50%{height:56px;y:12px}}
        .wb{rx:3;fill:url(#waveGrad)}
        .wb1{animation:bar1 1.2s ease-in-out infinite}
        .wb2{animation:bar2 1.4s ease-in-out 0.1s infinite}
        .wb3{animation:bar3 1.0s ease-in-out 0.2s infinite}
        .wb4{animation:bar4 1.3s ease-in-out 0.15s infinite}
        .wb5{animation:bar5 1.1s ease-in-out 0.25s infinite}
        .wb6{animation:bar2 1.5s ease-in-out 0.3s infinite}
        .wb7{animation:bar1 1.2s ease-in-out 0.35s infinite}
        .wb8{animation:bar3 1.4s ease-in-out 0.05s infinite}
        .wb9{animation:bar5 1.3s ease-in-out 0.2s infinite}
      `}</style>
      <defs>
        <linearGradient id="waveGrad" x1="0" y1="0" x2="0" y2="80" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#7C6BBF" />
          <stop offset="100%" stopColor="#4242B8" />
        </linearGradient>
      </defs>
      <rect x="10" y="32" width="8" height="16" className="wb wb1" />
      <rect x="26" y="24" width="8" height="32" className="wb wb2" />
      <rect x="42" y="28" width="8" height="24" className="wb wb3" />
      <rect x="58" y="20" width="8" height="40" className="wb wb4" />
      <rect x="74" y="30" width="8" height="20" className="wb wb5" />
      <rect x="90" y="24" width="8" height="32" className="wb wb6" />
      <rect x="106" y="32" width="8" height="16" className="wb wb7" />
      <rect x="122" y="28" width="8" height="24" className="wb wb8" />
      <rect x="138" y="20" width="8" height="40" className="wb wb4" />
      <rect x="154" y="30" width="8" height="20" className="wb wb9" />
      <rect x="170" y="24" width="8" height="32" className="wb wb2" />
      <rect x="186" y="28" width="8" height="24" className="wb wb3" />
    </svg>
  );
}

/** Orbit rings — decorative rotating rings */
function OrbitRingsSvg({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 400 400"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <style>{`
        @keyframes spin1{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
        @keyframes spin2{0%{transform:rotate(0deg)}100%{transform:rotate(-360deg)}}
        @keyframes orbPulse{0%,100%{opacity:0.3}50%{opacity:0.7}}
        .orb1{animation:spin1 20s linear infinite;transform-origin:200px 200px}
        .orb2{animation:spin2 28s linear infinite;transform-origin:200px 200px}
        .orb3{animation:spin1 35s linear infinite;transform-origin:200px 200px}
        .orb-dot{animation:orbPulse 2s ease-in-out infinite}
      `}</style>
      <defs>
        <linearGradient id="orbGrad" x1="100" y1="100" x2="300" y2="300" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#5B21B6" />
          <stop offset="100%" stopColor="#3B82F6" />
        </linearGradient>
      </defs>
      {/* Ring 1 */}
      <g className="orb1">
        <ellipse cx="200" cy="200" rx="140" ry="60" stroke="#5b5bf7" strokeWidth="1" opacity="0.2" transform="rotate(-20 200 200)" />
        <circle cx="340" cy="200" r="5" fill="#A78BFA" className="orb-dot" transform="rotate(-20 200 200)" />
      </g>
      {/* Ring 2 */}
      <g className="orb2">
        <ellipse cx="200" cy="200" rx="110" ry="45" stroke="#A78BFA" strokeWidth="1" opacity="0.15" transform="rotate(30 200 200)" />
        <circle cx="310" cy="200" r="4" fill="#60A5FA" className="orb-dot" transform="rotate(30 200 200)" />
      </g>
      {/* Ring 3 */}
      <g className="orb3">
        <ellipse cx="200" cy="200" rx="170" ry="70" stroke="#60A5FA" strokeWidth="1" opacity="0.12" transform="rotate(10 200 200)" />
        <circle cx="370" cy="200" r="3" fill="#5b5bf7" className="orb-dot" transform="rotate(10 200 200)" />
      </g>
      {/* Center glow */}
      <circle cx="200" cy="200" r="8" fill="url(#orbGrad)" opacity="0.6" />
    </svg>
  );
}

/** Floating particles that rise upward — section separator */
function ParticlesSvg({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 1200 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <style>{`
        @keyframes rise1{0%{transform:translateY(0);opacity:0}20%{opacity:0.6}80%{opacity:0.6}100%{transform:translateY(-40px);opacity:0}}
        @keyframes rise2{0%{transform:translateY(0);opacity:0}20%{opacity:0.4}80%{opacity:0.4}100%{transform:translateY(-30px);opacity:0}}
        .p1{animation:rise1 3s ease-in-out infinite}
        .p2{animation:rise2 4s ease-in-out 0.5s infinite}
        .p3{animation:rise1 3.5s ease-in-out 1s infinite}
        .p4{animation:rise2 4.5s ease-in-out 1.5s infinite}
        .p5{animation:rise1 3s ease-in-out 2s infinite}
        .p6{animation:rise2 3.8s ease-in-out 0.8s infinite}
        .p7{animation:rise1 4.2s ease-in-out 1.2s infinite}
        .p8{animation:rise2 3.2s ease-in-out 2.5s infinite}
      `}</style>
      <circle cx="100" cy="100" r="2" fill="#5b5bf7" className="p1" />
      <circle cx="250" cy="90" r="1.5" fill="#A78BFA" className="p2" />
      <circle cx="400" cy="105" r="2" fill="#60A5FA" className="p3" />
      <circle cx="550" cy="95" r="1.5" fill="#5b5bf7" className="p4" />
      <circle cx="700" cy="100" r="2" fill="#A78BFA" className="p5" />
      <circle cx="850" cy="88" r="1.5" fill="#60A5FA" className="p6" />
      <circle cx="1000" cy="98" r="2" fill="#5b5bf7" className="p7" />
      <circle cx="1100" cy="92" r="1.5" fill="#A78BFA" className="p8" />
    </svg>
  );
}

/** Animated shield with scanning line */
function ShieldSvg({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 120 140"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <style>{`
        @keyframes scanLine{0%{transform:translateY(-40px);opacity:0}20%{opacity:1}80%{opacity:1}100%{transform:translateY(50px);opacity:0}}
        @keyframes shieldGlow{0%,100%{filter:drop-shadow(0 0 4px rgba(91,91,247,0.3))}50%{filter:drop-shadow(0 0 12px rgba(91,91,247,0.6))}}
        .scan{animation:scanLine 2.5s ease-in-out infinite}
        .shield-body{animation:shieldGlow 3s ease-in-out infinite}
      `}</style>
      <defs>
        <linearGradient id="shieldGrad" x1="20" y1="10" x2="100" y2="130" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#5B21B6" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#3B82F6" stopOpacity="0.1" />
        </linearGradient>
        <clipPath id="shieldClip">
          <path d="M60 8 L108 30 L108 70 Q108 115 60 134 Q12 115 12 70 L12 30 Z" />
        </clipPath>
      </defs>
      <path className="shield-body" d="M60 8 L108 30 L108 70 Q108 115 60 134 Q12 115 12 70 L12 30 Z" fill="url(#shieldGrad)" stroke="#5b5bf7" strokeWidth="2" />
      <g clipPath="url(#shieldClip)">
        <rect x="0" y="60" width="120" height="2" fill="#5b5bf7" opacity="0.6" className="scan" />
      </g>
      <path d="M42 68 L54 80 L80 54" stroke="#3eba68" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ─── Download URLs ─── */

const DOWNLOAD_URLS = {
  windows: `https://github.com/Aizen93/voxium/releases/latest/download/Voxium_${APP_VERSION}_x64-setup.exe`,
  macos: `https://github.com/Aizen93/voxium/releases/latest/download/Voxium_${APP_VERSION}_aarch64.dmg`,
  linux: `https://github.com/Aizen93/voxium/releases/latest/download/Voxium_${APP_VERSION}_amd64.deb`,
  releases: 'https://github.com/Aizen93/voxium/releases',
};

/* ─── Landing Design System ───
 * Scoped `lp-*` classes: one continuous deep-indigo canvas with sections as
 * floating rounded panels. Applies only while the landing page is mounted. */

function LandingStyles() {
  return (
    <style>{`
      html.landing-scroll { scroll-padding-top: 5.5rem; }

      .lp-root { background: #0b0b1a; }

      /* Full-bleed section: hairline separator, content constrained inside.
         The 2026 layout is editorial (Linear/Arc), not boxed panels — sections
         span the page and their content uses the width. */
      .lp-section { position: relative; border-top: 1px solid rgba(255, 255, 255, 0.06); }

      /* Inner card: content tile inside a section */
      .lp-card {
        position: relative;
        border-radius: 20px;
        border: 1px solid rgba(148, 150, 255, 0.10);
        background: rgba(21, 22, 48, 0.55);
        transition: border-color 0.3s ease, transform 0.3s ease, box-shadow 0.3s ease, background-color 0.3s ease;
      }
      .lp-card:hover {
        border-color: rgba(139, 127, 255, 0.38);
        transform: translateY(-4px);
        box-shadow: 0 24px 56px -28px rgba(91, 91, 247, 0.4);
        background: rgba(24, 25, 54, 0.7);
      }
      .lp-card--static:hover { transform: none; }
      .lp-card--rose:hover {
        border-color: rgba(236, 72, 153, 0.35);
        box-shadow: 0 24px 56px -28px rgba(236, 72, 153, 0.35);
      }

      /* Product-window frame: padded bezel around app screenshots/mocks */
      .lp-frame {
        border-radius: 26px;
        padding: 10px;
        border: 1px solid rgba(148, 150, 255, 0.16);
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.075), rgba(255, 255, 255, 0.02));
        box-shadow: 0 60px 140px -40px rgba(91, 91, 247, 0.4), 0 30px 70px -35px rgba(0, 0, 0, 0.9);
      }
      .lp-frame-inner {
        border-radius: 17px;
        overflow: hidden;
        border: 1px solid rgba(148, 150, 255, 0.12);
        background: #12122b;
      }

      /* Floating pill navbar */
      .lp-nav {
        border-radius: 18px;
        border: 1px solid rgba(148, 150, 255, 0.12);
        background: rgba(12, 12, 28, 0.72);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        box-shadow: 0 16px 48px -24px rgba(0, 0, 0, 0.7);
      }

      /* Scroll reveal (transition-based, for headers/blocks) */
      .lp-reveal {
        opacity: 0;
        transform: translateY(28px);
        transition: opacity 0.9s cubic-bezier(0.22, 1, 0.36, 1), transform 0.9s cubic-bezier(0.22, 1, 0.36, 1);
        will-change: opacity, transform;
      }
      .lp-reveal.lp-in { opacity: 1; transform: none; }

      /* Staggered card entrance (animation-based so hover transforms stay instant) */
      .lp-card-hidden { opacity: 0; }
      .lp-card-in { animation: lpCardIn 0.7s cubic-bezier(0.22, 1, 0.36, 1) backwards; }
      @keyframes lpCardIn {
        from { opacity: 0; transform: translateY(32px); }
      }

      @media (prefers-reduced-motion: reduce) {
        .lp-reveal { transition: none; transform: none; opacity: 1; }
        .lp-card-in { animation: none; }
        .lp-card-hidden { opacity: 1; }
        .lp-card:hover { transform: none; }
      }
    `}</style>
  );
}

/** Reveals children with a smooth rise once scrolled into view */
function Reveal({ children, delay = 0, className = '' }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`lp-reveal ${inView ? 'lp-in' : ''} ${className}`}
      style={delay ? { transitionDelay: `${delay}s` } : undefined}
    >
      {children}
    </div>
  );
}

/* ─── Section Components ─── */

function Navbar() {
  const { t, i18n } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);

  const changeLanguage = (lang: string) => {
    i18n.changeLanguage(lang);
    localStorage.setItem('voxium_language', lang);
  };

  const languageOptions = SUPPORTED_LANGUAGES.map((lang) => (
    <option key={lang.code} value={lang.code} className="bg-vox-bg-primary text-vox-text-primary">
      {lang.nativeName}
    </option>
  ));

  return (
    <nav className="fixed top-3 sm:top-4 left-0 right-0 z-50 px-3 sm:px-6">
      <div className="lp-nav max-w-7xl mx-auto h-14 px-4 sm:px-5 flex items-center justify-between">
        <a href="#hero" className="flex items-center gap-2.5" onClick={() => setMenuOpen(false)}>
          <img src="/logo.svg" alt="Voxium" className="h-8 w-8 rounded-lg" />
          <span className="text-lg font-bold tracking-tight text-vox-text-primary">Voxium</span>
        </a>

        {/* Desktop controls */}
        <div className="hidden sm:flex items-center gap-3">
          <select
            value={i18n.language}
            onChange={(e) => changeLanguage(e.target.value)}
            className="bg-transparent border border-white/10 rounded-full px-2.5 py-1 text-xs text-vox-text-secondary focus:outline-none focus:border-vox-accent-primary cursor-pointer"
          >
            {languageOptions}
          </select>
          <Link to="/login" className="btn-ghost text-sm rounded-full">
            {t('landing.nav.signIn')}
          </Link>
          <Link to="/register" className="btn-primary text-sm rounded-full px-4 whitespace-nowrap">
            {t('landing.nav.getStarted')} <ArrowRight className="ml-1 h-4 w-4" />
          </Link>
        </div>

        {/* Mobile burger toggle */}
        <button
          type="button"
          className="sm:hidden flex items-center justify-center h-9 w-9 rounded-full border border-white/10 text-vox-text-primary hover:bg-white/[0.06] transition-colors"
          aria-label="Menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {/* Mobile menu panel */}
      {menuOpen && (
        <div className="lp-nav sm:hidden max-w-7xl mx-auto mt-2 p-3 flex flex-col gap-2 animate-fade-in">
          <select
            value={i18n.language}
            onChange={(e) => changeLanguage(e.target.value)}
            className="w-full bg-transparent border border-white/10 rounded-xl px-3 py-2.5 text-sm text-vox-text-secondary focus:outline-none focus:border-vox-accent-primary cursor-pointer"
          >
            {languageOptions}
          </select>
          <Link
            to="/login"
            className="btn-ghost text-sm rounded-xl w-full py-2.5"
            onClick={() => setMenuOpen(false)}
          >
            {t('landing.nav.signIn')}
          </Link>
          <Link
            to="/register"
            className="btn-primary text-sm rounded-xl w-full py-2.5"
            onClick={() => setMenuOpen(false)}
          >
            {t('landing.nav.getStarted')} <ArrowRight className="ml-1 h-4 w-4" />
          </Link>
        </div>
      )}
    </nav>
  );
}

function Hero() {
  const { t } = useTranslation();

  return (
    <section
      id="hero"
      className="relative min-h-screen flex items-center justify-center overflow-hidden"
    >
      {/* Background: solid fallback + WebGL sound waves */}
      <div className="absolute inset-0 bg-[#0b0b1a]" />
      <SoundWaveCanvas className="absolute inset-0 w-full h-full" />
      {/* Blend the hero into the page canvas below */}
      <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-b from-transparent to-[#0b0b1a]" />

      <div className="relative z-10 w-full max-w-7xl mx-auto px-6 lg:px-10 pt-32 pb-20">
        <div className="grid grid-cols-1 lg:grid-cols-2 items-center gap-14 xl:gap-20">
        {/* Copy column — left-aligned; the width belongs to the content now */}
        <div className="max-w-xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-[#8d8df2]/25 bg-[#5b5bf7]/10 px-3.5 py-1.5 text-[13px] font-medium text-[#b9b8f5] animate-fade-in">
            <Code2 className="h-3.5 w-3.5" />
            {t('landing.highlights.sourceAvailable')}
          </div>
          <h1 className="mt-6 text-4xl sm:text-5xl xl:text-[62px] font-bold tracking-tight text-vox-text-primary leading-[1.06] animate-fade-in">
            {t('landing.hero.headlinePart1')}{' '}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#8f7bff] via-[#5b5bf7] to-[#4a8df7]">
              {t('landing.hero.headlinePart2')}
            </span>
          </h1>
          <p
            className="mt-6 text-lg sm:text-xl text-vox-text-secondary animate-slide-up"
            style={{ animationDelay: '0.1s', animationFillMode: 'backwards' }}
          >
            {t('landing.hero.subtitle')}
          </p>

          {/* Primary action */}
          <div
            className="mt-8 flex flex-wrap items-center gap-3 animate-slide-up"
            style={{ animationDelay: '0.15s', animationFillMode: 'backwards' }}
          >
            <Link
              to="/register"
              className="btn-primary rounded-full px-7 py-3 text-base hover:scale-[1.03] active:scale-[0.98] transition-all duration-200"
            >
              {t('landing.nav.getStarted')} <ArrowRight className="ml-1.5 h-4 w-4" />
            </Link>
          </div>

          {/* Download buttons */}
          <div
            className="mt-4 flex flex-wrap gap-2.5 animate-slide-up"
            style={{ animationDelay: '0.2s', animationFillMode: 'backwards' }}
          >
            <a
              href={DOWNLOAD_URLS.windows}
              target="_blank"
              rel="noopener noreferrer"
              className="group relative btn rounded-full bg-white/[0.05] backdrop-blur-sm text-vox-text-primary border border-white/10 hover:border-[#0078D4]/50 hover:bg-[#0078D4]/15 hover:shadow-[0_0_24px_rgba(0,120,212,0.25)] hover:scale-[1.03] active:scale-[0.98] px-4 py-2 text-sm transition-all duration-200"
            >
              <svg className="mr-2 h-4 w-4 transition-transform duration-200 group-hover:-translate-y-0.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801"/>
              </svg>
              {t('landing.hero.downloadWindows')}
            </a>
            <a
              href={DOWNLOAD_URLS.macos}
              target="_blank"
              rel="noopener noreferrer"
              className="group relative btn rounded-full bg-white/[0.05] backdrop-blur-sm text-vox-text-primary border border-white/10 hover:border-[#A2AAAD]/50 hover:bg-[#A2AAAD]/15 hover:shadow-[0_0_24px_rgba(162,170,173,0.2)] hover:scale-[1.03] active:scale-[0.98] px-4 py-2 text-sm transition-all duration-200"
            >
              <svg className="mr-2 h-4 w-4 transition-transform duration-200 group-hover:-translate-y-0.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
              </svg>
              {t('landing.hero.downloadMac')}
            </a>
            <a
              href={DOWNLOAD_URLS.linux}
              target="_blank"
              rel="noopener noreferrer"
              className="group relative btn rounded-full bg-white/[0.05] backdrop-blur-sm text-vox-text-primary border border-white/10 hover:border-[#E95420]/50 hover:bg-[#E95420]/15 hover:shadow-[0_0_24px_rgba(233,84,32,0.2)] hover:scale-[1.03] active:scale-[0.98] px-4 py-2 text-sm transition-all duration-200"
            >
              <svg className="mr-2 h-4 w-4 transition-transform duration-200 group-hover:-translate-y-0.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M17.61.455a3.41 3.41 0 0 0-3.41 3.41 3.41 3.41 0 0 0 3.41 3.41 3.41 3.41 0 0 0 3.41-3.41 3.41 3.41 0 0 0-3.41-3.41zM12.92.8C8.923.777 5.137 2.941 3.148 6.451a4.5 4.5 0 0 1 .26-.007 4.92 4.92 0 0 1 2.585.737A8.316 8.316 0 0 1 12.688 3.6 4.944 4.944 0 0 1 13.723.834 11.008 11.008 0 0 0 12.92.8zm9.226 4.994a4.915 4.915 0 0 1-1.918 2.246 8.36 8.36 0 0 1-.273 8.303 4.89 4.89 0 0 1 1.632 2.54 11.156 11.156 0 0 0 .559-13.089zM3.41 7.932A3.41 3.41 0 0 0 0 11.342a3.41 3.41 0 0 0 3.41 3.409 3.41 3.41 0 0 0 3.41-3.41 3.41 3.41 0 0 0-3.41-3.41zm2.027 7.866a4.908 4.908 0 0 1-2.915.358 11.1 11.1 0 0 0 7.991 6.698 11.234 11.234 0 0 0 2.422.249 4.879 4.879 0 0 1-.999-2.85 8.484 8.484 0 0 1-.836-.136 8.304 8.304 0 0 1-5.663-4.32zm11.405.928a3.41 3.41 0 0 0-3.41 3.41 3.41 3.41 0 0 0 3.41 3.41 3.41 3.41 0 0 0 3.41-3.41 3.41 3.41 0 0 0-3.41-3.41z"/>
              </svg>
              {t('landing.hero.downloadLinux')}
            </a>
          </div>

          {/* Trust row */}
          <div
            className="mt-8 flex flex-wrap gap-x-5 gap-y-2 animate-slide-up"
            style={{ animationDelay: '0.25s', animationFillMode: 'backwards' }}
          >
            {[t('landing.highlights.noAds'), t('landing.highlights.selfHostable'), t('landing.highlights.freeForIndividuals')].map((h) => (
              <span key={h} className="flex items-center gap-1.5 text-sm text-vox-text-muted">
                <CheckCircle2 className="h-4 w-4 text-vox-accent-success shrink-0" />
                {h}
              </span>
            ))}
          </div>
        </div>

        {/* Animated Mock UI panel — the product window anchors the right column
            and bleeds toward the viewport edge, Arc-style (the section clips it) */}
        <div
          className="hidden md:block w-full animate-slide-up lg:scale-[1.06] lg:translate-x-6 xl:translate-x-10 origin-left"
          style={{ animationDelay: '0.3s', animationFillMode: 'backwards' }}
        >
          <style>{`
            @keyframes mockMsgIn {
              0% { opacity: 0; transform: translateY(12px); }
              100% { opacity: 1; transform: translateY(0); }
            }
            @keyframes mockReactionPop {
              0% { transform: scale(0); opacity: 0; }
              60% { transform: scale(1.3); }
              100% { transform: scale(1); opacity: 1; }
            }
            @keyframes mockTypingDot {
              0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
              30% { opacity: 1; transform: translateY(-3px); }
            }
            @keyframes mockCursorBlink {
              0%, 100% { opacity: 1; }
              50% { opacity: 0; }
            }
            @keyframes mockSpeakRing {
              0%, 100% { box-shadow: 0 0 0 0 rgba(62,186,104,0.5); }
              50% { box-shadow: 0 0 0 3px rgba(62,186,104,0); }
            }
            @keyframes mockOnlinePulse {
              0%, 100% { transform: scale(1); }
              50% { transform: scale(1.3); }
            }
            @keyframes mockChannelGlow {
              0%, 100% { background: #253356; }
              50% { background: #2a3a60; }
            }
            .mock-msg-1 { animation: mockMsgIn 0.4s ease-out 0.8s backwards; }
            .mock-msg-2 { animation: mockMsgIn 0.4s ease-out 1.8s backwards; }
            .mock-msg-3 { animation: mockMsgIn 0.4s ease-out 4s backwards; }
            .mock-reaction { animation: mockReactionPop 0.3s ease-out 3s backwards; }
            .mock-typing-dot { animation: mockTypingDot 1.2s ease-in-out infinite; }
            .mock-cursor { animation: mockCursorBlink 1s step-end infinite; }
            .mock-speak-ring { animation: mockSpeakRing 1.5s ease-in-out infinite; }
            .mock-speak-ring-d { animation: mockSpeakRing 1.5s ease-in-out 0.5s infinite; }
            .mock-online { animation: mockOnlinePulse 2s ease-in-out infinite; }
            .mock-online-d { animation: mockOnlinePulse 2s ease-in-out 1s infinite; }
            .mock-ch-active { animation: mockChannelGlow 3s ease-in-out infinite; }
          `}</style>
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
            {/* Fake layout */}
            <div className="flex" style={{ height: 340 }}>
              {/* Server sidebar */}
              <div className="w-14 bg-vox-sidebar border-r border-vox-border flex flex-col items-center py-3 gap-2">
                <img src="/logo_static.svg" alt="" className="h-10 w-10 rounded-2xl" />
                <div className="h-[1px] w-8 bg-vox-border" />
                <div className="h-10 w-10 rounded-2xl bg-vox-bg-tertiary" />
                <div className="h-10 w-10 rounded-2xl bg-vox-bg-tertiary" />
              </div>
              {/* Channels */}
              <div className="w-36 bg-vox-channel border-r border-vox-border p-3 flex flex-col">
                <div className="text-[10px] font-semibold text-vox-text-muted uppercase tracking-wide mb-1.5">Text</div>
                <div className="space-y-0.5">
                  <div className="text-xs text-vox-text-primary rounded px-2 py-1 mock-ch-active"># general</div>
                  <div className="text-xs text-vox-text-secondary px-2 py-1"># music</div>
                  <div className="text-xs text-vox-text-secondary px-2 py-1"># dev</div>
                </div>
                <div className="text-[10px] font-semibold text-vox-text-muted uppercase tracking-wide mt-3 mb-1.5">Voice</div>
                <div className="space-y-0.5">
                  <div className="text-xs text-vox-text-secondary px-2 py-1">Lounge</div>
                  {/* Voice users */}
                  <div className="flex items-center gap-1.5 px-3 py-0.5">
                    <div className="h-4 w-4 rounded-full bg-vox-accent-success shrink-0 mock-speak-ring" />
                    <span className="text-[10px] text-vox-accent-success">Alice</span>
                  </div>
                  <div className="flex items-center gap-1.5 px-3 py-0.5">
                    <div className="h-4 w-4 rounded-full bg-vox-accent-primary shrink-0 mock-speak-ring-d" />
                    <span className="text-[10px] text-vox-text-secondary">Bob</span>
                  </div>
                </div>
              </div>
              {/* Chat area */}
              <div className="flex-1 bg-vox-chat flex flex-col">
                {/* Messages */}
                <div className="flex-1 p-3 flex flex-col justify-end gap-2.5 overflow-hidden">
                  {/* Alice's message */}
                  <div className="mock-msg-1">
                    <div className="flex items-start gap-2">
                      <div className="relative shrink-0">
                        <div className="h-6 w-6 rounded-full bg-vox-accent-success" />
                        <div className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-vox-accent-success border-2 border-vox-chat mock-online" />
                      </div>
                      <div>
                        <span className="text-[10px] font-semibold text-vox-accent-success">Alice</span>
                        <span className="text-[9px] text-vox-text-muted ml-1.5">12:01</span>
                        <p className="text-xs text-vox-text-primary leading-snug">Hey, welcome to Voxium!</p>
                        {/* Reaction */}
                        <div className="mock-reaction mt-1 inline-flex items-center gap-0.5 rounded-full bg-vox-bg-tertiary/60 border border-vox-border px-1.5 py-0.5">
                          <span className="text-[10px]">👋</span>
                          <span className="text-[9px] text-vox-text-muted">2</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  {/* Bob's message */}
                  <div className="mock-msg-2">
                    <div className="flex items-start gap-2">
                      <div className="relative shrink-0">
                        <div className="h-6 w-6 rounded-full bg-vox-accent-primary" />
                        <div className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-vox-accent-success border-2 border-vox-chat mock-online-d" />
                      </div>
                      <div>
                        <span className="text-[10px] font-semibold text-vox-accent-primary">Bob</span>
                        <span className="text-[9px] text-vox-text-muted ml-1.5">12:02</span>
                        <p className="text-xs text-vox-text-primary leading-snug">Voice quality is insane 🔥</p>
                      </div>
                    </div>
                  </div>
                  {/* Charlie's message */}
                  <div className="mock-msg-3">
                    <div className="flex items-start gap-2">
                      <div className="relative shrink-0">
                        <div className="h-6 w-6 rounded-full bg-vox-accent-warning" />
                        <div className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-vox-accent-success border-2 border-vox-chat mock-online" />
                      </div>
                      <div>
                        <span className="text-[10px] font-semibold text-vox-accent-warning">Charlie</span>
                        <span className="text-[9px] text-vox-text-muted ml-1.5">12:03</span>
                        <p className="text-xs text-vox-text-primary leading-snug">Noise suppression is magic 🚀</p>
                      </div>
                    </div>
                  </div>
                  {/* Typing indicator */}
                  <div className="flex items-center gap-1.5 px-1 h-4">
                    <div className="flex gap-0.5">
                      <div className="h-1.5 w-1.5 rounded-full bg-vox-text-muted mock-typing-dot" />
                      <div className="h-1.5 w-1.5 rounded-full bg-vox-text-muted mock-typing-dot" style={{ animationDelay: '0.15s' }} />
                      <div className="h-1.5 w-1.5 rounded-full bg-vox-text-muted mock-typing-dot" style={{ animationDelay: '0.3s' }} />
                    </div>
                    <span className="text-[9px] text-vox-text-muted">Alice is typing...</span>
                  </div>
                </div>
                {/* Message input */}
                <div className="px-3 pb-2.5">
                  <div className="flex items-center rounded-md bg-vox-bg-floating border border-vox-border px-2.5 py-1.5">
                    <span className="text-[10px] text-vox-text-muted">Message #general</span>
                    <div className="ml-0.5 w-[1px] h-3 bg-vox-text-muted mock-cursor" />
                  </div>
                </div>
              </div>
            </div>
            </div>
          </div>
        </div>
        </div>
      </div>
    </section>
  );
}

/* ─── Animated Counter Hook ─── */

function useCountUp(target: number, duration = 1500): number {
  const [value, setValue] = useState(0);
  const rafRef = useRef(0);
  const prevRef = useRef(0);

  useEffect(() => {
    const from = prevRef.current;
    prevRef.current = target;

    if (target === from) return;

    const start = performance.now();
    const animate = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(from + eased * (target - from)));
      if (progress < 1) rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);

  return value;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/* ─── Stats Section ─── */

function StatsSection() {
  const { t } = useTranslation();
  const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001/api/v1';
  const [stats, setStats] = useState<{ users: number; servers: number; messages: number } | null>(null);
  const [visible, setVisible] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/stats`);
      if (res.ok) {
        const json = await res.json();
        setStats(json.data);
      }
    } catch {
      // silently ignore — stats are non-critical
    }
  }, [API_BASE]);

  // Fetch on mount + poll every 30s
  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 30_000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  // Intersection observer for count-up trigger
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setVisible(true); },
      { threshold: 0.3 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const usersCount = useCountUp(visible && stats ? stats.users : 0);
  const serversCount = useCountUp(visible && stats ? stats.servers : 0);
  const messagesCount = useCountUp(visible && stats ? stats.messages : 0);

  const cards = [
    { icon: Users, label: t('landing.stats.users'), value: usersCount },
    { icon: Server, label: t('landing.stats.servers'), value: serversCount },
    { icon: MessageSquare, label: t('landing.stats.messages'), value: messagesCount },
  ];

  return (
    <section ref={sectionRef} className="relative border-y border-white/[0.06] bg-white/[0.015]">
      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-[minmax(280px,1fr)_2fr] items-center gap-10 px-6 lg:px-10 py-12">
        <div>
          <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight text-vox-text-primary">
            {t('landing.stats.title')}
          </h2>
          <p className="mt-2 text-sm text-vox-text-secondary max-w-xs">
            {t('landing.stats.subtitle')}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-white/[0.06]">
          {cards.map((card) => (
            <div key={card.label} className="px-0 py-5 sm:px-8 sm:py-2 first:sm:pl-0">
              <div className="text-3xl sm:text-4xl font-bold tracking-tight text-vox-text-primary mb-1.5 tabular-nums">
                {stats ? formatNumber(card.value) : '—'}
              </div>
              <div className="flex items-center gap-1.5 text-sm text-vox-text-secondary">
                <card.icon className="h-4 w-4 text-[#8f8aff]" />
                {card.label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Features() {
  const { t, i18n } = useTranslation();
  const sectionRef = useRef<HTMLDivElement>(null);
  const [visibleCards, setVisibleCards] = useState<Set<number>>(new Set());

  const features = [
    { icon: Mic2, title: t('landing.features.voice'), description: t('landing.features.voiceDesc') },
    { icon: BrainCircuit, title: t('landing.features.noiseSuppression'), description: t('landing.features.noiseSuppressionDesc') },
    { icon: MessageSquare, title: t('landing.features.messaging'), description: t('landing.features.messagingDesc') },
    { icon: Shield, title: t('landing.features.privacy'), description: t('landing.features.privacyDesc') },
    { icon: Users, title: t('landing.features.servers'), description: t('landing.features.serversDesc') },
    { icon: PhoneCall, title: t('landing.features.calls'), description: t('landing.features.callsDesc') },
    { icon: Zap, title: t('landing.features.fast'), description: t('landing.features.fastDesc') },
  ];

  const currentLang = i18n.language;

  useEffect(() => {
    setVisibleCards(new Set());

    const el = sectionRef.current;
    if (!el) return;

    // Defer observer setup to next frame so React has time to render the new cards
    const raf = requestAnimationFrame(() => {
      const cards = el.querySelectorAll('[data-feature-card]');
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              const idx = Number((entry.target as HTMLElement).dataset.featureCard);
              setVisibleCards((prev) => new Set(prev).add(idx));
              observer.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.15 },
      );
      cards.forEach((card) => observer.observe(card));
      // Store observer for cleanup
      (el as HTMLElement & { _obs?: IntersectionObserver })._obs = observer;
    });

    return () => {
      cancelAnimationFrame(raf);
      const obs = (el as HTMLElement & { _obs?: IntersectionObserver })._obs;
      if (obs) obs.disconnect();
    };
  }, [currentLang]);

  // Bento spans: rows of 4+2 / 2+2+2 / 3+3 on lg, pairs on md
  const spans = [
    'md:col-span-2 lg:col-span-4',
    'lg:col-span-2',
    'lg:col-span-2',
    'lg:col-span-2',
    'lg:col-span-2',
    'lg:col-span-3',
    'md:col-span-2 lg:col-span-3',
  ];

  return (
    <section className="relative">
      {/* Particle separator at top */}
      <ParticlesSvg className="absolute top-0 left-0 w-full h-16" />
      <div ref={sectionRef} className="max-w-7xl mx-auto px-6 lg:px-10 py-20 sm:py-24">
        <Reveal>
          <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight text-vox-text-primary mb-4">
            {t('landing.features.title')}
          </h2>
          <p className="text-vox-text-secondary mb-14 max-w-2xl">
            {t('landing.features.subtitle')}
          </p>
        </Reveal>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4">
          {features.map((f, i) => (
            <div
              key={i}
              data-feature-card={i}
              className={`group lp-card p-6 cursor-default overflow-hidden ${spans[i]}
                ${visibleCards.has(i) ? 'lp-card-in' : 'lp-card-hidden'}`}
              style={{ animationDelay: `${i * 0.08}s` }}
            >
              {i === 0 && (
                <WaveformSvg className="absolute right-8 top-1/2 -translate-y-1/2 h-16 w-64 opacity-20 hidden lg:block" />
              )}
              <div className="relative h-12 w-12 rounded-xl bg-gradient-to-br from-[#5b5bf7]/15 to-[#4a8df7]/15 border border-white/[0.06] flex items-center justify-center mb-4 group-hover:from-[#5b5bf7]/30 group-hover:to-[#4a8df7]/30 group-hover:scale-110 transition-all duration-300">
                <f.icon className="h-6 w-6 text-vox-accent-primary group-hover:scale-110 transition-transform duration-300" />
              </div>
              <h3 className="relative text-lg font-semibold text-vox-text-primary mb-2 group-hover:text-vox-accent-primary transition-colors duration-300">
                {f.title}
              </h3>
              <p className="relative text-sm text-vox-text-secondary leading-relaxed">
                {f.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─── Interactive Showcase ─── */

const SHOWCASE_THEMES = [
  { id: 'dark',     label: 'Dark',     bg: '#1a1b2e', sidebar: '#151627', chat: '#1e1f36', text: '#e2e2e8', muted: '#7a7a8e', accent: '#5b5bf7', border: '#2a2b42' },
  { id: 'light',    label: 'Light',    bg: '#f5f5f7', sidebar: '#e8e8ed', chat: '#ffffff', text: '#1a1a1a', muted: '#6e6e7a', accent: '#4f46e5', border: '#d4d4d8' },
  { id: 'midnight', label: 'Midnight', bg: '#0d1117', sidebar: '#0a0e14', chat: '#111820', text: '#c9d1d9', muted: '#6b7b8d', accent: '#58a6ff', border: '#1c2632' },
  { id: 'tactical', label: 'Tactical', bg: '#1a1f16', sidebar: '#151a12', chat: '#1e2419', text: '#d4d4c8', muted: '#8a8a78', accent: '#84cc16', border: '#2a3024' },
] as const;

const GREETINGS = [
  { text: 'Welcome to Voxium',              lang: 'English',    code: 'en' },
  { text: 'Bienvenue sur Voxium',           lang: 'Fran\u00e7ais',   code: 'fr' },
  { text: 'Bienvenido a Voxium',            lang: 'Espa\u00f1ol',    code: 'es' },
  { text: 'Bem-vindo ao Voxium',            lang: 'Portugu\u00eas',  code: 'pt' },
  { text: 'Willkommen bei Voxium',          lang: 'Deutsch',    code: 'de' },
  { text: '\u0414\u043e\u0431\u0440\u043e \u043f\u043e\u0436\u0430\u043b\u043e\u0432\u0430\u0442\u044c \u0432 Voxium',  lang: '\u0420\u0443\u0441\u0441\u043a\u0438\u0439',    code: 'ru' },
  { text: '\u041b\u0430\u0441\u043a\u0430\u0432\u043e \u043f\u0440\u043e\u0441\u0438\u043c\u043e \u0434\u043e Voxium',  lang: '\u0423\u043a\u0440\u0430\u0457\u043d\u0441\u044c\u043a\u0430', code: 'uk' },
  { text: 'Voxium\uc5d0 \uc624\uc2e0 \uac83\uc744 \ud658\uc601\ud569\ub2c8\ub2e4',       lang: '\ud55c\uad6d\uc5b4',     code: 'ko' },
  { text: '\u6b22\u8fce\u6765\u5230 Voxium',               lang: '\u4e2d\u6587',       code: 'zh' },
  { text: 'Voxium\u3078\u3088\u3046\u3053\u305d',                lang: '\u65e5\u672c\u8a9e',     code: 'ja' },
  { text: '\u0645\u0631\u062d\u0628\u064b\u0627 \u0628\u0643 \u0641\u064a Voxium',           lang: '\u0627\u0644\u0639\u0631\u0628\u064a\u0629',    code: 'ar' },
];

const PERM_ROLES = [
  { name: 'Admin',     color: '#eab308', active: [0, 1, 2, 3, 4, 5] },
  { name: 'Moderator', color: '#3b82f6', active: [0, 1, 2, 3] },
  { name: 'Member',    color: '#22c55e', active: [0, 1] },
];
const PERM_LABELS = ['View', 'Send', 'React', 'Manage', 'Kick', 'Admin'];

function ThemeSwitcherCard() {
  const { t: tr } = useTranslation();
  const [active, setActive] = useState(0);
  const t = SHOWCASE_THEMES[active];

  return (
    <div className="flex flex-col h-full">
      {/* Mini mock UI */}
      <div
        className="rounded-xl border overflow-hidden flex-1 flex flex-col"
        style={{ borderColor: t.border, background: t.bg, transition: 'all 0.4s ease' }}
      >
        {/* Title bar */}
        <div className="flex items-center gap-1.5 px-3 py-2" style={{ background: t.sidebar, borderBottom: `1px solid ${t.border}`, transition: 'all 0.4s ease' }}>
          <div className="h-2 w-2 rounded-full bg-red-400/70" />
          <div className="h-2 w-2 rounded-full bg-yellow-400/70" />
          <div className="h-2 w-2 rounded-full bg-green-400/70" />
          <span className="ml-1.5 text-[9px] font-medium" style={{ color: t.muted, transition: 'color 0.4s ease' }}>Voxium</span>
        </div>
        <div className="flex flex-1 min-h-0">
          {/* Mini sidebar */}
          <div className="w-10 flex flex-col items-center py-2 gap-1.5" style={{ background: t.sidebar, borderRight: `1px solid ${t.border}`, transition: 'all 0.4s ease' }}>
            <div className="h-6 w-6 rounded-lg" style={{ background: t.accent, opacity: 0.8, transition: 'background 0.4s ease' }} />
            <div className="h-[1px] w-5" style={{ background: t.border, transition: 'background 0.4s ease' }} />
            <div className="h-6 w-6 rounded-lg" style={{ background: t.border, transition: 'background 0.4s ease' }} />
          </div>
          {/* Chat */}
          <div className="flex-1 flex flex-col p-2.5 gap-2 justify-end" style={{ background: t.chat, transition: 'background 0.4s ease' }}>
            {['Alice', 'Bob', 'You'].map((name, i) => (
              <div key={name} className="flex items-start gap-1.5">
                <div className="h-4 w-4 rounded-full shrink-0" style={{ background: i === 0 ? '#3eba68' : i === 1 ? t.accent : '#e67e22', transition: 'background 0.4s ease' }} />
                <div>
                  <span className="text-[8px] font-semibold" style={{ color: i === 0 ? '#3eba68' : i === 1 ? t.accent : '#e67e22', transition: 'color 0.4s ease' }}>{name}</span>
                  <p className="text-[9px] leading-tight" style={{ color: t.text, transition: 'color 0.4s ease' }}>
                    {i === 0 ? 'Hey, try the new theme!' : i === 1 ? 'Looking clean' : 'Love it'}
                  </p>
                </div>
              </div>
            ))}
            <div className="rounded-md px-2 py-1 mt-0.5" style={{ background: t.sidebar, border: `1px solid ${t.border}`, transition: 'all 0.4s ease' }}>
              <span className="text-[8px]" style={{ color: t.muted, transition: 'color 0.4s ease' }}>Message #general</span>
            </div>
          </div>
        </div>
      </div>

      {/* Theme palette buttons */}
      <div className="flex items-center justify-center gap-2.5 mt-4">
        {SHOWCASE_THEMES.map((theme, i) => (
          <button
            key={theme.id}
            onClick={() => setActive(i)}
            aria-label={`${theme.label} theme`}
            className="group relative flex items-center gap-1 rounded-full px-2.5 py-1 border transition-all duration-300"
            style={{
              borderColor: active === i ? theme.accent : 'transparent',
              background: active === i ? `${theme.accent}15` : 'transparent',
            }}
          >
            <div
              className="h-3.5 w-3.5 rounded-full ring-1 ring-white/10 transition-transform duration-200 group-hover:scale-125"
              style={{ background: `linear-gradient(135deg, ${theme.sidebar}, ${theme.accent})` }}
            />
            <span className="text-[10px] font-medium text-vox-text-secondary group-hover:text-vox-text-primary transition-colors">
              {theme.label}
            </span>
          </button>
        ))}
      </div>

      <p className="text-center text-xs text-vox-text-muted mt-3 flex items-center justify-center gap-1.5">
        <Palette size={12} className="text-vox-accent-primary" />
        {tr('landing.showcase.themeLabel')}
      </p>
    </div>
  );
}

function LanguageCarousel() {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const [displayText, setDisplayText] = useState('');
  const [phase, setPhase] = useState<'typing' | 'hold' | 'deleting'>('typing');
  const intervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const greeting = GREETINGS[index].text;

    if (phase === 'typing') {
      if (displayText.length < greeting.length) {
        intervalRef.current = setTimeout(() => {
          setDisplayText(greeting.slice(0, displayText.length + 1));
        }, 35);
      } else {
        intervalRef.current = setTimeout(() => setPhase('hold'), 2000);
      }
    } else if (phase === 'hold') {
      setPhase('deleting');
    } else if (phase === 'deleting') {
      if (displayText.length > 0) {
        intervalRef.current = setTimeout(() => {
          setDisplayText(displayText.slice(0, -1));
        }, 15);
      } else {
        setIndex((i) => (i + 1) % GREETINGS.length);
        setPhase('typing');
      }
    }

    return () => { if (intervalRef.current) clearTimeout(intervalRef.current); };
  }, [displayText, phase, index]);

  const g = GREETINGS[index];

  return (
    <div className="flex flex-col items-center h-full">
      <style>{`
        @keyframes globeSpin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
        @keyframes globePulse{0%,100%{opacity:0.06}50%{opacity:0.12}}
        .globe-ring{animation:globeSpin 30s linear infinite;transform-origin:center}
        .globe-ring-r{animation:globeSpin 45s linear infinite reverse;transform-origin:center}
        .globe-pulse{animation:globePulse 4s ease-in-out infinite}
      `}</style>

      {/* Globe wireframe background */}
      <div className="relative flex-1 flex items-center justify-center w-full">
        <svg className="absolute w-48 h-48 opacity-40" viewBox="0 0 200 200" fill="none" aria-hidden="true">
          <circle cx="100" cy="100" r="80" stroke="#5b5bf7" strokeWidth="0.5" opacity="0.2" className="globe-pulse" />
          <ellipse cx="100" cy="100" rx="80" ry="30" stroke="#5b5bf7" strokeWidth="0.5" opacity="0.15" className="globe-ring" />
          <ellipse cx="100" cy="100" rx="80" ry="55" stroke="#A78BFA" strokeWidth="0.5" opacity="0.1" className="globe-ring-r" transform="rotate(60 100 100)" />
          <ellipse cx="100" cy="100" rx="80" ry="40" stroke="#60A5FA" strokeWidth="0.5" opacity="0.12" className="globe-ring" transform="rotate(-30 100 100)" />
          {/* Meridians */}
          <ellipse cx="100" cy="100" rx="30" ry="80" stroke="#5b5bf7" strokeWidth="0.5" opacity="0.1" />
          <ellipse cx="100" cy="100" rx="55" ry="80" stroke="#A78BFA" strokeWidth="0.5" opacity="0.08" />
          <line x1="20" y1="100" x2="180" y2="100" stroke="#5b5bf7" strokeWidth="0.5" opacity="0.1" />
        </svg>

        {/* Greeting text */}
        <div className="relative z-10 text-center px-4">
          <div className="h-16 flex items-center justify-center">
            <span
              className="text-xl sm:text-2xl font-bold text-vox-text-primary"
              style={{ direction: g.code === 'ar' ? 'rtl' : 'ltr' }}
            >
              {displayText}
              <span className="inline-block w-[2px] h-5 bg-vox-accent-primary ml-0.5 align-middle" style={{ animation: 'mockCursorBlink 1s step-end infinite' }} />
            </span>
          </div>

          {/* Language name badge */}
          <div
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-vox-accent-primary/10 border border-vox-accent-primary/20 mt-2"
            key={g.code}
            style={{ animation: 'fade-in 0.3s ease-out' }}
          >
            <span className="text-xs font-medium text-vox-accent-primary">{g.lang}</span>
          </div>

          {/* Progress dots */}
          <div className="flex items-center justify-center gap-1 mt-4">
            {GREETINGS.map((_, i) => (
              <div
                key={i}
                className="h-1 rounded-full transition-all duration-300"
                style={{
                  width: i === index ? 16 : 4,
                  background: i === index ? '#5b5bf7' : '#5b5bf730',
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <p className="text-center text-xs text-vox-text-muted mt-4 flex items-center justify-center gap-1.5">
        <Globe size={12} className="text-vox-accent-primary" />
        {t('landing.showcase.languageLabel')}
      </p>
    </div>
  );
}

function PermissionVisualizer() {
  const { t } = useTranslation();
  const [hoveredRole, setHoveredRole] = useState<number | null>(null);

  return (
    <div className="flex flex-col h-full">
      <style>{`
        @keyframes permGlow{0%{transform:scale(1);filter:brightness(1)}50%{transform:scale(1.3);filter:brightness(1.4)}100%{transform:scale(1);filter:brightness(1)}}
      `}</style>

      {/* Permission header */}
      <div className="flex items-center gap-2 px-3 py-2 rounded-t-xl bg-vox-bg-tertiary/50 border-b border-vox-border">
        <KeyRound size={12} className="text-vox-accent-primary" />
        <span className="text-[10px] font-semibold text-vox-text-muted uppercase tracking-wider">{t('landing.showcase.permissionMatrix')}</span>
      </div>

      {/* Column labels */}
      <div className="flex items-center px-3 pt-3 pb-1">
        <div className="w-24" />
        {PERM_LABELS.map((label) => (
          <div key={label} className="flex-1 text-center">
            <span className="text-[9px] text-vox-text-muted font-medium">{label}</span>
          </div>
        ))}
      </div>

      {/* Role rows */}
      <div className="flex-1 flex flex-col justify-center gap-2 px-3 py-3">
        {PERM_ROLES.map((role, ri) => {
          const isHovered = hoveredRole === ri;
          return (
            <div
              key={role.name}
              className="flex items-center rounded-lg px-2 py-2.5 cursor-default transition-all duration-300"
              style={{
                background: isHovered ? `${role.color}10` : 'transparent',
                borderLeft: isHovered ? `2px solid ${role.color}` : '2px solid transparent',
              }}
              onMouseEnter={() => setHoveredRole(ri)}
              onMouseLeave={() => setHoveredRole(null)}
            >
              {/* Role name */}
              <div className="w-22 flex items-center gap-1.5">
                <div
                  className="h-2.5 w-2.5 rounded-full transition-all duration-300"
                  style={{
                    background: role.color,
                    boxShadow: isHovered ? `0 0 8px ${role.color}80` : 'none',
                  }}
                />
                <span
                  className="text-[11px] font-semibold transition-colors duration-300"
                  style={{ color: isHovered ? role.color : '#9ca3af' }}
                >
                  {role.name}
                </span>
              </div>

              {/* Permission dots */}
              <div className="flex-1 flex">
                {PERM_LABELS.map((_, pi) => {
                  const isActive = role.active.includes(pi);
                  const isLit = isHovered && isActive;
                  return (
                    <div key={pi} className="flex-1 flex justify-center">
                      <div
                        className="h-3 w-3 rounded-full transition-all duration-300"
                        style={{
                          background: isLit ? role.color : isActive ? `${role.color}30` : '#ffffff08',
                          boxShadow: isLit ? `0 0 10px ${role.color}90, 0 0 20px ${role.color}40` : 'none',
                          transform: isLit ? 'scale(1.4)' : 'scale(1)',
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Resolution hint */}
      <div className="px-3 pb-3">
        <div className="text-[9px] text-vox-text-muted text-center py-1.5 rounded-md bg-vox-bg-tertiary/30 border border-vox-border/50">
          {t('landing.showcase.permissionHint')}
        </div>
      </div>

      <p className="text-center text-xs text-vox-text-muted mt-auto pt-2 flex items-center justify-center gap-1.5">
        <Shield size={12} className="text-vox-accent-primary" />
        {t('landing.showcase.permissionLabel')}
      </p>
    </div>
  );
}

function Showcase() {
  const { t } = useTranslation();
  const sectionRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setVisible(true); },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <section ref={sectionRef} className="lp-section">
      {/* Subtle radial backdrop */}
      <div
        className="absolute inset-0 opacity-8"
        style={{ background: 'radial-gradient(ellipse at 30% 50%, #5b5bf720 0%, transparent 60%), radial-gradient(ellipse at 70% 50%, #3B82F615 0%, transparent 60%)' }}
      />
      <div className="max-w-7xl mx-auto px-6 lg:px-10 py-20 sm:py-24">
        <div className="relative z-10">
          {/* Section header */}
          <div className={`mb-14 lp-reveal ${visible ? 'lp-in' : ''}`}>
            <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight text-vox-text-primary mb-4">
              {t('landing.showcase.title')} <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#8f7bff] via-[#5b5bf7] to-[#4a8df7]">{t('landing.showcase.titleHighlight')}</span>
            </h2>
            <p className="text-vox-text-secondary max-w-xl">
              {t('landing.showcase.subtitle')}
            </p>
          </div>

          {/* Three showcase cards */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {[ThemeSwitcherCard, LanguageCarousel, PermissionVisualizer].map((Component, i) => (
              <div
                key={i}
                className={`lp-card lp-card--static p-5 min-h-[380px] ${visible ? 'lp-card-in' : 'lp-card-hidden'}`}
                style={{ animationDelay: `${0.15 + i * 0.12}s` }}
              >
                <Component />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─── Comparison Table ─── */

type CellValue = true | false | string;

function ComparisonCell({ value }: { value: CellValue }) {
  if (value === true) return <Check className="h-5 w-5 text-vox-accent-success mx-auto" />;
  if (value === false) return <X className="h-5 w-5 text-vox-text-muted/40 mx-auto" />;
  return <span className="text-xs text-vox-text-secondary">{value}</span>;
}

function ComparisonTable() {
  const { t } = useTranslation();

  const comparisonData: { feature: string; voxium: CellValue; discord: CellValue; teamspeak: CellValue; matrix: CellValue }[] = [
    { feature: t('landing.comparison.sourceAvailable'),   voxium: true,                discord: false,          teamspeak: false,          matrix: true },
    { feature: t('landing.comparison.selfHostable'),      voxium: true,                discord: false,          teamspeak: true,           matrix: true },
    { feature: t('landing.comparison.freeVoiceChat'),     voxium: true,                discord: true,           teamspeak: true,           matrix: true },
    { feature: t('landing.comparison.sfuVoice'),          voxium: true,                discord: true,           teamspeak: true,           matrix: t('landing.comparison.viaJitsi') },
    { feature: t('landing.comparison.dmVoiceCalls'),      voxium: true,                discord: true,           teamspeak: false,          matrix: true },
    { feature: t('landing.comparison.noiseSuppression'),  voxium: 'RNNoise ML',        discord: 'Krisp',        teamspeak: t('landing.comparison.basic'), matrix: false },
    { feature: t('landing.comparison.screenSharing'),     voxium: true,                discord: true,           teamspeak: false,          matrix: t('landing.comparison.viaJitsi') },
    { feature: t('landing.comparison.messageReactions'),  voxium: true,                discord: true,           teamspeak: false,          matrix: true },
    { feature: t('landing.comparison.fileSharing'),       voxium: true,                discord: true,           teamspeak: true,           matrix: true },
    { feature: t('landing.comparison.customThemes'),       voxium: true,                discord: false,          teamspeak: t('landing.comparison.ts3Addons'), matrix: t('landing.comparison.jsonThemes') },
    { feature: t('landing.comparison.rolePermissions'),   voxium: true,                discord: true,           teamspeak: true,           matrix: t('landing.comparison.powerLevels') },
    { feature: t('landing.comparison.noAdsTracking'),     voxium: true,                discord: false,          teamspeak: true,           matrix: true },
    { feature: t('landing.comparison.desktopApp'),        voxium: true,                discord: true,           teamspeak: true,           matrix: true },
    { feature: t('landing.comparison.lightweightClient'), voxium: 'Tauri (~10MB)',      discord: 'Electron',     teamspeak: 'Native',       matrix: 'Electron' },
    { feature: t('landing.comparison.encryption'),        voxium: 'E2E (Olm/Megolm)',  discord: 'TLS',          teamspeak: 'AES',          matrix: 'E2E (Olm)' },
    { feature: t('landing.comparison.encryptedChannels'), voxium: true,                discord: false,          teamspeak: false,          matrix: true },
    { feature: t('landing.comparison.customBots'),        voxium: t('landing.comparison.planned'), discord: true, teamspeak: 'Plugins + SDK', matrix: true },
    { feature: t('landing.comparison.mobileApp'),         voxium: t('landing.comparison.planned'), discord: true, teamspeak: true,           matrix: true },
  ];

  return (
    <section className="lp-section">
      <div className="max-w-7xl mx-auto px-6 lg:px-10 py-20 sm:py-24">
        <Reveal>
          <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight text-vox-text-primary mb-4">
            {t('landing.comparison.title')}
          </h2>
          <p className="text-vox-text-secondary mb-12 max-w-2xl">
            {t('landing.comparison.subtitle')}
          </p>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="overflow-x-auto rounded-2xl border border-white/[0.08] bg-[#0d0d20]/60">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-white/[0.03]">
                  <th className="text-left px-5 py-4 text-vox-text-primary font-semibold min-w-[180px]">{t('landing.comparison.feature')}</th>
                  <th className="px-5 py-4 text-center min-w-[110px] bg-[#5b5bf7]/[0.08]">
                    <span className="font-bold text-vox-accent-primary">Voxium</span>
                  </th>
                  <th className="px-5 py-4 text-center text-vox-text-secondary font-medium min-w-[110px]">Discord</th>
                  <th className="px-5 py-4 text-center text-vox-text-secondary font-medium min-w-[110px]">TeamSpeak</th>
                  <th className="px-5 py-4 text-center text-vox-text-secondary font-medium min-w-[110px]">Matrix</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {comparisonData.map((row) => (
                  <tr key={row.feature} className="hover:bg-white/[0.025] transition-colors">
                    <td className="px-5 py-3.5 text-vox-text-primary font-medium">{row.feature}</td>
                    <td className="px-5 py-3.5 text-center bg-[#5b5bf7]/[0.05]">{<ComparisonCell value={row.voxium} />}</td>
                    <td className="px-5 py-3.5 text-center">{<ComparisonCell value={row.discord} />}</td>
                    <td className="px-5 py-3.5 text-center">{<ComparisonCell value={row.teamspeak} />}</td>
                    <td className="px-5 py-3.5 text-center">{<ComparisonCell value={row.matrix} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>

        <p className="text-xs text-vox-text-muted mt-6">
          {t('landing.comparison.footnote')}
        </p>
      </div>
    </section>
  );
}

function WhyVoxium() {
  const { t } = useTranslation();

  const highlights = [
    t('landing.highlights.noAds'),
    t('landing.highlights.sourceAvailable'),
    t('landing.highlights.e2eEncrypted'),
    t('landing.highlights.freeForIndividuals'),
    t('landing.highlights.noiseSuppression'),
    t('landing.highlights.selfHostable'),
    t('landing.highlights.sfuVoice'),
  ];

  return (
    <section className="lp-section overflow-hidden">
      {/* Decorative orbit rings — clipped by the section bounds */}
      <OrbitRingsSvg className="absolute -right-24 top-1/2 -translate-y-1/2 w-[500px] h-[500px] opacity-40 hidden lg:block" />

      <div className="relative z-10 max-w-7xl mx-auto px-6 lg:px-10 py-20 sm:py-24">
        <Reveal>
          <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight text-vox-text-primary mb-14">
            {t('landing.why.title')}
          </h2>
        </Reveal>

        {/* Value props */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-10 mb-16">
          {[
            {
              icon: Lock,
              title: t('landing.why.ownData'),
              description: t('landing.why.ownDataDesc'),
            },
            {
              icon: Code2,
              title: t('landing.why.sourceAvailable'),
              description: t('landing.why.sourceAvailableDesc'),
            },
            {
              icon: HeartHandshake,
              title: t('landing.why.communityDriven'),
              description: t('landing.why.communityDrivenDesc'),
            },
          ].map((v) => (
            <div key={v.title}>
              <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-[#5B21B6]/20 to-[#3B82F6]/20 flex items-center justify-center mb-4">
                <v.icon className="h-7 w-7 text-vox-accent-primary" />
              </div>
              <h3 className="text-xl font-semibold text-vox-text-primary mb-2">{v.title}</h3>
              <p className="text-sm text-vox-text-secondary leading-relaxed">{v.description}</p>
            </div>
          ))}
        </div>

        {/* Privacy shield + highlights */}
        <Reveal delay={0.1}>
          <div className="lp-card lp-card--static flex flex-col md:flex-row items-center gap-10 px-8 py-8 lg:px-12">
            <ShieldSvg className="w-28 h-32 shrink-0" />
            <div className="flex-1">
              <h3 className="text-xl font-semibold text-vox-text-primary mb-4">{t('landing.why.builtDifferent')}</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {highlights.map((h) => (
                  <div key={h} className="flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5 text-vox-accent-success shrink-0" />
                    <span className="text-sm text-vox-text-primary">{h}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/** Mini heart path centered at 0,0 (size ~12x11) */
const MINI_HEART = 'M0 4 C0 4 -6 -1 -6 -4 C-6 -6.5 -4 -8 -2 -8 C-0.5 -8 0 -6.5 0 -5.5 C0 -6.5 0.5 -8 2 -8 C4 -8 6 -6.5 6 -4 C6 -1 0 4 0 4Z';

const miniHearts = [
  { x: 100, y: 100, tx: -55, ty: -50, dur: 3.5, delay: 0,   fill: 'rgba(236,72,153,0.6)' },
  { x: 100, y: 100, tx:  50, ty: -45, dur: 4.0, delay: 0.8, fill: 'rgba(167,139,250,0.55)' },
  { x: 100, y: 100, tx: -35, ty: -65, dur: 3.8, delay: 1.5, fill: 'rgba(236,72,153,0.5)' },
  { x: 100, y: 100, tx:  60, ty: -30, dur: 4.2, delay: 2.2, fill: 'rgba(167,139,250,0.45)' },
  { x: 100, y: 100, tx:  10, ty: -70, dur: 3.6, delay: 0.4, fill: 'rgba(236,72,153,0.55)' },
  { x: 100, y: 100, tx: -50, ty: -25, dur: 4.5, delay: 1.8, fill: 'rgba(167,139,250,0.5)' },
  { x: 100, y: 100, tx:  40, ty: -60, dur: 3.9, delay: 2.8, fill: 'rgba(236,72,153,0.45)' },
  { x: 100, y: 100, tx: -20, ty: -55, dur: 4.1, delay: 3.2, fill: 'rgba(167,139,250,0.5)' },
];

function PulsingHeartSvg({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <style>{`
        @keyframes heartBeat{0%,100%{transform:scale(1)}14%{transform:scale(1.15)}28%{transform:scale(1)}42%{transform:scale(1.08)}56%{transform:scale(1)}}
        @keyframes heartGlow{0%,100%{filter:drop-shadow(0 0 12px rgba(236,72,153,0.2))}50%{filter:drop-shadow(0 0 32px rgba(236,72,153,0.5))}}
        @keyframes ringPulse{0%,100%{opacity:0.06;transform:scale(1)}50%{opacity:0.12;transform:scale(1.04)}}
      `}</style>
      {/* Orbit rings */}
      <circle cx="100" cy="100" r="90" stroke="rgba(236,72,153,0.08)" strokeWidth="1" fill="none"
        style={{ animation: 'ringPulse 4s ease-in-out infinite' }} />
      <circle cx="100" cy="100" r="70" stroke="rgba(167,139,250,0.06)" strokeWidth="1" fill="none"
        style={{ animation: 'ringPulse 4s ease-in-out 1s infinite' }} />
      {/* Main pulsing heart */}
      <g style={{ transformOrigin: '100px 105px', animation: 'heartBeat 1.8s ease-in-out infinite, heartGlow 3s ease-in-out infinite' }}>
        <path d="M100 145 C100 145 55 112 55 82 C55 64 69 50 87 50 C96 50 103 56 100 66 C97 56 104 50 113 50 C131 50 145 64 145 82 C145 112 100 145 100 145Z"
          fill="rgba(236,72,153,0.2)" stroke="rgba(236,72,153,0.6)" strokeWidth="1.5" />
      </g>
      {/* Mini hearts spawning from center and floating outward */}
      {miniHearts.map((h, i) => (
        <g key={i} style={{ transform: `translate(${h.x}px, ${h.y}px)` }}>
          <path d={MINI_HEART} fill={h.fill}
            style={{
              animation: `miniFloat${i} ${h.dur}s ease-out ${h.delay}s infinite`,
              opacity: 0,
            }}
          />
          <style>{`
            @keyframes miniFloat${i}{
              0%{transform:translate(0,0) scale(0.5);opacity:0}
              10%{opacity:0.8;transform:translate(${h.tx * 0.1}px,${h.ty * 0.1}px) scale(0.7)}
              80%{opacity:0.3}
              100%{transform:translate(${h.tx}px,${h.ty}px) scale(0.3);opacity:0}
            }
          `}</style>
        </g>
      ))}
    </svg>
  );
}

function CommunityFunding() {
  const { t } = useTranslation();
  const sectionRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setVisible(true); },
      { threshold: 0.2 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const cards = [
    { icon: Code2, value: '100%', label: t('landing.funding.sourceAvailable'), color: 'from-pink-500/20 to-purple-500/20' },
    { icon: Users, value: 'You', label: t('landing.funding.youDecide'), color: 'from-purple-500/20 to-blue-500/20' },
    { icon: Shield, value: 'Zero', label: t('landing.funding.zeroAds'), color: 'from-blue-500/20 to-pink-500/20' },
  ];

  return (
    <section ref={sectionRef} className="lp-section overflow-hidden">
      {/* Radial gradient backdrop */}
      <div
        className="absolute inset-0 opacity-15"
        style={{ background: 'radial-gradient(ellipse at 25% 40%, rgba(236,72,153,0.4) 0%, transparent 65%)' }}
      />

      <div className="relative z-10 max-w-7xl mx-auto px-6 lg:px-10 py-20 sm:py-24">
        <div className="grid grid-cols-1 lg:grid-cols-2 items-center gap-12 mb-14">
          {/* Copy + CTAs */}
          <div className={`lp-reveal ${visible ? 'lp-in' : ''}`}>
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-pink-500/10 border border-pink-500/20 text-pink-400 text-sm font-medium mb-6">
              <Heart size={14} className="animate-pulse" />
              {t('landing.funding.badge')}
              <Sparkles size={14} />
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold text-vox-text-primary">
              {t('landing.funding.title')}
            </h2>
            <p className="text-vox-text-secondary mt-3 text-lg max-w-xl">
              {t('landing.funding.subtitle')}
            </p>

            <div className="mt-8 flex flex-wrap gap-4">
              <a
                href="https://github.com/sponsors/Aizen93"
                target="_blank"
                rel="noopener noreferrer"
                className="group relative btn-primary px-8 py-3 text-base inline-flex items-center gap-2
                           hover:shadow-lg hover:shadow-pink-500/20 hover:scale-105 active:scale-[0.98] transition-all duration-200"
              >
                <Heart size={18} className="group-hover:animate-pulse" />
                {t('landing.funding.sponsorGithub')}
                <ArrowRight size={16} className="opacity-0 -ml-4 group-hover:opacity-100 group-hover:ml-0 transition-all duration-200" />
              </a>
              <a
                href="https://opencollective.com/voxium"
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary px-8 py-3 text-base inline-flex items-center gap-2
                           hover:scale-105 active:scale-[0.98] transition-all duration-200"
              >
                <HeartHandshake size={18} />
                {t('landing.funding.openCollective')}
              </a>
            </div>
            <p className="mt-5 text-sm text-vox-text-muted flex items-center gap-1.5">
              <Sparkles size={14} className="text-pink-400" />
              {t('landing.funding.supporterBadge')}
            </p>
          </div>

          {/* Heart illustration anchors the right column */}
          <div className={`hidden lg:flex justify-center lp-reveal ${visible ? 'lp-in' : ''}`} style={{ transitionDelay: '0.15s' }}>
            <PulsingHeartSvg className="w-72 h-72" />
          </div>
        </div>

        {/* Stat cards with staggered entrance */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {cards.map((card, i) => (
            <div
              key={card.label}
              className={`group lp-card lp-card--rose flex items-center gap-5 p-6 cursor-default ${visible ? 'lp-card-in' : 'lp-card-hidden'}`}
              style={{ animationDelay: `${0.2 + i * 0.12}s` }}
            >
              <div className={`h-12 w-12 shrink-0 rounded-lg bg-gradient-to-br ${card.color} flex items-center justify-center
                              group-hover:scale-110 transition-transform duration-300`}>
                <card.icon className="h-6 w-6 text-pink-400 group-hover:scale-110 transition-transform duration-300" />
              </div>
              <div>
                <p className="text-2xl sm:text-3xl font-extrabold text-vox-text-primary">{card.value}</p>
                <p className="text-sm text-vox-text-secondary">{card.label}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCTA() {
  const { t } = useTranslation();

  return (
    <section className="relative px-4 sm:px-6 py-16 sm:py-20">
      <div
        className="relative max-w-7xl mx-auto overflow-hidden rounded-[32px] border border-[#8b7bff]/20 px-6 py-20 sm:py-24"
        style={{ background: 'radial-gradient(120% 140% at 50% 0%, rgba(91,91,247,0.28) 0%, rgba(27,22,80,0.9) 45%, #0e0e26 100%)' }}
      >
        {/* Decorative orbit */}
        <OrbitRingsSvg className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] opacity-25" />

        <Reveal className="relative z-10 max-w-3xl mx-auto text-center">
          <img src="/logo.svg" alt="" className="h-16 w-16 rounded-2xl mx-auto mb-8" />
          <h2 className="text-3xl sm:text-5xl font-semibold tracking-tight text-vox-text-primary mb-4">
            {t('landing.cta.title')}
          </h2>
          <p className="text-vox-text-secondary mb-10 text-lg">
            {t('landing.cta.subtitle')}
          </p>
          <div className="flex flex-wrap gap-4 justify-center">
            <Link to="/register" className="btn-primary rounded-full px-8 py-3 text-base hover:scale-105 active:scale-[0.98] transition-all duration-200">
              {t('landing.cta.getStarted')}
            </Link>
            <a href="#hero" className="btn rounded-full bg-white/[0.06] text-vox-text-primary border border-white/15 hover:bg-white/[0.12] px-8 py-3 text-base transition-all duration-200">
              {t('landing.cta.downloadApp')}
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Footer() {
  const { t } = useTranslation();

  return (
    <footer className="border-t border-white/[0.06]">
      <div className="max-w-7xl mx-auto px-6 lg:px-10 py-16">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-12">
          {/* Brand */}
          <div className="col-span-2 md:col-span-6">
            <div className="flex items-center gap-2.5 mb-3">
              <img src="/logo_static.svg" alt="Voxium" className="h-8 w-8 rounded-lg" />
              <span className="text-lg font-bold text-vox-text-primary">Voxium</span>
            </div>
            <p className="text-sm text-vox-text-muted leading-relaxed max-w-xs">
              {t('landing.footer.tagline')}
            </p>
          </div>

          {/* Product */}
          <div className="md:col-span-2">
            <h4 className="text-sm font-semibold text-vox-text-primary mb-3">{t('landing.footer.product')}</h4>
            <ul className="space-y-2">
              <li><a href="#hero" className="text-sm text-vox-text-muted hover:text-vox-text-primary transition-colors">{t('landing.footer.download')}</a></li>
              <li><a href="https://github.com/Aizen93/voxium/releases" target="_blank" rel="noopener noreferrer" className="text-sm text-vox-text-muted hover:text-vox-text-primary transition-colors">{t('landing.footer.changelog')}</a></li>
              {/* Status page: uncomment once Uptime Kuma is deployed
              <li><a href="https://status.voxium.app" target="_blank" rel="noopener noreferrer" className="text-sm text-vox-text-muted hover:text-vox-text-primary transition-colors">{t('landing.footer.status')}</a></li>
              */}
            </ul>
          </div>

          {/* Legal */}
          <div className="md:col-span-2">
            <h4 className="text-sm font-semibold text-vox-text-primary mb-3">{t('landing.footer.legal')}</h4>
            <ul className="space-y-2">
              <li><Link to="/privacy" className="text-sm text-vox-text-muted hover:text-vox-text-primary transition-colors">{t('landing.footer.privacyPolicy')}</Link></li>
              <li><Link to="/terms" className="text-sm text-vox-text-muted hover:text-vox-text-primary transition-colors">{t('landing.footer.termsOfService')}</Link></li>
              <li><Link to="/cookies" className="text-sm text-vox-text-muted hover:text-vox-text-primary transition-colors">{t('landing.footer.cookiePolicy')}</Link></li>
            </ul>
          </div>

          {/* Community */}
          <div className="md:col-span-2">
            <h4 className="text-sm font-semibold text-vox-text-primary mb-3">{t('landing.footer.community')}</h4>
            <ul className="space-y-2">
              <li><a href="https://github.com/Aizen93/voxium" target="_blank" rel="noopener noreferrer" className="text-sm text-vox-text-muted hover:text-vox-text-primary transition-colors">GitHub</a></li>
              <li><a href="https://github.com/Aizen93/voxium?tab=contributing-ov-file" target="_blank" rel="noopener noreferrer" className="text-sm text-vox-text-muted hover:text-vox-text-primary transition-colors">{t('landing.footer.contributing')}</a></li>
            </ul>
          </div>
        </div>
      </div>

      {/* Copyright bar */}
      <div className="border-t border-white/[0.06]">
        <div className="max-w-7xl mx-auto px-6 lg:px-10 py-4">
          <p className="text-xs text-vox-text-muted text-center">
            {t('landing.footer.copyright')}
          </p>
        </div>
      </div>
    </footer>
  );
}

/* ─── Main Export ─── */

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001/api/v1';

export function LandingPage() {
  const [showFunding, setShowFunding] = useState(false);

  useEffect(() => {
    document.documentElement.classList.add('landing-scroll');

    // Landing page was designed for the dark theme — force it while mounted
    // and restore the user's chosen theme on unmount.
    const previousTheme = document.documentElement.getAttribute('data-theme');
    document.documentElement.setAttribute('data-theme', 'dark');

    return () => {
      document.documentElement.classList.remove('landing-scroll');
      if (previousTheme) {
        document.documentElement.setAttribute('data-theme', previousTheme);
      }
    };
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/feature-flags/public`)
      .then((r) => r.json())
      .then((res) => {
        if (res.success && res.data.community_funding) setShowFunding(true);
      })
      .catch((err) => { console.warn('[Landing] Failed to fetch feature flags:', err); });
  }, []);

  return (
    <div className="lp-root text-vox-text-primary">
      <LandingStyles />
      <Navbar />
      <Hero />
      <StatsSection />
      <Features />
      <Showcase />
      <WhyVoxium />
      <ComparisonTable />
      {showFunding && <CommunityFunding />}
      <FinalCTA />
      <Footer />
    </div>
  );
}
