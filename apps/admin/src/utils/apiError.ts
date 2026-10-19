import axios from 'axios';

/** The server's own error message when the response carried one, else the fallback. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: unknown; message?: unknown } | undefined;
    if (typeof data?.error === 'string' && data.error) return data.error;
    if (typeof data?.message === 'string' && data.message) return data.message;
  }
  return fallback;
}

/**
 * The only form of a failed request that may reach the console: the server's
 * error sentence, else the error's own message, else the value as text. Never
 * the error object itself: an axios error carries its request config, the
 * admin's `Authorization: Bearer` header included, and the console prints all
 * of it.
 */
export function logMessage(err: unknown): string {
  return apiErrorMessage(err, err instanceof Error ? err.message : String(err));
}

/** True when the request answered 404 (the target is gone, or hidden on purpose). */
export function isNotFound(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 404;
}
