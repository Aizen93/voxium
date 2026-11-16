/**
 * The origins CORS_ORIGIN allows: comma-separated, each trimmed, the browser
 * dev server's when the setting is unset. The HTTP layer (app.ts) and the
 * boot check of the bucket's CORS rule (utils/s3.ts) read the setting through
 * this one function, so the bucket is checked for exactly the origins the API
 * answers.
 */
export function parseCorsOrigins(raw: string | undefined): string[] {
  return (raw || 'http://localhost:8080').split(',').map((o) => o.trim());
}
