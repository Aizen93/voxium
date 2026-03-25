import { useEffect, useState, useRef, useCallback } from 'react';
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
  Heart,
  Sparkles,
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

/* ─── Section Components ─── */

function Navbar() {
  const { t, i18n } = useTranslation();

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-vox-bg-primary/80 backdrop-blur-md border-b border-vox-border">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <a href="#hero" className="flex items-center gap-2.5">
          <img src="/logo.svg" alt="Voxium" className="h-9 w-9 rounded-lg" />
          <span className="text-xl font-bold text-vox-text-primary">Voxium</span>
        </a>
        <div className="flex items-center gap-3">
          <select
            value={i18n.language}
            onChange={(e) => { i18n.changeLanguage(e.target.value); localStorage.setItem('voxium_language', e.target.value); }}
            className="bg-transparent border border-vox-border rounded-md px-2 py-1 text-xs text-vox-text-secondary focus:outline-none focus:border-vox-accent-primary cursor-pointer"
          >
            {SUPPORTED_LANGUAGES.map((lang) => (
              <option key={lang.code} value={lang.code} className="bg-vox-bg-primary text-vox-text-primary">
                {lang.nativeName}
              </option>
            ))}
          </select>
          <Link to="/login" className="btn-ghost text-sm">
            {t('landing.nav.signIn')}
          </Link>
          <Link to="/register" className="btn-primary text-sm">
            {t('landing.nav.getStarted')} <ArrowRight className="ml-1 h-4 w-4" />
          </Link>
        </div>
      </div>
    </nav>
  );
}

function Hero() {
  const { t } = useTranslation();

  return (
    <section
      id="hero"
      className="relative min-h-screen flex items-center justify-center pt-16 overflow-hidden"
    >
      {/* Background: solid fallback + WebGL sound waves (lower half) */}
      <div className="absolute inset-0 bg-vox-bg-primary" />
      <SoundWaveCanvas className="absolute inset-0 w-full h-full" />

      <div className="relative z-10 max-w-7xl mx-auto px-6 py-24 flex flex-col lg:flex-row items-center gap-16">
        {/* Text content */}
        <div className="flex-1 text-center lg:text-left">
          <div className="flex items-center justify-center lg:justify-start gap-4 mb-8 animate-fade-in">
            <img src="/logo.svg" alt="" className="h-16 w-16 sm:h-20 sm:w-20 rounded-2xl" />
          </div>
          <h1 className="text-4xl sm:text-5xl md:text-7xl font-extrabold text-vox-text-primary leading-tight animate-fade-in">
            {t('landing.hero.headlinePart1')}{' '}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#5B21B6] to-[#3B82F6]">
              {t('landing.hero.headlinePart2')}
            </span>
          </h1>
          <p
            className="mt-6 text-lg sm:text-xl max-w-xl mx-auto lg:mx-0 animate-slide-up"
            style={{ animationDelay: '0.1s', animationFillMode: 'backwards' }}
          >
            {t('landing.hero.subtitle')}
          </p>

          {/* Download buttons */}
          <div
            className="mt-8 flex flex-wrap gap-4 justify-center lg:justify-start animate-slide-up"
            style={{ animationDelay: '0.2s', animationFillMode: 'backwards' }}
          >
            <a
              href={DOWNLOAD_URLS.windows}
              target="_blank"
              rel="noopener noreferrer"
              className="group relative btn bg-vox-bg-tertiary/80 text-vox-text-primary border border-white/5 hover:border-[#0078D4]/50 hover:bg-[#0078D4]/15 hover:shadow-[0_0_20px_rgba(0,120,212,0.2)] hover:scale-[1.03] active:scale-[0.98] px-5 py-3 text-base transition-all duration-200"
            >
              <svg className="mr-2 h-5 w-5 transition-transform duration-200 group-hover:-translate-y-0.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801"/>
              </svg>
              {t('landing.hero.downloadWindows')}
            </a>
            <a
              href={DOWNLOAD_URLS.macos}
              target="_blank"
              rel="noopener noreferrer"
              className="group relative btn bg-vox-bg-tertiary/80 text-vox-text-primary border border-white/5 hover:border-[#A2AAAD]/50 hover:bg-[#A2AAAD]/15 hover:shadow-[0_0_20px_rgba(162,170,173,0.15)] hover:scale-[1.03] active:scale-[0.98] px-5 py-3 text-base transition-all duration-200"
            >
              <svg className="mr-2 h-5 w-5 transition-transform duration-200 group-hover:-translate-y-0.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
              </svg>
              {t('landing.hero.downloadMac')}
            </a>
            <a
              href={DOWNLOAD_URLS.linux}
              target="_blank"
              rel="noopener noreferrer"
              className="group relative btn bg-vox-bg-tertiary/80 text-vox-text-primary border border-white/5 hover:border-[#E95420]/50 hover:bg-[#E95420]/15 hover:shadow-[0_0_20px_rgba(233,84,32,0.15)] hover:scale-[1.03] active:scale-[0.98] px-5 py-3 text-base transition-all duration-200"
            >
              <svg className="mr-2 h-5 w-5 transition-transform duration-200 group-hover:-translate-y-0.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M17.61.455a3.41 3.41 0 0 0-3.41 3.41 3.41 3.41 0 0 0 3.41 3.41 3.41 3.41 0 0 0 3.41-3.41 3.41 3.41 0 0 0-3.41-3.41zM12.92.8C8.923.777 5.137 2.941 3.148 6.451a4.5 4.5 0 0 1 .26-.007 4.92 4.92 0 0 1 2.585.737A8.316 8.316 0 0 1 12.688 3.6 4.944 4.944 0 0 1 13.723.834 11.008 11.008 0 0 0 12.92.8zm9.226 4.994a4.915 4.915 0 0 1-1.918 2.246 8.36 8.36 0 0 1-.273 8.303 4.89 4.89 0 0 1 1.632 2.54 11.156 11.156 0 0 0 .559-13.089zM3.41 7.932A3.41 3.41 0 0 0 0 11.342a3.41 3.41 0 0 0 3.41 3.409 3.41 3.41 0 0 0 3.41-3.41 3.41 3.41 0 0 0-3.41-3.41zm2.027 7.866a4.908 4.908 0 0 1-2.915.358 11.1 11.1 0 0 0 7.991 6.698 11.234 11.234 0 0 0 2.422.249 4.879 4.879 0 0 1-.999-2.85 8.484 8.484 0 0 1-.836-.136 8.304 8.304 0 0 1-5.663-4.32zm11.405.928a3.41 3.41 0 0 0-3.41 3.41 3.41 3.41 0 0 0 3.41 3.41 3.41 3.41 0 0 0 3.41-3.41 3.41 3.41 0 0 0-3.41-3.41z"/>
              </svg>
              {t('landing.hero.downloadLinux')}
            </a>
          </div>

          <p
            className="mt-4 text-sm text-vox-text-muted animate-slide-up"
            style={{ animationDelay: '0.3s', animationFillMode: 'backwards' }}
          >
            {t('landing.hero.orLaunch')}{' '}
            <Link to="/register" className="text-vox-accent-primary hover:underline">
              {t('landing.hero.launchBrowser')}
            </Link>
          </p>

		  {/* Waveform decoration */}
          <div
            className="mt-6 flex justify-center lg:justify-start animate-slide-up"
            style={{ animationDelay: '0.15s', animationFillMode: 'backwards' }}
          >
            <WaveformSvg className="h-10 w-48 opacity-50" />
          </div>

        </div>

        {/* Animated Mock UI panel */}
        <div
          className="hidden md:block flex-1 max-w-md w-full animate-slide-up"
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
          <div className="rounded-xl border border-vox-border bg-vox-bg-primary shadow-2xl overflow-hidden">
            {/* Title bar */}
            <div className="flex items-center gap-2 px-4 py-3 bg-vox-bg-secondary border-b border-vox-border">
              <div className="h-3 w-3 rounded-full bg-vox-accent-danger" />
              <div className="h-3 w-3 rounded-full bg-vox-accent-warning" />
              <div className="h-3 w-3 rounded-full bg-vox-accent-success" />
              <img src="/logo_static.svg" alt="" className="ml-2 h-4 w-4 rounded-sm" />
              <span className="text-xs text-vox-text-muted">Voxium</span>
            </div>
            {/* Fake layout */}
            <div className="flex" style={{ height: 296 }}>
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
    { icon: Users, label: t('landing.stats.users'), value: usersCount, gradient: 'from-[#5B21B6] to-[#7C3AED]' },
    { icon: Server, label: t('landing.stats.servers'), value: serversCount, gradient: 'from-[#3B82F6] to-[#60A5FA]' },
    { icon: MessageSquare, label: t('landing.stats.messages'), value: messagesCount, gradient: 'from-[#5b5bf7] to-[#A78BFA]' },
  ];

  return (
    <section ref={sectionRef} className="relative bg-vox-bg-primary py-20 overflow-hidden">
      {/* Subtle gradient backdrop */}
      <div
        className="absolute inset-0 opacity-10"
        style={{ background: 'radial-gradient(ellipse at center, #5b5bf7 0%, transparent 70%)' }}
      />

      <div className="relative z-10 max-w-5xl mx-auto px-6">
        <h2 className="text-2xl sm:text-3xl font-bold text-vox-text-primary text-center mb-3">
          {t('landing.stats.title')}
        </h2>
        <p className="text-vox-text-secondary text-center mb-12 max-w-lg mx-auto text-sm">
          {t('landing.stats.subtitle')}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          {cards.map((card) => (
            <div
              key={card.label}
              className="group relative rounded-xl border border-vox-border bg-vox-bg-secondary p-6 text-center hover:border-vox-accent-primary/40 transition-all duration-300"
            >
              {/* Icon */}
              <div className={`h-12 w-12 rounded-lg bg-gradient-to-br ${card.gradient} bg-opacity-20 flex items-center justify-center mx-auto mb-4`}
                style={{ background: `linear-gradient(135deg, ${card.gradient.includes('5B21B6') ? 'rgba(91,33,182,0.15)' : card.gradient.includes('3B82F6') ? 'rgba(59,130,246,0.15)' : 'rgba(91,91,247,0.15)'}, ${card.gradient.includes('7C3AED') ? 'rgba(124,58,237,0.15)' : card.gradient.includes('60A5FA') ? 'rgba(96,165,250,0.15)' : 'rgba(167,139,250,0.15)'})` }}
              >
                <card.icon className="h-6 w-6 text-vox-accent-primary" />
              </div>

              {/* Number */}
              <div className="text-3xl sm:text-4xl font-extrabold text-vox-text-primary mb-1 tabular-nums">
                {stats ? formatNumber(card.value) : '—'}
              </div>

              {/* Label */}
              <div className="text-sm text-vox-text-secondary">{card.label}</div>
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

  return (
    <section className="relative bg-vox-bg-secondary py-24">
      {/* Particle separator at top */}
      <ParticlesSvg className="absolute top-0 left-0 w-full h-16" />

      <div ref={sectionRef} className="max-w-7xl mx-auto px-6">
        <h2 className="text-3xl sm:text-4xl font-bold text-vox-text-primary text-center mb-4">
          {t('landing.features.title')}
        </h2>
        <p className="text-vox-text-secondary text-center mb-16 max-w-2xl mx-auto">
          {t('landing.features.subtitle')}
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((f, i) => (
            <div
              key={i}
              data-feature-card={i}
              className={`group rounded-xl border border-vox-border bg-vox-bg-primary p-6
                hover:border-vox-accent-primary/60 hover:-translate-y-2 hover:shadow-xl hover:shadow-vox-accent-primary/10
                transition-all duration-300 cursor-default
                ${i === features.length - 1 ? 'md:col-start-1 md:col-end-3 md:max-w-[calc(50%-12px)] md:justify-self-center lg:col-start-2 lg:col-end-3 lg:max-w-none' : ''}`}
              style={{
                opacity: visibleCards.has(i) ? 1 : 0,
                transform: visibleCards.has(i) ? undefined : 'translateY(32px)',
                transition: `opacity 0.5s ease-out ${i * 0.1}s, transform 0.5s ease-out ${i * 0.1}s, border-color 0.3s, box-shadow 0.3s`,
              }}
            >
              <div className="h-12 w-12 rounded-lg bg-gradient-to-br from-[#5B21B6]/20 to-[#3B82F6]/20 flex items-center justify-center mb-4 group-hover:from-[#5B21B6]/40 group-hover:to-[#3B82F6]/40 group-hover:scale-110 transition-all duration-300">
                <f.icon className="h-6 w-6 text-vox-accent-primary group-hover:scale-110 transition-transform duration-300" />
              </div>
              <h3 className="text-lg font-semibold text-vox-text-primary mb-2 group-hover:text-vox-accent-primary transition-colors duration-300">
                {f.title}
              </h3>
              <p className="text-sm text-vox-text-secondary leading-relaxed">
                {f.description}
              </p>
            </div>
          ))}
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
    { feature: t('landing.comparison.openSource'),        voxium: true,                discord: false,          teamspeak: false,          matrix: true },
    { feature: t('landing.comparison.selfHostable'),      voxium: true,                discord: false,          teamspeak: true,           matrix: true },
    { feature: t('landing.comparison.freeVoiceChat'),     voxium: true,                discord: true,           teamspeak: true,           matrix: true },
    { feature: t('landing.comparison.sfuVoice'),          voxium: true,                discord: true,           teamspeak: true,           matrix: t('landing.comparison.viaJitsi') },
    { feature: t('landing.comparison.dmVoiceCalls'),      voxium: true,                discord: true,           teamspeak: false,          matrix: true },
    { feature: t('landing.comparison.noiseSuppression'),  voxium: 'RNNoise ML',        discord: 'Krisp',        teamspeak: t('landing.comparison.basic'), matrix: false },
    { feature: t('landing.comparison.screenSharing'),     voxium: true,                discord: true,           teamspeak: false,          matrix: t('landing.comparison.viaJitsi') },
    { feature: t('landing.comparison.messageReactions'),  voxium: true,                discord: true,           teamspeak: false,          matrix: true },
    { feature: t('landing.comparison.fileSharing'),       voxium: true,                discord: true,           teamspeak: true,           matrix: true },
    { feature: t('landing.comparison.noAdsTracking'),     voxium: true,                discord: false,          teamspeak: true,           matrix: true },
    { feature: t('landing.comparison.desktopApp'),        voxium: true,                discord: true,           teamspeak: true,           matrix: true },
    { feature: t('landing.comparison.lightweightClient'), voxium: 'Tauri (~10MB)',      discord: 'Electron',     teamspeak: 'Native',       matrix: 'Electron' },
    { feature: t('landing.comparison.encryption'),        voxium: 'TLS + Planned E2E', discord: 'TLS',          teamspeak: 'AES',          matrix: 'E2E (Olm)' },
    { feature: t('landing.comparison.customBots'),        voxium: t('landing.comparison.planned'), discord: true, teamspeak: 'Plugins + SDK', matrix: true },
    { feature: t('landing.comparison.mobileApp'),         voxium: t('landing.comparison.planned'), discord: true, teamspeak: true,           matrix: true },
  ];

  return (
    <section className="bg-vox-bg-secondary py-24">
      <div className="max-w-5xl mx-auto px-6">
        <h2 className="text-3xl sm:text-4xl font-bold text-vox-text-primary text-center mb-4">
          {t('landing.comparison.title')}
        </h2>
        <p className="text-vox-text-secondary text-center mb-14 max-w-2xl mx-auto">
          {t('landing.comparison.subtitle')}
        </p>

        <div className="overflow-x-auto rounded-xl border border-vox-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-vox-bg-tertiary">
                <th className="text-left px-5 py-4 text-vox-text-primary font-semibold min-w-[180px]">{t('landing.comparison.feature')}</th>
                <th className="px-5 py-4 text-center min-w-[110px]">
                  <span className="font-bold text-vox-accent-primary">Voxium</span>
                </th>
                <th className="px-5 py-4 text-center text-vox-text-secondary font-medium min-w-[110px]">Discord</th>
                <th className="px-5 py-4 text-center text-vox-text-secondary font-medium min-w-[110px]">TeamSpeak</th>
                <th className="px-5 py-4 text-center text-vox-text-secondary font-medium min-w-[110px]">Matrix</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-vox-border">
              {comparisonData.map((row) => (
                <tr key={row.feature} className="hover:bg-vox-bg-hover/50 transition-colors">
                  <td className="px-5 py-3.5 text-vox-text-primary font-medium">{row.feature}</td>
                  <td className="px-5 py-3.5 text-center">{<ComparisonCell value={row.voxium} />}</td>
                  <td className="px-5 py-3.5 text-center">{<ComparisonCell value={row.discord} />}</td>
                  <td className="px-5 py-3.5 text-center">{<ComparisonCell value={row.teamspeak} />}</td>
                  <td className="px-5 py-3.5 text-center">{<ComparisonCell value={row.matrix} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-vox-text-muted text-center mt-6">
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
    t('landing.highlights.openSource'),
    t('landing.highlights.freeVoice'),
    t('landing.highlights.noiseSuppression'),
    t('landing.highlights.selfHostable'),
    t('landing.highlights.sfuVoice'),
  ];

  return (
    <section className="relative bg-vox-bg-primary py-24 overflow-hidden">
      {/* Decorative orbit rings */}
      <OrbitRingsSvg className="absolute -right-32 top-1/2 -translate-y-1/2 w-[500px] h-[500px] opacity-40 hidden lg:block" />

      <div className="relative z-10 max-w-7xl mx-auto px-6">
        <h2 className="text-3xl sm:text-4xl font-bold text-vox-text-primary text-center mb-16">
          {t('landing.why.title')}
        </h2>

        {/* Value props */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-10 mb-20">
          {[
            {
              icon: Lock,
              title: t('landing.why.ownData'),
              description: t('landing.why.ownDataDesc'),
            },
            {
              icon: Code2,
              title: t('landing.why.openSource'),
              description: t('landing.why.openSourceDesc'),
            },
            {
              icon: HeartHandshake,
              title: t('landing.why.communityDriven'),
              description: t('landing.why.communityDrivenDesc'),
            },
          ].map((v) => (
            <div key={v.title} className="text-center">
              <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-[#5B21B6]/20 to-[#3B82F6]/20 flex items-center justify-center mx-auto mb-4">
                <v.icon className="h-7 w-7 text-vox-accent-primary" />
              </div>
              <h3 className="text-xl font-semibold text-vox-text-primary mb-2">{v.title}</h3>
              <p className="text-sm text-vox-text-secondary leading-relaxed max-w-xs mx-auto">{v.description}</p>
            </div>
          ))}
        </div>

        {/* Privacy shield + highlights */}
        <div className="flex flex-col md:flex-row items-center justify-center gap-12 max-w-3xl mx-auto">
          <ShieldSvg className="w-28 h-32 shrink-0" />
          <div>
            <h3 className="text-xl font-semibold text-vox-text-primary mb-4">{t('landing.why.builtDifferent')}</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {highlights.map((h) => (
                <div key={h} className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-vox-accent-success shrink-0" />
                  <span className="text-sm text-vox-text-primary">{h}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
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
    { icon: Code2, value: '100%', label: t('landing.funding.openSource'), color: 'from-pink-500/20 to-purple-500/20' },
    { icon: Users, value: 'You', label: t('landing.funding.youDecide'), color: 'from-purple-500/20 to-blue-500/20' },
    { icon: Shield, value: 'Zero', label: t('landing.funding.zeroAds'), color: 'from-blue-500/20 to-pink-500/20' },
  ];

  return (
    <section ref={sectionRef} className="relative bg-vox-bg-primary py-24 overflow-hidden">
      {/* Radial gradient backdrop */}
      <div
        className="absolute inset-0 opacity-15"
        style={{ background: 'radial-gradient(ellipse at center, rgba(236,72,153,0.4) 0%, transparent 70%)' }}
      />

      <div className="relative z-10 max-w-5xl mx-auto px-6">
        {/* Header with heart illustration */}
        <div
          className="text-center mb-14"
          style={{
            opacity: visible ? 1 : 0,
            transform: visible ? 'translateY(0)' : 'translateY(24px)',
            transition: 'opacity 0.6s ease-out, transform 0.6s ease-out',
          }}
        >
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-pink-500/10 border border-pink-500/20 text-pink-400 text-sm font-medium mb-6">
            <Heart size={14} className="animate-pulse" />
            {t('landing.funding.badge')}
            <Sparkles size={14} />
          </div>

          <div className="flex items-center justify-center gap-4 mb-4">
            <PulsingHeartSvg className="w-32 h-32 sm:w-40 sm:h-40 shrink-0" />
            <div className="text-left">
              <h2 className="text-3xl sm:text-4xl font-bold text-vox-text-primary">
                {t('landing.funding.title')}
              </h2>
              <p className="text-vox-text-secondary mt-2 text-lg max-w-xl">
                {t('landing.funding.subtitle')}
              </p>
            </div>
          </div>
        </div>

        {/* Stat cards with staggered entrance */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-12">
          {cards.map((card, i) => (
            <div
              key={card.label}
              className="group relative rounded-xl border border-vox-border bg-vox-bg-secondary p-6 text-center
                         hover:border-pink-500/40 hover:-translate-y-2 hover:shadow-xl hover:shadow-pink-500/10
                         transition-all duration-300 cursor-default"
              style={{
                opacity: visible ? 1 : 0,
                transform: visible ? 'translateY(0)' : 'translateY(32px)',
                transition: `opacity 0.5s ease-out ${0.2 + i * 0.15}s, transform 0.5s ease-out ${0.2 + i * 0.15}s, border-color 0.3s, box-shadow 0.3s`,
              }}
            >
              <div className={`h-12 w-12 rounded-lg bg-gradient-to-br ${card.color} flex items-center justify-center mx-auto mb-4
                              group-hover:scale-110 transition-transform duration-300`}>
                <card.icon className="h-6 w-6 text-pink-400 group-hover:scale-110 transition-transform duration-300" />
              </div>
              <p className="text-3xl sm:text-4xl font-extrabold text-vox-text-primary mb-1">{card.value}</p>
              <p className="text-sm text-vox-text-secondary">{card.label}</p>
            </div>
          ))}
        </div>

        {/* CTA buttons */}
        <div
          className="text-center"
          style={{
            opacity: visible ? 1 : 0,
            transform: visible ? 'translateY(0)' : 'translateY(20px)',
            transition: 'opacity 0.5s ease-out 0.7s, transform 0.5s ease-out 0.7s',
          }}
        >
          <div className="flex flex-wrap gap-4 justify-center mb-6">
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

          <p className="text-sm text-vox-text-muted flex items-center justify-center gap-1.5">
            <Sparkles size={14} className="text-pink-400" />
            {t('landing.funding.supporterBadge')}
          </p>
        </div>
      </div>
    </section>
  );
}

function FinalCTA() {
  const { t } = useTranslation();

  return (
    <section className="relative py-24 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-[#5B21B6]/20 via-vox-bg-primary to-vox-bg-secondary" />
      {/* Decorative orbit */}
      <OrbitRingsSvg className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] opacity-20" />

      <div className="relative z-10 max-w-3xl mx-auto px-6 text-center">
        <img src="/logo.svg" alt="" className="h-16 w-16 rounded-2xl mx-auto mb-8" />
        <h2 className="text-3xl sm:text-4xl font-bold text-vox-text-primary mb-4">
          {t('landing.cta.title')}
        </h2>
        <p className="text-vox-text-secondary mb-10 text-lg">
          {t('landing.cta.subtitle')}
        </p>
        <div className="flex flex-wrap gap-4 justify-center">
          <Link to="/register" className="btn-primary px-8 py-3 text-base">
            {t('landing.cta.getStarted')}
          </Link>
          <a href="#hero" className="btn-secondary px-8 py-3 text-base">
            {t('landing.cta.downloadApp')}
          </a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  const { t } = useTranslation();

  return (
    <footer className="bg-vox-bg-secondary border-t border-vox-border">
      <div className="max-w-7xl mx-auto px-6 py-16">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1">
            <div className="flex items-center gap-2.5 mb-3">
              <img src="/logo_static.svg" alt="Voxium" className="h-8 w-8 rounded-lg" />
              <span className="text-lg font-bold text-vox-text-primary">Voxium</span>
            </div>
            <p className="text-sm text-vox-text-muted leading-relaxed">
              {t('landing.footer.tagline')}
            </p>
          </div>

          {/* Product */}
          <div>
            <h4 className="text-sm font-semibold text-vox-text-primary mb-3">{t('landing.footer.product')}</h4>
            <ul className="space-y-2">
              <li><a href="#hero" className="text-sm text-vox-text-muted hover:text-vox-text-primary transition-colors">{t('landing.footer.download')}</a></li>
              <li><a href="https://github.com/Aizen93/voxium/releases" target="_blank" rel="noopener noreferrer" className="text-sm text-vox-text-muted hover:text-vox-text-primary transition-colors">{t('landing.footer.changelog')}</a></li>
              <li><a href="#" onClick={(e) => e.preventDefault()} className="text-sm text-vox-text-muted hover:text-vox-text-primary transition-colors">{t('landing.footer.status')}</a></li>
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h4 className="text-sm font-semibold text-vox-text-primary mb-3">{t('landing.footer.legal')}</h4>
            <ul className="space-y-2">
              <li><Link to="/privacy" className="text-sm text-vox-text-muted hover:text-vox-text-primary transition-colors">{t('landing.footer.privacyPolicy')}</Link></li>
              <li><Link to="/terms" className="text-sm text-vox-text-muted hover:text-vox-text-primary transition-colors">{t('landing.footer.termsOfService')}</Link></li>
              <li><Link to="/cookies" className="text-sm text-vox-text-muted hover:text-vox-text-primary transition-colors">{t('landing.footer.cookiePolicy')}</Link></li>
            </ul>
          </div>

          {/* Community */}
          <div>
            <h4 className="text-sm font-semibold text-vox-text-primary mb-3">{t('landing.footer.community')}</h4>
            <ul className="space-y-2">
              <li><a href="https://github.com/Aizen93/voxium" target="_blank" rel="noopener noreferrer" className="text-sm text-vox-text-muted hover:text-vox-text-primary transition-colors">GitHub</a></li>
              <li><a href="#" onClick={(e) => e.preventDefault()} className="text-sm text-vox-text-muted hover:text-vox-text-primary transition-colors">{t('landing.footer.contributing')}</a></li>
            </ul>
          </div>
        </div>
      </div>

      {/* Copyright bar */}
      <div className="border-t border-vox-border">
        <div className="max-w-7xl mx-auto px-6 py-4">
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
    <div className="bg-vox-bg-primary text-vox-text-primary">
      <Navbar />
      <Hero />
      <StatsSection />
      <Features />
      <WhyVoxium />
      <ComparisonTable />
      {showFunding && <CommunityFunding />}
      <FinalCTA />
      <Footer />
    </div>
  );
}
