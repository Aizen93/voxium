/**
 * The Prisma selects every plaintext-channel message reader shares, so a row
 * reaches the client in ONE shape whether a member (routes/messages.ts) or an
 * incoming webhook (routes/webhookExecute.ts) posted it: a field added here
 * reaches both. dm.ts keeps its own author select (it adds `status`).
 */
export const attachmentSelect = {
  select: { id: true, s3Key: true, fileName: true, fileSize: true, mimeType: true, expired: true },
} as const;

export const authorSelect = {
  select: { id: true, username: true, displayName: true, avatarUrl: true, role: true, isSupporter: true, supporterTier: true },
} as const;

// webhookId/webhookName: a quoted webhook message has no user author, and
// shapeMessageRow() needs both to synthesise one (utils/messageAuthor.ts)
export const replyToSelect = {
  select: { id: true, content: true, webhookId: true, webhookName: true, author: authorSelect },
} as const;
