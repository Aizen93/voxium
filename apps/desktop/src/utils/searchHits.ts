/**
 * Server search results minus any hit from a channel the client knows is
 * secure, and any hit flagged encrypted. The server excludes secure channels
 * from its search; a hit from one is not something the client may show as
 * plaintext (docs/e2e-dm-spec.md §19.5).
 */
export function withoutSecureChannelHits<T extends { channelId?: string | null; encrypted?: boolean }>(
  hits: T[],
  channels: { id: string; secure?: boolean }[] | undefined,
): T[] {
  const secure = new Set((channels ?? []).filter((c) => c.secure === true).map((c) => c.id));
  return hits.filter((h) => h.encrypted !== true && !(h.channelId && secure.has(h.channelId)));
}
