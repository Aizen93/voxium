/** Animated background decoration shared by Login and Register pages */
export function AuthBackground() {
  return (
    <>
      {/* Radial gradient glow — large, offset slightly up-left so it's visible around the card */}
      <div
        className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[900px] h-[900px] rounded-full opacity-20 pointer-events-none"
        style={{ background: 'radial-gradient(circle, #5b5bf7 0%, transparent 70%)' }}
      />

      {/* Orbit rings — top-right, offset so they peek around the card corner */}
      <svg
        className="absolute -top-16 -right-16 w-[500px] h-[500px] opacity-40 pointer-events-none"
        viewBox="0 0 400 400"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <style>{`
          @keyframes authSpin1{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
          @keyframes authSpin2{0%{transform:rotate(0deg)}100%{transform:rotate(-360deg)}}
          @keyframes authOrbPulse{0%,100%{opacity:0.3}50%{opacity:0.7}}
          .auth-orb1{animation:authSpin1 20s linear infinite;transform-origin:200px 200px}
          .auth-orb2{animation:authSpin2 28s linear infinite;transform-origin:200px 200px}
          .auth-orb3{animation:authSpin1 35s linear infinite;transform-origin:200px 200px}
          .auth-orb-dot{animation:authOrbPulse 2s ease-in-out infinite}
        `}</style>
        <defs>
          <linearGradient id="authOrbGrad" x1="100" y1="100" x2="300" y2="300" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#5B21B6" />
            <stop offset="100%" stopColor="#3B82F6" />
          </linearGradient>
        </defs>
        {/* Ring 1 */}
        <g className="auth-orb1">
          <ellipse cx="200" cy="200" rx="140" ry="60" stroke="#5b5bf7" strokeWidth="1.5" opacity="0.3" transform="rotate(-20 200 200)" />
          <circle cx="340" cy="200" r="5" fill="#A78BFA" className="auth-orb-dot" transform="rotate(-20 200 200)" />
        </g>
        {/* Ring 2 */}
        <g className="auth-orb2">
          <ellipse cx="200" cy="200" rx="110" ry="45" stroke="#A78BFA" strokeWidth="1.5" opacity="0.25" transform="rotate(30 200 200)" />
          <circle cx="310" cy="200" r="4" fill="#60A5FA" className="auth-orb-dot" transform="rotate(30 200 200)" />
        </g>
        {/* Ring 3 */}
        <g className="auth-orb3">
          <ellipse cx="200" cy="200" rx="170" ry="70" stroke="#60A5FA" strokeWidth="1" opacity="0.2" transform="rotate(10 200 200)" />
          <circle cx="370" cy="200" r="3" fill="#5b5bf7" className="auth-orb-dot" transform="rotate(10 200 200)" />
        </g>
        {/* Center glow */}
        <circle cx="200" cy="200" r="8" fill="url(#authOrbGrad)" opacity="0.6" />
      </svg>

      {/* Second set of orbit rings — bottom-left */}
      <svg
        className="absolute -bottom-24 -left-24 w-[450px] h-[450px] opacity-30 pointer-events-none"
        viewBox="0 0 400 400"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <style>{`
          .auth-orb1b{animation:authSpin2 24s linear infinite;transform-origin:200px 200px}
          .auth-orb2b{animation:authSpin1 32s linear infinite;transform-origin:200px 200px}
        `}</style>
        <g className="auth-orb1b">
          <ellipse cx="200" cy="200" rx="130" ry="55" stroke="#A78BFA" strokeWidth="1.5" opacity="0.25" transform="rotate(15 200 200)" />
          <circle cx="330" cy="200" r="4" fill="#5b5bf7" className="auth-orb-dot" transform="rotate(15 200 200)" />
        </g>
        <g className="auth-orb2b">
          <ellipse cx="200" cy="200" rx="160" ry="65" stroke="#5b5bf7" strokeWidth="1" opacity="0.18" transform="rotate(-10 200 200)" />
          <circle cx="360" cy="200" r="3" fill="#A78BFA" className="auth-orb-dot" transform="rotate(-10 200 200)" />
        </g>
      </svg>
    </>
  );
}
