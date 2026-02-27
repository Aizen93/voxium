## Quality-of-life (low effort, high polish):
  - [x] Stabilizing the code, with better error handling and exception management. User friendly and smoother UI.  
  - [x] Push-to-talk — alternative to voice activity; just a keybind that mutes/unmutes, easy to add alongside the existing mute logic
  - [x] Notification sounds — play a tone on join/leave/message; the audio infrastructure is already there
  - [x] Unread indicators / mention badges — channel list currently has no unread state, which makes multi-channel usage painful
  - [x] When a new User joins the server, the members list is not updating in real time and needs a page refresh to see the new user in the members list (Right side panel)
  - [x] When a user (Alice) creates a new server, and joins a channel, she can't see her name in the channel list (Though she can speak and hear just fine)
  - [x] When creating a new voice channel or a new text channel, the other users does not see it in real time and require a page refresh
  - [] Tauri client does not receive windows notifications, how do we activate them by default, or prompt the user to activate notifications. Our apps Settings has notifications enabled.
  - [x] Security : Throtling, xss, sql injections, and rate limiting, captcha. Rate limiting — rate-limiter-flexible is installed but not wired up. Protect auth, uploads, message send, and forgot-password endpoints.
  - [x] Password forgot + profile password change

## Core chat features (medium effort):
  - [] File & image uploads — drag-and-drop or paste images into chat, preview inline. Needs a storage backend (S3/local) and a new message — S3 infrastructure already exists. Add attachments to Message model, multer handler in messages route, drag-and-drop + paste in MessageInput, inline previews in
  - [x] Message reactions — emoji reactions on messages; very common expectation for a chat app
  - [x] Message editing & deletion UI — the server events (message:update, message:delete) are already wired, but I didn't see an edit/delete UI in the chat bubbles
  - [] Message search — PostgreSQL full-text search (tsvector on message.content). Search modal with filters by channel/author/date. High ROI for any server with history.

## Bigger features (high effort, high value):
  - [x] Direct messages (DMs) — 1:1 and group DMs outside of servers; this is a significant architecture addition but is probably the most-expected missing feature
  - [] Screen sharing — the WebRTC peer connections are already set up; adding a video track for screen capture is a natural extension
  - [] Server roles & permissions — the MemberRole type exists (owner/admin/member) but I didn't see permission checks on the client for things like channel creation or member management



Quick Wins (high impact, low effort)

  1. [x] Server startup env var validation — S3 env vars use ! assertions; missing vars cause cryptic AWS errors. Add validation at boot.
  2. [x] PublicUser type — member:joined sends email: '' to satisfy the User type. A PublicUser (omitting email) fixes this properly.
  3. [x] Debounce PTT state broadcasts — Rapid PTT toggles flood the server:{id} room with voice:state_update. A 100ms debounce would cut traffic significantly.
  4. [x] Cleanup stale Prisma columns — Invite.maxUses and Invite.uses are unused. Quick migration to drop them.

  High-Value Features (medium effort)

  MessageItem. This is the biggest "expected feature" that's missing.
  7. Channel categories — New ChannelCategory model with collapsible headers in ChannelSidebar. Small effort, big polish for servers with 10+ channels.
  8. Rich text / Markdown — Discord-style formatting (bold, italics, code blocks, links). Store raw markdown, render with react-markdown.

  Security (should ship before any public release)
  10. [x] sanitization — Currently relying on JSX escaping alone. Add explicit sanitization for messages, bios, and server names.

  Strategic / Longer-Term

  11. Server roles & permissions UI — Role model exists in DB but has no management UI or granular permission enforcement.
  12. Screen sharing — WebRTC peers are already established; adding getDisplayMedia() as a second track is feasible without SFU.
  13. mediasoup SFU — Needed to scale voice beyond ~8 users per channel.