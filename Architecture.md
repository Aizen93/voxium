# Voxium - Architecture Document

## Table of Contents

1. [System Overview](#system-overview)
2. [High-Level Architecture](#high-level-architecture)
3. [Technology Stack](#technology-stack)
4. [Backend Architecture](#backend-architecture)
5. [Frontend Architecture](#frontend-architecture)
6. [Database Design](#database-design)
7. [Real-Time Communication](#real-time-communication)
8. [Voice Architecture](#voice-architecture)
9. [Authentication & Security](#authentication--security)
10. [Scalability Strategy](#scalability-strategy)
11. [Deployment Architecture](#deployment-architecture)
12. [Future Architecture](#future-architecture)

---

## System Overview

Voxium is a real-time communication platform enabling users to create communities (servers), organize conversations into channels, and communicate via text messages and voice chat. The system is designed to handle 1,000+ concurrent users in V1, with a clear path to scale to millions.

### Core Principles

- **Real-time first:** All interactions are immediately reflected across connected clients
- **Low latency:** Voice and messaging prioritize sub-100ms delivery
- **Horizontal scalability:** Stateless services behind load balancers
- **Cross-platform:** Single codebase serves Windows, macOS, Linux (and future mobile)
- **Security:** JWT auth, input validation, rate limiting, CORS protection

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                           CLIENTS                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────────┐  │
│  │ Windows  │  │  macOS   │  │  Linux   │  │ Web (future)       │  │
│  │ (Tauri)  │  │ (Tauri)  │  │ (Tauri)  │  │ (same React app)  │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬───────────┘  │
│       │              │              │                  │              │
│       └──────────────┴──────────────┴──────────────────┘              │
│                              │                                        │
│               ┌──────────────┴──────────────┐                        │
│               │    HTTPS + WebSocket        │                        │
│               │    (REST API + Socket.IO)   │                        │
│               └──────────────┬──────────────┘                        │
└──────────────────────────────┼───────────────────────────────────────┘
                               │
┌──────────────────────────────┼───────────────────────────────────────┐
│                         BACKEND                                       │
│               ┌──────────────┴──────────────┐                        │
│               │      Load Balancer          │                        │
│               │   (nginx / Cloudflare)      │                        │
│               └──────┬───────────┬──────────┘                        │
│                      │           │                                    │
│            ┌─────────┴──┐  ┌────┴──────────┐                        │
│            │  API Node  │  │  API Node     │  ← Horizontally        │
│            │  (Express) │  │  (Express)    │    scalable             │
│            │  Socket.IO │  │  Socket.IO    │                        │
│            └─────┬──────┘  └────┬──────────┘                        │
│                  │              │                                     │
│           ┌──────┴──────────────┴───────┐                            │
│           │     Redis (Pub/Sub +        │                            │
│           │     Presence + Cache)       │                            │
│           └──────┬──────────────────────┘                            │
│                  │                                                    │
│           ┌──────┴──────────────────────┐                            │
│           │     PostgreSQL              │                            │
│           │     (Primary data store)    │                            │
│           └─────────────────────────────┘                            │
│                                                                       │
│           ┌─────────────────────────────┐                            │
│           │     SFU Media Server        │  ← mediasoup (future)     │
│           │     (Voice/Video routing)   │                            │
│           └─────────────────────────────┘                            │
└───────────────────────────────────────────────────────────────────────┘
```

---

## Technology Stack

### Backend
| Layer | Technology | Version |
|-------|-----------|---------|
| Runtime | Node.js | 20+ |
| Language | TypeScript | 5.6+ |
| HTTP Framework | Express.js | 4.x |
| WebSocket | Socket.IO | 4.8 |
| ORM | Prisma | 6.x |
| Database | PostgreSQL | 16 |
| Cache / Pub/Sub | Redis | 7 |
| Voice (future) | mediasoup | 3.x |
| Auth | JWT (jsonwebtoken) | 9.x |
| Validation | Zod + custom validators | — |
| Password Hashing | bcryptjs | — |
| File Storage | S3-compatible (OVH) | — |
| Image Processing | sharp | — |
| File Upload | multer | — |
| Email | Nodemailer | 8.x |

### Frontend
| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | React | 19 |
| Language | TypeScript | 5.6+ |
| Build Tool | Vite | 6.x |
| Desktop Shell | Tauri | 2.x |
| Styling | Tailwind CSS | 3.4 |
| State | Zustand | 5.x |
| Routing | React Router | 7.x |
| HTTP Client | Axios | 1.x |
| WebSocket Client | socket.io-client | 4.8 |
| WebRTC | simple-peer | 9.x |
| Icons | Lucide React | — |

### Infrastructure
| Component | Technology |
|-----------|-----------|
| Containers | Docker + Docker Compose |
| Orchestration (future) | Kubernetes |
| CI/CD (future) | GitHub Actions |
| Monitoring (future) | Prometheus + Grafana |

---

## Backend Architecture

### Directory Structure

```
apps/server/
├── prisma/
│   ├── schema.prisma       # Database schema
│   └── seed.ts             # Demo data seeder
├── src/
│   ├── index.ts            # Entry point, server bootstrap
│   ├── app.ts              # Express app configuration, middleware, routes
│   ├── routes/
│   │   ├── auth.ts         # Register, login, refresh, me, forgot/reset/change password
│   │   ├── servers.ts      # CRUD servers, join/leave, members, settings
│   │   ├── channels.ts     # CRUD channels, mark-as-read
│   │   ├── messages.ts     # CRUD messages with pagination, reactions
│   │   ├── dm.ts           # DM conversations, messages, reactions, read tracking, deletion
│   │   ├── users.ts        # User profiles, profile update with real-time broadcast
│   │   ├── invites.ts      # Create/use/preview invites
│   │   ├── uploads.ts      # Avatar/server icon upload (S3) + file serving proxy
│   │   └── friends.ts      # Friend requests (send/accept/decline/remove), friendship status
│   ├── services/
│   │   └── authService.ts  # Auth business logic
│   ├── middleware/
│   │   ├── auth.ts         # JWT authentication middleware
│   │   ├── rateLimiter.ts  # Per-endpoint + per-socket rate limiting (Redis + memory fallback)
│   │   └── errorHandler.ts # Global error handler (incl. multer errors)
│   ├── websocket/
│   │   ├── socketServer.ts  # Socket.IO setup, connection handler
│   │   ├── voiceHandler.ts  # Voice channel state management
│   │   └── dmVoiceHandler.ts # DM call signaling + system messages
│   └── utils/
│       ├── prisma.ts            # Prisma client singleton
│       ├── redis.ts             # Redis client + presence helpers
│       ├── errors.ts            # Custom error classes
│       ├── sanitize.ts          # HTML stripping + text sanitization utility
│       ├── s3.ts                # S3 client + upload/stream/delete helpers + VALID_S3_KEY_RE
│       ├── email.ts             # Nodemailer transporter + password reset email
│       ├── reactions.ts         # Shared reaction aggregation (channels + DMs)
│       └── memberBroadcast.ts   # Server room join + member event broadcast
```

### Request Flow

```
Client Request
    │
    ▼
Express Middleware Pipeline
    │
    ├── helmet()          → Security headers
    ├── cors()            → CORS validation
    ├── morgan()          → Request logging
    ├── express.json()    → Body parsing
    ├── cookieParser()    → Cookie parsing
    │
    ▼
Route Handler
    │
    ├── rateLimiter()     → Per-endpoint rate limiting (Redis + memory fallback)
    ├── authenticate()    → JWT verification (protected routes)
    ├── sanitizeText()    → HTML tag stripping on user input (messages, names, bios)
    ├── Business Logic    → Database queries via Prisma
    │
    ▼
Response / Error Handler
```

### Error Handling

Custom error classes provide structured HTTP error responses:

```typescript
AppError (base)
├── BadRequestError     (400)
├── UnauthorizedError   (401)
├── ForbiddenError      (403)
├── NotFoundError       (404)
└── ConflictError       (409)
```

All unhandled errors return a generic 500 response without leaking internals.

---

## Frontend Architecture

### Directory Structure

```
apps/desktop/
├── src/
│   ├── main.tsx              # React entry point
│   ├── App.tsx               # Root component with routing
│   ├── pages/
│   │   ├── LoginPage.tsx          # Login form + forgot password link
│   │   ├── RegisterPage.tsx       # Registration form
│   │   ├── ForgotPasswordPage.tsx # Email input → sends reset link
│   │   ├── ResetPasswordPage.tsx  # Token-based new password form
│   │   └── InvitePage.tsx         # Invite preview + join
│   ├── components/
│   │   ├── layout/
│   │   │   ├── MainLayout.tsx    # 3-panel Discord-like layout
│   │   │   └── ToastContainer.tsx # Fixed-position toast notification overlay
│   │   ├── server/
│   │   │   ├── ServerSidebar.tsx      # Server icon strip (far left)
│   │   │   ├── CreateServerModal.tsx  # Create/join server with icon upload
│   │   │   ├── ServerSettingsModal.tsx # Edit server name/icon (owner only)
│   │   │   └── MemberSidebar.tsx      # Member list (far right)
│   │   ├── channel/
│   │   │   └── ChannelSidebar.tsx # Channel list (left panel)
│   │   ├── common/
│   │   │   ├── Avatar.tsx           # Shared avatar with img/initials fallback
│   │   │   ├── EmojiPicker.tsx      # Portal-based emoji picker (shared)
│   │   │   ├── UserHoverTarget.tsx  # Hover wrapper → UserProfilePopup
│   │   │   └── UserProfilePopup.tsx # User profile card with "Message" DM button
│   │   ├── chat/
│   │   │   ├── ChatArea.tsx         # Server chat container
│   │   │   ├── MessageList.tsx      # Scrollable message list
│   │   │   ├── MessageItem.tsx      # Single message with edit/delete/reactions
│   │   │   ├── MessageInput.tsx     # Message composer (channels + DMs)
│   │   │   ├── ReactionDisplay.tsx  # Reaction chips (channels + DMs)
│   │   │   └── DeleteConfirmModal.tsx # Message delete confirmation
│   │   ├── dm/
│   │   │   ├── DMList.tsx           # Conversation list with unread badges
│   │   │   ├── DMChatArea.tsx       # DM chat view + call UI
│   │   │   ├── DMMessageList.tsx    # DM scrollable messages with system msgs
│   │   │   ├── DMCallPanel.tsx      # Discord-style call UI (avatars, controls)
│   │   │   └── IncomingCallModal.tsx # Incoming call accept/decline
│   │   ├── friends/
│   │   │   ├── FriendsView.tsx     # Tabbed friends interface (Online/All/Pending/Add)
│   │   │   ├── FriendListItem.tsx  # Friend row with action buttons
│   │   │   └── AddFriendForm.tsx   # Send friend request by username
│   │   └── voice/
│   │       └── VoicePanel.tsx       # Server voice connection controls
│   ├── stores/
│   │   ├── authStore.ts      # Auth state (user, tokens)
│   │   ├── serverStore.ts    # Server/channel state
│   │   ├── chatStore.ts      # Messages and typing (channels + DMs)
│   │   ├── voiceStore.ts     # Voice connection state (server + DM calls)
│   │   ├── dmStore.ts        # DM conversations, unread tracking, deletion
│   │   ├── friendStore.ts    # Friends list, friend requests, real-time events
│   │   ├── settingsStore.ts  # Audio devices, notifications, PTT (localStorage)
│   │   └── toastStore.ts     # Toast notification queue + convenience helpers
│   ├── services/
│   │   ├── api.ts               # Axios instance with interceptors
│   │   ├── socket.ts            # Socket.IO client manager
│   │   ├── audioAnalyser.ts     # Speaking detection (server + DM mode)
│   │   └── notificationSounds.ts # Sound effects (message, join, leave, call)
│   └── styles/
│       └── globals.css       # Tailwind + custom utilities
├── src-tauri/                # Tauri Rust backend
│   ├── src/
│   │   ├── main.rs           # Desktop entry point
│   │   └── lib.rs            # Tauri setup
│   ├── Cargo.toml
│   └── tauri.conf.json       # Tauri configuration
```

### UI Layout

```
┌─────┬──────────┬─────────────────────────────┬──────────┐
│     │          │  # channel-name              │          │
│  S  │ Channels │─────────────────────────────│ Members  │
│  e  │          │                              │          │
│  r  │ # general│  [Avatar] Username    12:30  │ ─ Owner  │
│  v  │ # random │  Message content here...    │   Alice  │
│  e  │          │                              │          │
│  r  │ 🔊 Voice │  [Avatar] Username    12:31  │ ─ Admins │
│  s  │   General│  Another message...         │   Bob    │
│     │   Gaming │                              │          │
│  +  │          │                              │ ─ Members│
│     │          │                              │   Charlie│
│     │──────────│                              │          │
│     │ User ⚙  │  [Message input box]         │          │
└─────┴──────────┴─────────────────────────────┴──────────┘
│72px │  240px   │        flex-1               │  240px   │
```

**DM View** (when no server is active):

```
┌─────┬──────────┬─────────────────────────────┐
│     │          │  @ Username        📞  🔊   │
│  S  │ DMs      │─────────────────────────────│
│  e  │          │                              │
│  r  │ 🟢 Alice │  [Avatar] Alice      12:30  │
│  v  │  Last msg│  Hey, how are you?          │
│  e  │          │                              │
│  r  │ ⚫ Bob   │  [📞 Voice call ended]      │
│  s  │  Hi!     │                              │
│     │          │  [Avatar] You        12:31  │
│  +  │ 🟢 Char  │  I'm good, thanks!          │
│     │          │                              │
│     │          │  [Message input box]         │
└─────┴──────────┴─────────────────────────────┘
│72px │  240px   │        flex-1               │
```

### State Management (Zustand)

Eight independent stores, each managing a domain:

| Store | Responsibilities |
|-------|-----------------|
| `authStore` | User session, login/register/logout, token management, avatar upload, profile editing, forgot/reset/change password |
| `serverStore` | Server list, active server, channels, members, server icon upload, member profile sync, persistent unread tracking (via `ChannelRead` DB table + `unread:init` socket event) |
| `chatStore` | Messages for active channel/conversation, typing indicators, pagination, author profile sync (shared by server channels and DMs) |
| `voiceStore` | Server voice channel connection, DM call state (`dmCallConversationId`, `dmCallUsers`, `incomingCall`), mute/deaf, peer management (WebRTC). Server and DM voice are mutually exclusive. |
| `dmStore` | DM conversation list, active conversation, participant online/offline status, DM unread counts (persisted via `ConversationRead` + `dm:unread:init`), conversation deletion. Owns `clearMessages()` calls for DM view transitions. |
| `friendStore` | Friends list (accepted/pending incoming/pending outgoing), friend request CRUD, real-time friend event handlers, friendship status lookups, `showFriendsView` toggle |
| `settingsStore` | Audio devices, noise gate, notification prefs, PTT key (persisted to localStorage) |
| `toastStore` | Toast notification queue, auto-dismiss timers, convenience helpers |

### Data Flow

```
User Action → Zustand Store → API Call (Axios) → Backend Response → Store Update → React Re-render
                    │                                                    ▲
                    │          WebSocket Event ──────────────────────────┘
                    └──────── Socket.IO Emit
```

---

## Database Design

### Entity-Relationship Diagram

```
┌──────────┐    ┌────────────────┐    ┌──────────┐
│   User   │───<│ ServerMember   │>───│  Server  │
│          │    │                │    │          │
│ id       │    │ userId (PK,FK)│    │ id       │
│ username │    │ serverId(PK,FK)│    │ name     │
│ email    │    │ role           │    │ ownerId  │
│ password │    │ joinedAt       │    │ iconUrl  │
│ display  │    └────────────────┘    └────┬─────┘
│ avatarUrl│                               │
│ bio      │    ┌────────────────┐         │
│ status   │    │    Channel     │─────────┘
│ tokenVer │
│ resetTkn │
└────┬─────┘    │                │
     │          │ id             │
     │          │ name           │
     │          │ type           │
     │          │ serverId (FK)  │
     │          │ position       │
     │          └────────┬───────┘
     │                   │
     │    ┌──────────────┴───────┐
     └───>│      Message         │
          │                      │
          │ id                   │
          │ content              │
          │ type (user/system)   │
          │ channelId (FK, null) │
          │ conversationId (null)│
          │ authorId  (FK)       │
          │ editedAt             │
          │ createdAt            │
          └──────────┬───────────┘
                     │
          ┌──────────┴───────────┐
          │  MessageReaction     │
          │                      │
          │ id                   │
          │ messageId (FK)       │
          │ userId    (FK)       │
          │ emoji                │
          │ createdAt            │
          │                      │
          │ @@unique(messageId,  │
          │   userId, emoji)     │
          └──────────────────────┘

┌──────────────────┐    ┌──────────────────────┐
│     Invite       │    │    ChannelRead        │
│                  │    │                      │
│ code (PK)        │    │ userId (PK,FK)       │
│ serverId (FK)    │    │ channelId (PK,FK)    │
│ createdBy (FK)   │    │ lastReadAt           │
│ expiresAt        │    └──────────────────────┘
└──────────────────┘

┌──────────────────────┐    ┌──────────────────────┐
│   Conversation       │    │  ConversationRead    │
│                      │    │                      │
│ id                   │    │ userId (PK,FK)       │
│ user1Id (FK)         │    │ conversationId(PK,FK)│
│ user2Id (FK)         │    │ lastReadAt           │
│ updatedAt            │    └──────────────────────┘
│                      │
│ @@unique(user1Id,    │    user1Id < user2Id invariant
│   user2Id)           │    for deduplication
└──────────────────────┘
```

### Key Indexes

- `messages(channelId, createdAt)` — Fast message pagination per channel
- `messages(conversationId, createdAt)` — Fast message pagination per DM conversation
- `message_reactions(messageId)` — Reaction aggregation per message
- `message_reactions(messageId, userId, emoji)` UNIQUE — One reaction per user per emoji
- `users(username)` UNIQUE — Username lookup
- `users(email)` UNIQUE — Email lookup
- `users(reset_token)` UNIQUE — Password reset token lookup
- `server_members(userId, serverId)` COMPOSITE PK — Membership checks
- `channel_reads(userId, channelId)` COMPOSITE PK — Read position lookups
- `conversations(user1Id, user2Id)` UNIQUE — Conversation dedup
- `conversation_reads(userId, conversationId)` COMPOSITE PK — DM read positions
- `invites(code)` PK — Invite lookup

### Scaling Considerations

- Messages use cursor-based pagination (`createdAt < ?`) instead of offset-based for consistent performance
- The `ServerMember` junction table allows efficient membership queries in both directions
- Channel positions are integer-based for simple reordering
- Unread counts computed via a single raw SQL query on connect, leveraging the existing `messages(channelId, createdAt)` index. `ChannelRead` table stores per-user read positions for persistence across sessions.

---

## Real-Time Communication

### Socket.IO Architecture

```
Client                          Server
  │                               │
  │── connect (with JWT) ────────>│
  │                               │── verify JWT
  │                               │── setUserOnline(Redis)
  │                               │── join server:{id} rooms
  │                               │── join channel:{id} rooms (all text channels)
  │                               │── compute unread counts (SQL)
  │<── unread:init ──────────────<│── emit unreads (if any)
  │                               │── broadcast presence:update
  │<── connected ─────────────────│
  │                               │
  │── channel:join ──────────────>│── socket.join(room) (for newly created channels)
  │── typing:start ──────────────>│── broadcast to channel room
  │── typing:stop ───────────────>│── broadcast to channel room
  │                               │
  │<── message:new ──────────────<│  (after HTTP POST creates message,
  │<── presence:update ──────────<│   server broadcasts via Socket.IO)
  │                               │
  │── voice:join ────────────────>│── track voice state
  │                               │── broadcast voice:user_joined
  │── voice:signal ──────────────>│── relay to target peer
  │<── voice:signal ─────────────<│── (from another peer)
  │                               │
  │                               │
  │── dm:join ──────────────────>│── verify membership (DB)
  │                               │── socket.join(dm:{id})
  │── dm:typing:start ──────────>│── broadcast to dm room
  │                               │
  │<── dm:message:new ──────────<│  (after HTTP POST)
  │<── dm:unread:init ──────────<│  (on connect, persistent DM unreads)
  │                               │
  │── dm:voice:join ────────────>│── verify participant, track state
  │                               │── broadcast dm:voice:offer/joined
  │── dm:voice:signal ──────────>│── relay to other participant
  │                               │
  │── disconnect ────────────────>│── setUserOffline(Redis)
  │                               │── broadcast presence:update
  │                               │── cleanup DM voice state
```

### Room Strategy

| Room Pattern | Purpose | When Joined |
|-------------|---------|-------------|
| `server:{id}` | Server-wide events (member join/leave, presence, voice) | On socket connect (all memberships) + dynamically on server create/join via `memberBroadcast.ts` |
| `channel:{id}` | Channel-specific events (messages, typing) | Auto-joined on socket connect for all text channels the user is a member of. Client also emits `channel:join` when selecting a channel (needed for channels created after connect). **Never left** — the socket stays subscribed for the connection's lifetime so `message:new` events reach the client for unread tracking. |
| `voice:{id}` | Voice channel (voice state, signaling) | Client emits `voice:join` when joining voice |
| `dm:{id}` | DM messages, typing, reactions | Auto-joined on socket connect for all conversations; `dm:join` emitted for new conversations. Authorization verified via DB query before joining. |
| `dm:voice:{id}` | DM call signaling | Joined on `dm:voice:join`, left on call end |

**Critical invariants:**
- Every code path that makes a user a server member (create, join, invite) must also add their socket(s) to the `server:{id}` room and seed `ChannelRead` records for all text channels (`lastReadAt = now()`). Failure to join the room breaks all server-scoped real-time features; missing ChannelRead records cause existing message history to show as unread.
- `channel:leave` must NOT be emitted by the client — it undoes the server's auto-subscription, breaking `message:new` delivery for that channel. Since the socket stays in all channel rooms, typing events are filtered by `channelId` on the frontend.
- `dm:join` must verify conversation membership via DB query before adding the socket to the room — prevents eavesdropping. `dm:typing` handlers must check `socket.rooms.has()` to prevent unauthorized emission.
- DM voice event handlers on the frontend must guard by `conversationId === dmCallConversationId` — the socket receives events for ALL conversations it's subscribed to, so unguarded handlers would leak voice events from other conversations into the active call state.
- Server voice and DM voice are mutually exclusive: `voice:join` on server triggers `leaveCurrentDMVoiceChannel()`, and `dm:voice:join` triggers `leaveCurrentVoiceChannel()`. Both server and client enforce this.

### Event Types

**Server → Client:**
- `message:new` / `message:update` / `message:delete` / `message:reaction_update`
- `channel:created` / `channel:deleted`
- `member:joined` / `member:left`
- `presence:update`
- `voice:user_joined` / `voice:user_left` / `voice:state_update` / `voice:speaking`
- `voice:signal` (WebRTC signaling relay)
- `typing:start` / `typing:stop`
- `server:updated` (server name/icon changed)
- `user:updated` (user displayName/avatar changed)
- `unread:init` (persistent unread counts on connect/reconnect)
- `dm:message:new` / `dm:message:update` / `dm:message:delete` / `dm:message:reaction_update`
- `dm:typing:start` / `dm:typing:stop`
- `dm:unread:init` (persistent DM unread counts)
- `dm:voice:offer` / `dm:voice:joined` / `dm:voice:left` / `dm:voice:ended`
- `dm:voice:state_update` / `dm:voice:speaking` / `dm:voice:signal`
- `dm:conversation:deleted`
- `friend:request_received` / `friend:request_accepted` / `friend:removed`

**Client → Server:**
- `channel:join` (for newly created channels only; `channel:leave` is NOT used — auto-subscription persists)
- `voice:join` / `voice:leave` / `voice:mute` / `voice:deaf` / `voice:speaking`
- `voice:signal` (WebRTC signaling relay)
- `typing:start` / `typing:stop`
- `dm:join` (join DM room for new conversation, with authorization check)
- `dm:typing:start` / `dm:typing:stop`
- `dm:voice:join` / `dm:voice:leave` / `dm:voice:mute` / `dm:voice:deaf` / `dm:voice:speaking`
- `dm:voice:signal` (WebRTC signaling relay for DM calls)

---

## Voice Architecture

### Current Implementation (V0.1 - Mesh)

```
            ┌────────┐
   ┌────────│ Server │────────┐
   │        │(Signal)│        │
   │        └───┬────┘        │
   │            │             │
┌──┴──┐    ┌───┴───┐    ┌────┴──┐
│User A│<──>│User B │<──>│User C │
│      │    │       │    │       │
└──────┘    └───────┘    └───────┘
  P2P WebRTC connections (mesh)
```

- Server acts as signaling relay only (ICE candidates, SDP offers/answers)
- Peers connect directly via WebRTC
- Works well for up to ~6-8 users per channel
- State tracked in-memory on the server

### Future Implementation (V0.4+ - SFU)

```
┌────────┐  ┌────────┐  ┌────────┐
│ User A │  │ User B │  │ User C │
└───┬────┘  └───┬────┘  └───┬────┘
    │           │           │
    │     ┌─────┴─────┐    │
    └────>│ mediasoup  │<───┘
          │   SFU      │
          │            │
          │ Selective  │
          │ Forwarding │
          │ Unit       │
          └────────────┘
```

- Each client sends one upstream to the SFU
- SFU selectively forwards streams to recipients
- Scales to 99+ users per channel
- Supports simulcast for bandwidth adaptation
- mediasoup workers distribute across CPU cores

### Voice State Management

Voice state is tracked per-channel in memory:

```typescript
Map<channelId, Map<userId, {
  socketId: string;
  selfMute: boolean;
  selfDeaf: boolean;
}>>
```

For multi-node deployment, this will migrate to Redis with pub/sub for cross-node synchronization.

### DM Voice Calls (V0.5 - 1-on-1)

```
┌────────┐         ┌────────┐
│ User A │<──P2P──>│ User B │
└───┬────┘         └───┬────┘
    │                   │
    └───────┬───────────┘
            │
       ┌────┴─────┐
       │  Server   │
       │ (Signal + │
       │  State)   │
       └──────────┘
```

- Same WebRTC mesh approach as server voice (1-on-1 only)
- **Perfect Negotiation pattern** — resolves offer glare (both peers sending offers simultaneously) via polite/impolite roles based on userId comparison
- **Mutually exclusive** with server voice — joining one leaves the other (cross-cleanup on both server and client)
- In-memory state: `dmVoiceUsers` Map (conversationId → Map of userId → socketId) + `userDMCall` reverse lookup
- System messages ("Voice call started" / "Voice call ended") persisted to DB as `type: 'system'`
- Call offer broadcasts to `dm:{conversationId}` room; incoming call shown via `IncomingCallModal`
- DM call UI rendered inline in `DMChatArea` via `DMCallPanel` (separate from server `VoicePanel`)

---

## Authentication & Security

### JWT Token Flow

```
Register/Login
    │
    ▼
Server generates:
├── Access Token  (15min expiry, signed with JWT_SECRET)
└── Refresh Token (7 day expiry, signed with JWT_REFRESH_SECRET)
    │                Both embed tokenVersion from User model
    ▼
Client stores in localStorage
    │
    ▼
Every API request:
├── Authorization: Bearer <access_token>
│
├── If 401 → Try refresh:
│   POST /auth/refresh { refreshToken }
│   ├── Check tokenVersion matches DB → reject if mismatched (revoked)
│   ├── Success → New tokens, retry request
│   └── Failure → Redirect to login
```

### Password Reset Flow

```
Forgot Password (unauthenticated):
  POST /auth/forgot-password { email }
    → Find user (silent return if not found — prevents enumeration)
    → Generate crypto.randomBytes(32), store SHA-256 hash + 1hr expiry in DB
    → Send raw token via email (Nodemailer → MailHog locally / OVH SMTP in prod)
    → Always returns same success message

  POST /auth/reset-password { token, password }
    → SHA-256 hash incoming token → findUnique by resetToken (@@unique)
    → Check expiry, clear expired tokens
    → Hash new password, clear reset fields, increment tokenVersion

Change Password (authenticated):
  POST /auth/change-password { currentPassword, newPassword }
    → Verify current password via bcrypt
    → Hash new password, increment tokenVersion
    → Return fresh tokens (current session survives)
```

### Security Measures

| Layer | Protection |
|-------|-----------|
| Transport | HTTPS in production |
| Headers | Helmet.js (CSP, HSTS, X-Frame, etc.) |
| Auth | JWT with short expiry + refresh rotation + tokenVersion invalidation |
| Passwords | bcrypt with 12 salt rounds |
| Password Reset | SHA-256 hashed tokens, 1hr expiry, single-use, anti-enumeration |
| CORS | Explicit origin whitelist |
| Input | Server-side validation on all endpoints |
| SQL Injection | Prisma parameterized queries |
| WebSocket | JWT verification on connection |
| Input Sanitization | HTML tag stripping + trim on all user-generated text (defense-in-depth) |
| Rate Limiting | rate-limiter-flexible with Redis (per-endpoint + per-socket), fail-open with in-memory fallback |

### Permission Model

```
Owner  → Full server control (delete server, manage all)
Admin  → Create/delete channels, manage messages
Member → Send messages, join voice, use invites
```

Checked server-side on every request via `ServerMember.role`.

---

## Scalability Strategy

### Phase 1: Single Node (1K users)
- Single Node.js process
- PostgreSQL + Redis on same machine or nearby
- In-memory voice state
- Simple deployment

### Phase 2: Multi-Node (10K users)
```
                    ┌─────────────┐
                    │   nginx     │
                    │ (LB + SSL) │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
         ┌────┴────┐  ┌───┴─────┐  ┌──┴──────┐
         │ Node 1  │  │ Node 2  │  │ Node 3  │
         │ API+WS  │  │ API+WS  │  │ API+WS  │
         └────┬────┘  └───┬─────┘  └──┬──────┘
              │            │           │
              └────────────┼───────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
         ┌────┴────┐  ┌───┴─────┐     │
         │ Redis   │  │ Redis   │     │
         │ Primary │  │ Replica │     │
         └─────────┘  └─────────┘     │
                                       │
                              ┌────────┴────────┐
                              │   PostgreSQL    │
                              │ Primary+Replica │
                              └─────────────────┘
```

Key changes:
- Socket.IO with Redis adapter for cross-node event distribution
- Voice state in Redis
- Sticky sessions for WebSocket connections (IP hash or cookie)
- Connection pooling for PostgreSQL

### Phase 3: Microservices (100K+ users)

```
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│   API    │  │ Message  │  │  Voice   │  │ Presence │
│ Gateway  │  │ Service  │  │ Service  │  │ Service  │
└──────────┘  └──────────┘  └──────────┘  └──────────┘
     │              │              │              │
     └──────────────┴──────────────┴──────────────┘
                         │
                    ┌────┴────┐
                    │  NATS / │
                    │  Kafka  │
                    └─────────┘
```

- Break into domain microservices
- Event-driven architecture with message broker
- Independent scaling of voice vs. text vs. API
- Dedicated media servers for voice/video

### Phase 4: Discord-Scale (Millions)

- Global edge network (CDN + edge compute)
- Regional data centers
- Database sharding by server_id
- Dedicated media infrastructure
- Global service mesh
- Multi-region Redis clusters

---

## Deployment Architecture

### Development
```bash
docker compose up -d     # PostgreSQL + Redis
pnpm dev                 # Backend + Frontend
```

### Production (Docker)

```dockerfile
# apps/server/Dockerfile (future)
FROM node:20-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY dist/ ./dist/
COPY prisma/ ./prisma/
RUN npx prisma generate
CMD ["node", "dist/index.js"]
```

### Production (Kubernetes) — Future

```yaml
# Simplified deployment structure
API Deployment (3+ replicas)
  └── Service (ClusterIP)
      └── Ingress (nginx)

PostgreSQL StatefulSet
  └── PersistentVolumeClaim

Redis Deployment
  └── Service (ClusterIP)

mediasoup Deployment (autoscaling)
  └── Service (NodePort for UDP)
```

---

## Future Architecture

### Planned Features & Their Architectural Impact

| Feature | Architecture Change |
|---------|-------------------|
| **Video calls** | mediasoup SFU with video codecs (VP8/VP9/H264) |
| **Screen sharing** | mediasoup producer for screen capture |
| **~~Direct Messages~~** | ~~New DM channel type, conversation model~~ **Implemented (v0.5.0–v0.7.0)** — 1-on-1 text + voice with `Conversation` model, real-time delivery, typing, reactions, unread tracking, WebRTC P2P calls, conversation deletion with cascade + real-time sync |
| **~~File uploads~~** | ~~S3-compatible object storage~~ **Implemented (v0.3.2)** — server-proxied S3 uploads for avatars/icons via sharp + multer |
| **~~Password reset~~** | ~~Email-based reset flow~~ **Implemented (v0.4.0)** — Nodemailer + SHA-256 hashed tokens + tokenVersion-based session invalidation |
| **Push notifications** | FCM/APNs integration service |
| **Message search** | Elasticsearch / PostgreSQL full-text search |
| **Mobile app** | React Native sharing stores/services with web |
| **Bot API** | Gateway API for third-party integrations |
| **End-to-end encryption** | Signal Protocol for DMs |
| **CDN** | CloudFront/Cloudflare for static assets + media |

### Mobile Strategy

The frontend architecture is designed for code sharing:

```
packages/shared/     → Types, validators, constants (shared)
packages/ui/         → UI components (future, shared)
apps/desktop/        → Tauri + React (desktop)
apps/mobile/         → React Native (future)
apps/web/            → React SPA (future, same code as desktop minus Tauri)
```

Zustand stores and service layer (API + Socket) are framework-agnostic and can be reused across all platforms.
