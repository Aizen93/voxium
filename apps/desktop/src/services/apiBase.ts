/**
 * The REST base every request is relative to, compiled in from VITE_API_URL.
 * Its own module, free of imports, so the session storage can bind what it
 * stores to this server without an import cycle through services/session.ts
 * (which re-exports it).
 */
export const API_BASE: string = import.meta.env.VITE_API_URL || 'http://localhost:3001/api/v1';
