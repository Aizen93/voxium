/**
 * The `Server` shape the list, the updates and every server:updated emit
 * return — exactly the fields of the shared type, directory profile included.
 * One constant so no select can quietly miss a field the client expects.
 * Lives outside routes/servers.ts because the discovery router answers an
 * open-mode join with the same shape (the client store path is shared with
 * the invite join).
 */
export const serverSelect = {
  id: true, name: true, iconUrl: true, invitesLocked: true, ownerId: true, createdAt: true,
  description: true, tags: true, discoverable: true, joinMode: true,
} as const;
