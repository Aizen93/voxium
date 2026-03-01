import { useEffect } from 'react';
import { Link } from 'react-router-dom';
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
  Monitor,
  Laptop,
  Terminal,
  ArrowRight,
} from 'lucide-react';

/* ─── Animated SVG Illustrations ─── */

/** Floating mesh network — represents P2P architecture */
function NetworkMeshSvg({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 800 600"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <style>{`
        @keyframes drift1 { 0%,100%{transform:translate(0,0)} 50%{transform:translate(12px,-18px)} }
        @keyframes drift2 { 0%,100%{transform:translate(0,0)} 50%{transform:translate(-16px,14px)} }
        @keyframes drift3 { 0%,100%{transform:translate(0,0)} 50%{transform:translate(10px,20px)} }
        @keyframes drift4 { 0%,100%{transform:translate(0,0)} 50%{transform:translate(-14px,-12px)} }
        @keyframes drift5 { 0%,100%{transform:translate(0,0)} 50%{transform:translate(18px,8px)} }
        @keyframes linePulse { 0%,100%{opacity:0.08} 50%{opacity:0.25} }
        @keyframes nodePulse { 0%,100%{r:4} 50%{r:6} }
        .n1{animation:drift1 8s ease-in-out infinite}
        .n2{animation:drift2 10s ease-in-out infinite}
        .n3{animation:drift3 7s ease-in-out infinite}
        .n4{animation:drift4 9s ease-in-out infinite}
        .n5{animation:drift5 11s ease-in-out infinite}
        .n6{animation:drift1 12s ease-in-out 1s infinite}
        .n7{animation:drift3 9s ease-in-out 0.5s infinite}
        .n8{animation:drift2 8s ease-in-out 2s infinite}
        .mesh-line{animation:linePulse 4s ease-in-out infinite;stroke:#5b5bf7;stroke-width:1}
        .mesh-line-d{animation:linePulse 4s ease-in-out 2s infinite;stroke:#5b5bf7;stroke-width:1}
        .mesh-node{fill:#5b5bf7;animation:nodePulse 3s ease-in-out infinite}
        .mesh-node-d{fill:#a78bfa;animation:nodePulse 3s ease-in-out 1.5s infinite}
      `}</style>
      {/* Lines connecting nodes */}
      <g opacity="0.15">
        <line x1="120" y1="150" x2="350" y2="100" className="mesh-line" />
        <line x1="350" y1="100" x2="580" y2="180" className="mesh-line-d" />
        <line x1="120" y1="150" x2="250" y2="350" className="mesh-line-d" />
        <line x1="350" y1="100" x2="250" y2="350" className="mesh-line" />
        <line x1="580" y1="180" x2="650" y2="380" className="mesh-line" />
        <line x1="250" y1="350" x2="500" y2="450" className="mesh-line-d" />
        <line x1="650" y1="380" x2="500" y2="450" className="mesh-line" />
        <line x1="580" y1="180" x2="500" y2="450" className="mesh-line-d" />
        <line x1="120" y1="150" x2="580" y2="180" className="mesh-line" />
        <line x1="250" y1="350" x2="650" y2="380" className="mesh-line-d" />
        <line x1="700" y1="120" x2="580" y2="180" className="mesh-line" />
        <line x1="700" y1="120" x2="650" y2="380" className="mesh-line-d" />
        <line x1="80" y1="420" x2="250" y2="350" className="mesh-line" />
        <line x1="80" y1="420" x2="120" y2="150" className="mesh-line-d" />
      </g>
      {/* Nodes */}
      <g className="n1"><circle cx="120" cy="150" className="mesh-node" r="4" /></g>
      <g className="n2"><circle cx="350" cy="100" className="mesh-node-d" r="5" /></g>
      <g className="n3"><circle cx="580" cy="180" className="mesh-node" r="4" /></g>
      <g className="n4"><circle cx="250" cy="350" className="mesh-node-d" r="5" /></g>
      <g className="n5"><circle cx="650" cy="380" className="mesh-node" r="4" /></g>
      <g className="n6"><circle cx="500" cy="450" className="mesh-node-d" r="4" /></g>
      <g className="n7"><circle cx="700" cy="120" className="mesh-node" r="3" /></g>
      <g className="n8"><circle cx="80" cy="420" className="mesh-node-d" r="3" /></g>
    </svg>
  );
}

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
          <stop offset="0%" stopColor="#A78BFA" />
          <stop offset="100%" stopColor="#5b5bf7" />
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
  windows: 'https://github.com/Aizen93/voxium/releases/latest/download/Voxium_0.9.6_x64-setup.exe',
  macos: 'https://github.com/Aizen93/voxium/releases/latest/download/Voxium_0.9.6_aarch64.dmg',
  linux: 'https://github.com/Aizen93/voxium/releases/latest/download/Voxium_0.9.6_amd64.deb',
  releases: 'https://github.com/Aizen93/voxium/releases',
};

/* ─── Data ─── */

const features = [
  {
    icon: Mic2,
    title: 'Crystal-Clear Voice',
    description: 'Mesh P2P WebRTC — audio goes directly between peers, no middleman servers touching your voice data.',
  },
  {
    icon: MessageSquare,
    title: 'Real-Time Messaging',
    description: 'Instant delivery, reactions, typing indicators, and direct messages — all in real time.',
  },
  {
    icon: Shield,
    title: 'Privacy First',
    description: 'No ads, no tracking, no data harvesting. Your conversations stay yours.',
  },
  {
    icon: Users,
    title: 'Servers & Communities',
    description: 'Create servers, organize channels, invite friends — everything you need to build a community.',
  },
  {
    icon: PhoneCall,
    title: 'Direct Voice Calls',
    description: '1-on-1 voice calls with WebRTC Perfect Negotiation. Crystal clear, peer-to-peer.',
  },
  {
    icon: Zap,
    title: 'Fast & Lightweight',
    description: 'Built with React 19, Vite, and Redis-backed presence. Snappy on any hardware.',
  },
];

const highlights = [
  'No ads or tracking',
  'Open source & transparent',
  'Free voice calls forever',
  'Peer-to-peer audio',
  'Self-hostable',
  'Free custom emoji',
];

/* ─── Section Components ─── */

function Navbar() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-vox-bg-primary/80 backdrop-blur-md border-b border-vox-border">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <a href="#hero" className="flex items-center gap-2.5">
          <img src="/logo.svg" alt="Voxium" className="h-9 w-9 rounded-lg" />
          <span className="text-xl font-bold text-vox-text-primary">Voxium</span>
        </a>
        <div className="flex items-center gap-3">
          <Link to="/login" className="btn-ghost text-sm">
            Sign In
          </Link>
          <Link to="/register" className="btn-primary text-sm">
            Get Started <ArrowRight className="ml-1 h-4 w-4" />
          </Link>
        </div>
      </div>
    </nav>
  );
}

function Hero() {
  return (
    <section
      id="hero"
      className="relative min-h-screen flex items-center justify-center pt-16 overflow-hidden"
    >
      {/* Background */}
      <div className="absolute inset-0 bg-vox-bg-primary" />
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[900px] h-[900px] rounded-full opacity-15"
        style={{ background: 'radial-gradient(circle, #5b5bf7 0%, transparent 70%)' }}
      />
      {/* Animated mesh background */}
      <NetworkMeshSvg className="absolute inset-0 w-full h-full opacity-60" />

      <div className="relative z-10 max-w-7xl mx-auto px-6 py-24 flex flex-col lg:flex-row items-center gap-16">
        {/* Text content */}
        <div className="flex-1 text-center lg:text-left">
          <div className="flex items-center justify-center lg:justify-start gap-4 mb-8 animate-fade-in">
            <img src="/logo.svg" alt="" className="h-16 w-16 sm:h-20 sm:w-20 rounded-2xl" />
          </div>
          <h1 className="text-4xl sm:text-5xl md:text-7xl font-extrabold text-vox-text-primary leading-tight animate-fade-in">
            Talk. Connect.{' '}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#5B21B6] to-[#3B82F6]">
              Build.
            </span>
          </h1>
          <p
            className="mt-6 text-lg sm:text-xl text-vox-text-secondary max-w-xl mx-auto lg:mx-0 animate-slide-up"
            style={{ animationDelay: '0.1s', animationFillMode: 'backwards' }}
          >
            The open, privacy-first voice and text platform for communities that
            value freedom and transparency.
          </p>

          {/* Waveform decoration */}
          <div
            className="mt-6 flex justify-center lg:justify-start animate-slide-up"
            style={{ animationDelay: '0.15s', animationFillMode: 'backwards' }}
          >
            <WaveformSvg className="h-10 w-48 opacity-50" />
          </div>

          {/* Download buttons */}
          <div
            className="mt-8 flex flex-wrap gap-4 justify-center lg:justify-start animate-slide-up"
            style={{ animationDelay: '0.2s', animationFillMode: 'backwards' }}
          >
            <a
              href={DOWNLOAD_URLS.windows}
              target="_blank"
              rel="noopener noreferrer"
              className="btn bg-vox-bg-tertiary text-vox-text-primary hover:bg-vox-bg-hover px-5 py-3 text-base"
            >
              <Monitor className="mr-2 h-5 w-5" /> Download for Windows
            </a>
            <a
              href={DOWNLOAD_URLS.macos}
              target="_blank"
              rel="noopener noreferrer"
              className="btn bg-vox-bg-tertiary text-vox-text-primary hover:bg-vox-bg-hover px-5 py-3 text-base"
            >
              <Laptop className="mr-2 h-5 w-5" /> Download for macOS
            </a>
            <a
              href={DOWNLOAD_URLS.linux}
              target="_blank"
              rel="noopener noreferrer"
              className="btn bg-vox-bg-tertiary text-vox-text-primary hover:bg-vox-bg-hover px-5 py-3 text-base"
            >
              <Terminal className="mr-2 h-5 w-5" /> Download for Linux
            </a>
          </div>

          <p
            className="mt-4 text-sm text-vox-text-muted animate-slide-up"
            style={{ animationDelay: '0.3s', animationFillMode: 'backwards' }}
          >
            Or{' '}
            <Link to="/register" className="text-vox-accent-primary hover:underline">
              launch in your browser
            </Link>
          </p>
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
                        <p className="text-xs text-vox-text-primary leading-snug">P2P is the way 🚀</p>
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

function Features() {
  return (
    <section className="relative bg-vox-bg-secondary py-24">
      {/* Particle separator at top */}
      <ParticlesSvg className="absolute top-0 left-0 w-full h-16" />

      <div className="max-w-7xl mx-auto px-6">
        <h2 className="text-3xl sm:text-4xl font-bold text-vox-text-primary text-center mb-4">
          Everything you need
        </h2>
        <p className="text-vox-text-secondary text-center mb-16 max-w-2xl mx-auto">
          Voice, text, and community — all in one place, with no compromises on privacy or performance.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((f) => (
            <div
              key={f.title}
              className="group rounded-xl border border-vox-border bg-vox-bg-primary p-6 hover:border-vox-accent-primary/60 transition-all duration-300 hover:shadow-lg hover:shadow-vox-accent-primary/5"
            >
              <div className="h-12 w-12 rounded-lg bg-gradient-to-br from-[#5B21B6]/20 to-[#3B82F6]/20 flex items-center justify-center mb-4 group-hover:from-[#5B21B6]/30 group-hover:to-[#3B82F6]/30 transition-all duration-300">
                <f.icon className="h-6 w-6 text-vox-accent-primary" />
              </div>
              <h3 className="text-lg font-semibold text-vox-text-primary mb-2">
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

function WhyVoxium() {
  return (
    <section className="relative bg-vox-bg-primary py-24 overflow-hidden">
      {/* Decorative orbit rings */}
      <OrbitRingsSvg className="absolute -right-32 top-1/2 -translate-y-1/2 w-[500px] h-[500px] opacity-40 hidden lg:block" />

      <div className="relative z-10 max-w-7xl mx-auto px-6">
        <h2 className="text-3xl sm:text-4xl font-bold text-vox-text-primary text-center mb-16">
          Why Voxium?
        </h2>

        {/* Value props */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-10 mb-20">
          {[
            {
              icon: Lock,
              title: 'You Own Your Data',
              description: 'Self-host or use our servers — either way, your data belongs to you. No mining, no selling.',
            },
            {
              icon: Code2,
              title: 'Open Source',
              description: 'Every line of code is public. Audit it, fork it, contribute to it. Full transparency.',
            },
            {
              icon: HeartHandshake,
              title: 'Community-Driven',
              description: 'Built by the community, for the community. Features are shaped by the people who use them.',
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
            <h3 className="text-xl font-semibold text-vox-text-primary mb-4">Built different</h3>
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

function FinalCTA() {
  return (
    <section className="relative py-24 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-[#5B21B6]/20 via-vox-bg-primary to-vox-bg-secondary" />
      {/* Decorative orbit */}
      <OrbitRingsSvg className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] opacity-20" />

      <div className="relative z-10 max-w-3xl mx-auto px-6 text-center">
        <img src="/logo.svg" alt="" className="h-16 w-16 rounded-2xl mx-auto mb-8" />
        <h2 className="text-3xl sm:text-4xl font-bold text-vox-text-primary mb-4">
          Ready to experience communication, reimagined?
        </h2>
        <p className="text-vox-text-secondary mb-10 text-lg">
          Join the open communication revolution. No credit card. No subscription.
        </p>
        <div className="flex flex-wrap gap-4 justify-center">
          <Link to="/register" className="btn-primary px-8 py-3 text-base">
            Get Started — It's Free
          </Link>
          <a href="#hero" className="btn-secondary px-8 py-3 text-base">
            Download the App
          </a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
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
              Open, privacy-first voice and text communication.
            </p>
          </div>

          {/* Product */}
          <div>
            <h4 className="text-sm font-semibold text-vox-text-primary mb-3">Product</h4>
            <ul className="space-y-2">
              <li><a href="#hero" className="text-sm text-vox-text-muted hover:text-vox-text-primary transition-colors">Download</a></li>
              <li><a href="#" onClick={(e) => e.preventDefault()} className="text-sm text-vox-text-muted hover:text-vox-text-primary transition-colors">Changelog</a></li>
              <li><a href="#" onClick={(e) => e.preventDefault()} className="text-sm text-vox-text-muted hover:text-vox-text-primary transition-colors">Status</a></li>
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h4 className="text-sm font-semibold text-vox-text-primary mb-3">Legal</h4>
            <ul className="space-y-2">
              <li><a href="#" onClick={(e) => e.preventDefault()} className="text-sm text-vox-text-muted hover:text-vox-text-primary transition-colors">Privacy Policy</a></li>
              <li><a href="#" onClick={(e) => e.preventDefault()} className="text-sm text-vox-text-muted hover:text-vox-text-primary transition-colors">Terms of Service</a></li>
            </ul>
          </div>

          {/* Community */}
          <div>
            <h4 className="text-sm font-semibold text-vox-text-primary mb-3">Community</h4>
            <ul className="space-y-2">
              <li><a href="#" onClick={(e) => e.preventDefault()} className="text-sm text-vox-text-muted hover:text-vox-text-primary transition-colors">GitHub</a></li>
              <li><a href="#" onClick={(e) => e.preventDefault()} className="text-sm text-vox-text-muted hover:text-vox-text-primary transition-colors">Contributing</a></li>
            </ul>
          </div>
        </div>
      </div>

      {/* Copyright bar */}
      <div className="border-t border-vox-border">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <p className="text-xs text-vox-text-muted text-center">
            &copy; 2026 Voxium. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}

/* ─── Main Export ─── */

export function LandingPage() {
  useEffect(() => {
    document.documentElement.classList.add('landing-scroll');
    return () => {
      document.documentElement.classList.remove('landing-scroll');
    };
  }, []);

  return (
    <div className="bg-vox-bg-primary text-vox-text-primary">
      <Navbar />
      <Hero />
      <Features />
      <WhyVoxium />
      <FinalCTA />
      <Footer />
    </div>
  );
}
