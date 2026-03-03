interface PeekingThiefProps {
  isWatching: boolean;
}

export function PeekingThief({ isWatching }: PeekingThiefProps) {
  return (
    <div
      className="absolute left-1/2 -translate-x-1/2 -top-[52px] z-10 pointer-events-none"
      style={{
        transition: 'transform 0.3s ease',
        transform: `translateX(-50%) translateY(${isWatching ? '-4px' : '0px'})`,
      }}
    >
      <style>{`
        @keyframes thief-blink {
          0%, 90%, 100% { transform: scaleY(1); }
          95% { transform: scaleY(0.1); }
        }
        @keyframes thief-eye-shake {
          0%, 100% { transform: translate(0, 0); }
          15% { transform: translate(-1.2px, 0.5px); }
          30% { transform: translate(1px, -0.3px); }
          45% { transform: translate(-0.8px, 0.8px); }
          60% { transform: translate(1.2px, 0.3px); }
          75% { transform: translate(-0.5px, -0.5px); }
          90% { transform: translate(0.8px, 0.6px); }
        }
        .thief-eye-idle {
          animation: thief-blink 3s ease-in-out infinite;
        }
        .thief-eye-watching {
          animation: thief-eye-shake 0.4s ease-in-out 1;
        }
      `}</style>
      <svg width="120" height="70" viewBox="0 0 120 70" fill="none" xmlns="http://www.w3.org/2000/svg">
        {/* Beanie / hat */}
        <ellipse cx="60" cy="12" rx="32" ry="12" fill="#1a1a2e" />
        <rect x="28" y="8" width="64" height="10" rx="4" fill="#1a1a2e" />
        {/* Beanie fold/brim */}
        <rect x="26" y="14" width="68" height="7" rx="3.5" fill="#2d2d4a" />
        {/* Small beanie pom-pom */}
        <circle cx="60" cy="4" r="5" fill="#2d2d4a" />

        {/* Face */}
        <ellipse cx="60" cy="38" rx="28" ry="22" fill="#f0d0a0" />

        {/* Eye mask */}
        <path
          d="M32 32 Q60 26 88 32 Q88 42 60 44 Q32 42 32 32Z"
          fill="#1a1a2e"
          opacity="0.9"
        />

        {/* Left eye */}
        <g
          className={isWatching ? 'thief-eye-watching' : 'thief-eye-idle'}
          style={{ transformOrigin: '46px 36px' }}
        >
          <ellipse
            cx="46"
            cy={isWatching ? 37 : 36}
            rx={isWatching ? 9 : 6}
            ry={isWatching ? 9 : 6}
            fill="white"
            style={{ transition: 'rx 0.3s ease, ry 0.3s ease, cy 0.3s ease' }}
          />
          {/* Pupil — looks down when watching */}
          <circle
            cx={isWatching ? 46 : 43}
            cy={isWatching ? 40 : 36}
            r={isWatching ? 4.5 : 3}
            fill="#1a1a2e"
            style={{ transition: 'cx 0.3s ease, cy 0.3s ease, r 0.3s ease' }}
          />
          {/* Eye glint */}
          <circle
            cx={isWatching ? 48 : 45}
            cy={isWatching ? 38 : 34}
            r="1.5"
            fill="white"
            opacity="0.8"
            style={{ transition: 'cx 0.3s ease, cy 0.3s ease' }}
          />
        </g>

        {/* Right eye */}
        <g
          className={isWatching ? 'thief-eye-watching' : 'thief-eye-idle'}
          style={{ transformOrigin: '74px 36px' }}
        >
          <ellipse
            cx="74"
            cy={isWatching ? 37 : 36}
            rx={isWatching ? 9 : 6}
            ry={isWatching ? 9 : 6}
            fill="white"
            style={{ transition: 'rx 0.3s ease, ry 0.3s ease, cy 0.3s ease' }}
          />
          {/* Pupil — looks down when watching */}
          <circle
            cx={isWatching ? 74 : 71}
            cy={isWatching ? 40 : 36}
            r={isWatching ? 4.5 : 3}
            fill="#1a1a2e"
            style={{ transition: 'cx 0.3s ease, cy 0.3s ease, r 0.3s ease' }}
          />
          {/* Eye glint */}
          <circle
            cx={isWatching ? 76 : 73}
            cy={isWatching ? 38 : 34}
            r="1.5"
            fill="white"
            opacity="0.8"
            style={{ transition: 'cx 0.3s ease, cy 0.3s ease' }}
          />
        </g>

        {/* Hands gripping card edge */}
        {/* Left hand */}
        <g>
          <rect x="22" y="56" width="14" height="14" rx="4" fill="#e8c090" />
          {/* Fingers */}
          <rect x="22" y="56" width="4" height="10" rx="2" fill="#e8c090" />
          <rect x="27" y="54" width="4" height="12" rx="2" fill="#e8c090" />
          <rect x="32" y="56" width="4" height="10" rx="2" fill="#e8c090" />
        </g>
        {/* Right hand */}
        <g>
          <rect x="84" y="56" width="14" height="14" rx="4" fill="#e8c090" />
          {/* Fingers */}
          <rect x="84" y="56" width="4" height="10" rx="2" fill="#e8c090" />
          <rect x="89" y="54" width="4" height="12" rx="2" fill="#e8c090" />
          <rect x="94" y="56" width="4" height="10" rx="2" fill="#e8c090" />
        </g>
      </svg>
    </div>
  );
}
