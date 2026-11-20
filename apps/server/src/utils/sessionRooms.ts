// The socket rooms of sign-in sessions (services/sessionService.ts). Pure,
// so the socket server and the revocations name them the same way without
// importing each other.

/** Every socket opened with an access token that names session `sid`. */
export function sessionRoom(sid: string): string {
  return `session:${sid}`;
}

/**
 * Every socket of `userId` opened with an access token issued before
 * sessions, which names none. Transitional, like those tokens: a later
 * release stops accepting them and removes the room.
 */
export function legacySocketsRoom(userId: string): string {
  return `nosid:${userId}`;
}
