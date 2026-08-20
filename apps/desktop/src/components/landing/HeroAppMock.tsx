import { Search, Plus, Volume2, Mic, Headphones, AudioLines } from 'lucide-react';

/**
 * Animated miniature of the real app shell for the landing hero — a faithful
 * scale model of the 2026 redesign: communities as tabs in the spaces strip
 * along the top, then the sidebar column (channel list, occupied-voice card,
 * signed-in user card) sitting directly on the page background next to the
 * floating rounded chat panel.
 *
 * Keep in sync with SpacesStrip / ChannelSidebar / UserCard / MainLayout —
 * this mock is the first screenshot most visitors ever see of the product.
 */
export function HeroAppMock() {
  return (
    <>
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
        @keyframes mockEq {
          0%, 100% { transform: scaleY(0.4); }
          50% { transform: scaleY(1); }
        }
        .mock-msg-1 { animation: mockMsgIn 0.4s ease-out 0.8s backwards; }
        .mock-msg-2 { animation: mockMsgIn 0.4s ease-out 1.8s backwards; }
        .mock-msg-3 { animation: mockMsgIn 0.4s ease-out 4s backwards; }
        .mock-reaction { animation: mockReactionPop 0.3s ease-out 3s backwards; }
        .mock-typing-dot { animation: mockTypingDot 1.2s ease-in-out infinite; }
        .mock-cursor { animation: mockCursorBlink 1s step-end infinite; }
        .mock-speak-ring { animation: mockSpeakRing 1.5s ease-in-out infinite; }
        .mock-online { animation: mockOnlinePulse 2s ease-in-out infinite; }
        .mock-online-d { animation: mockOnlinePulse 2s ease-in-out 1s infinite; }
        .mock-eq-1 { transform-origin: bottom; animation: mockEq 1.1s ease-in-out infinite; }
        .mock-eq-2 { transform-origin: bottom; animation: mockEq 1.3s ease-in-out 0.15s infinite; }
        .mock-eq-3 { transform-origin: bottom; animation: mockEq 0.9s ease-in-out 0.3s infinite; }
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

          {/* Spaces strip — communities as tabs along the top */}
          <div data-testid="hero-mock-strip" className="flex items-center gap-1 bg-vox-bg-primary px-2 py-1.5">
            <img src="/logo_static.svg" alt="" className="h-5 w-5 rounded-md" />
            <div className="mx-0.5 h-4 w-px bg-vox-border" />
            {/* Active space — expanded tab carrying its name */}
            <div className="flex h-7 items-center gap-1.5 rounded-lg border border-vox-border bg-vox-chat px-1.5 pr-2.5">
              <span
                className="flex h-[18px] w-[18px] items-center justify-center rounded-md text-[7px] font-semibold text-white"
                style={{ backgroundImage: 'linear-gradient(135deg, hsl(258 62% 46%), hsl(240 70% 38%))' }}
              >
                VH
              </span>
              <span className="whitespace-nowrap text-[10px] font-semibold text-vox-text-primary">Voxium HQ</span>
            </div>
            {/* Space with live voice — the equalizer pulse */}
            <div className="flex h-7 items-center gap-1 rounded-lg px-1.5">
              <span
                className="flex h-[18px] w-[18px] items-center justify-center rounded-md text-[7px] font-semibold text-white"
                style={{ backgroundImage: 'linear-gradient(135deg, hsl(230 62% 46%), hsl(212 70% 38%))' }}
              >
                GS
              </span>
              <span className="flex h-2 items-end gap-[1.5px]" aria-hidden>
                <i className="mock-eq-1 w-[2px] rounded-full bg-vox-accent-primary" style={{ height: '45%' }} />
                <i className="mock-eq-2 w-[2px] rounded-full bg-vox-accent-primary" style={{ height: '95%' }} />
                <i className="mock-eq-3 w-[2px] rounded-full bg-vox-accent-primary" style={{ height: '65%' }} />
              </span>
            </div>
            {/* Space with unreads */}
            <div className="relative flex h-7 items-center rounded-lg px-1.5">
              <span
                className="flex h-[18px] w-[18px] items-center justify-center rounded-md text-[7px] font-semibold text-white"
                style={{ backgroundImage: 'linear-gradient(135deg, hsl(220 62% 46%), hsl(217 70% 38%))' }}
              >
                AR
              </span>
              <span className="absolute right-0 top-0.5 flex h-[11px] min-w-[11px] items-center justify-center rounded-full bg-vox-accent-primary px-0.5 text-[7px] font-bold text-vox-on-accent">
                3
              </span>
            </div>
            {/* Overflow — the long tail, one click away */}
            <div className="flex h-7 items-center rounded-lg border border-dashed border-vox-border px-1.5 text-[9px] text-vox-text-muted">
              +2
            </div>
            <div className="min-w-0 flex-1" />
            <div className="flex h-6 items-center gap-1 whitespace-nowrap rounded-full border border-vox-border px-2 text-[9px] text-vox-text-muted">
              <Search className="h-2.5 w-2.5" />
              Find a space
            </div>
            <div className="flex h-6 w-6 items-center justify-center rounded-full border border-vox-border text-vox-text-muted">
              <Plus className="h-3 w-3" />
            </div>
          </div>

          {/* Panels float on the page background with small gutters */}
          <div className="flex gap-1.5 bg-vox-bg-primary p-1.5 pt-1" style={{ height: 300 }}>
            {/* Sidebar column — channels, voice card, user card, on the page */}
            <div className="flex w-[148px] flex-none flex-col min-h-0">
              <div className="flex items-baseline px-1.5 pb-1">
                <span className="truncate text-[10px] font-semibold text-vox-text-primary">Voxium HQ</span>
                <span className="ml-auto shrink-0 text-[8px] text-vox-text-muted">4 online</span>
              </div>
              <div className="px-1.5 pb-0.5 text-[8px] font-semibold uppercase tracking-wider text-vox-text-muted">Text</div>
              <div className="space-y-0.5 px-0.5">
                <div className="flex items-center gap-1.5 rounded-md bg-vox-accent-tint px-1.5 py-[3px] text-[10px] font-semibold text-vox-text-primary">
                  <span className="font-mono text-vox-accent-primary">#</span>general
                </div>
                <div className="flex items-center gap-1.5 px-1.5 py-[3px] text-[10px] text-vox-text-muted">
                  <span className="font-mono text-vox-text-muted/70">#</span>music
                </div>
                <div className="flex items-center gap-1.5 px-1.5 py-[3px] text-[10px] text-vox-text-muted">
                  <span className="font-mono text-vox-text-muted/70">#</span>dev
                </div>
              </div>
              <div className="px-1.5 pb-0.5 pt-2 text-[8px] font-semibold uppercase tracking-wider text-vox-text-muted">Voice</div>
              {/* Occupied voice channel — the elevated card with a Join affordance */}
              <div data-testid="hero-mock-voice-card" className="mx-0.5 overflow-hidden rounded-lg border border-vox-border bg-vox-bg-floating">
                <div className="flex items-center gap-1 px-1.5 pb-0.5 pt-1">
                  <Volume2 className="h-2.5 w-2.5 shrink-0 text-vox-text-primary" />
                  <span className="truncate text-[9.5px] font-semibold text-vox-text-primary">Lounge</span>
                  <span className="ml-auto text-[8px] tabular-nums text-vox-text-muted">2</span>
                </div>
                <div className="space-y-px px-1">
                  <div className="flex items-center gap-1.5 rounded px-1 py-0.5">
                    <div className="mock-speak-ring h-3.5 w-3.5 shrink-0 rounded-full bg-vox-accent-success" />
                    <span className="flex-1 truncate text-[9px] text-vox-text-primary">Alice</span>
                    <AudioLines className="h-2 w-2 shrink-0 text-vox-accent-success" />
                  </div>
                  <div className="flex items-center gap-1.5 rounded px-1 py-0.5">
                    <div className="h-3.5 w-3.5 shrink-0 rounded-full bg-vox-accent-primary" />
                    <span className="flex-1 truncate text-[9px] text-vox-text-secondary">Bob</span>
                  </div>
                </div>
                <div className="px-1 pb-1 pt-0.5">
                  <div className="flex h-[18px] items-center justify-center rounded-md bg-vox-accent-tint text-[8.5px] font-semibold text-vox-accent-primary">
                    Join voice
                  </div>
                </div>
              </div>
              <div className="min-h-0 flex-1" />
              {/* Signed-in user card */}
              <div data-testid="hero-mock-user-card" className="flex items-center gap-1.5 rounded-lg border border-vox-border bg-vox-bg-secondary px-1.5 py-1">
                <div className="relative shrink-0">
                  <div className="h-5 w-5 rounded-full bg-vox-accent-warning" />
                  <div className="mock-online absolute -bottom-px -right-px h-2 w-2 rounded-full border border-vox-bg-secondary bg-vox-accent-success" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[9px] font-semibold leading-tight text-vox-text-primary">Charlie</p>
                  <p className="truncate text-[7.5px] leading-tight text-vox-text-muted">Online</p>
                </div>
                <Mic className="h-2.5 w-2.5 shrink-0 text-vox-text-muted" />
                <Headphones className="h-2.5 w-2.5 shrink-0 text-vox-text-muted" />
              </div>
            </div>

            {/* Chat — a floating rounded panel */}
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-vox-border bg-vox-chat">
              <div className="flex items-center gap-1 border-b border-vox-border px-2.5 py-1.5">
                <span className="font-mono text-[10px] text-vox-accent-primary">#</span>
                <span className="text-[10px] font-semibold text-vox-text-primary">general</span>
              </div>
              {/* Messages */}
              <div className="flex flex-1 flex-col justify-end gap-2.5 overflow-hidden p-3">
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
    </>
  );
}
