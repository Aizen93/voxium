## Quality-of-life (low effort, high polish):
  - [] Stabilizing the code, with better error handling and exception management. User friendly and smoother UI.  
  - [] Push-to-talk — alternative to voice activity; just a keybind that mutes/unmutes, easy to add alongside the existing mute logic
  - [] Notification sounds — play a tone on join/leave/message; the audio infrastructure is already there
  - [] Unread indicators / mention badges — channel list currently has no unread state, which makes multi-channel usage painful
  - [] When a new User joins the server, the members list is not updating in real time and needs a page refresh to see the new user in the members list (Right side panel)

## Core chat features (medium effort):
  - [] File & image uploads — drag-and-drop or paste images into chat, preview inline. Needs a storage backend (S3/local) and a new message type
  - [] Message reactions — emoji reactions on messages; very common expectation for a chat app
  - [] Message editing & deletion UI — the server events (message:update, message:delete) are already wired, but I didn't see an edit/delete UI in the chat bubbles

## Bigger features (high effort, high value):
  - [] Direct messages (DMs) — 1:1 and group DMs outside of servers; this is a significant architecture addition but is probably the most-expected missing feature
  - [] Screen sharing — the WebRTC peer connections are already set up; adding a video track for screen capture is a natural extension
  - [] Server roles & permissions — the MemberRole type exists (owner/admin/member) but I didn't see permission checks on the client for things like channel creation or member management