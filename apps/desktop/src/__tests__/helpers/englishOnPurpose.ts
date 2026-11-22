// Test-only: the server sentences that stay English on purpose, each GROUP with
// its reason (serverErrorsCoverage.test.ts). A sentence a member can be shown
// is NOT put here: it gets a mapping in utils/serverErrors.ts and its string in
// all 11 locales. Entries are the sentences as the scan reads them (an
// expression inside a template is written `${expr}`).

export interface EnglishGroup {
  reason: string;
  /** Whole files (repository-relative): every sentence they write is in the group. */
  files?: string[];
  /** Exact sentences. Each must still be written somewhere and still be unmapped. */
  sentences?: string[];
  /**
   * Shapes of sentence, each with the number of sentences it matches TODAY: a
   * new sentence of that shape changes the number and fails the test until
   * someone has looked at it (mapped it, or listed it by name and kept the number).
   */
  patterns?: Array<{ re: RegExp; matches: number }>;
}

export const ENGLISH_ON_PURPOSE: EnglishGroup[] = [
  {
    reason:
      'Routes only the admin dashboard calls: that app is English-only, and these files are never reached by a member',
    files: ['apps/server/src/routes/admin.ts', 'apps/server/src/middleware/requireSuperAdmin.ts'],
    sentences: ['Feature flag not found'],
  },
  {
    reason:
      'Answers to a webhook sender (a script or GitHub), never to a member: the sender reads the sentence in its own logs',
    files: [
      'apps/server/src/routes/webhookExecute.ts',
      'apps/server/src/utils/webhooks/discordPayload.ts',
      'apps/server/src/utils/webhooks/githubFormatter.ts',
    ],
  },
  {
    reason:
      'The end-to-end key service protocol: signatures, key formats, batch sizes, the backup and message-key blobs, ' +
      'which only the E2E service sends, with bodies it builds itself. The sentences a send, a device-list read or a ' +
      'key claim can answer to a person (no shared conversation, a device that is gone, no keys left, a recipient ' +
      'who left) are mapped in utils/serverErrors.ts; what stays here is a malformed or forged request',
    files: ['apps/server/src/routes/e2e.ts'],
  },
  {
    reason:
      'Type and presence validation of a request body or query: the official client builds these bodies from typed ' +
      'state (the report dialog sets the type and the target from its props, the presign call names one context), ' +
      'so only a hand-written request meets them',
    patterns: [
      { re: / must be (a|an) (string|boolean|array|object|non-empty array|non-empty string)\b/, matches: 26 },
      { re: / must be true or false$/, matches: 1 },
      { re: /(^| )(is )?required$/, matches: 8 },
      { re: / must be an array of user ids$/, matches: 1 },
    ],
    sentences: [
      'allow and deny must be strings (decimal bigint)',
      'roleIds must be an array',
      'Provide a boolean "locked" value',
      'role must be "admin" or "member"',
      'joinMode must be "approval" or "open"',
      'Provide exactly one of channelId or conversationId',
      'Invalid report type',
      'serverId is required for server reports',
      'messageId is required for message reports',
    ],
  },
  {
    reason:
      'Identifiers, cursors, keys and envelopes the client received from the server and sends back unchanged, and ' +
      'the shape of an attachment record the client builds from its own upload: a refusal means a forged or stale ' +
      'value, which the screen handles as its own failed state',
    sentences: [
      'Invalid cursor',
      'Unknown sort',
      'Unknown tag',
      'Invalid role filter',
      'Invalid icon key',
      'Invalid avatar key',
      'Invalid key',
      'Invalid attachment fields',
      'Invalid attachment key',
      'Encrypted attachments must be opaque',
      'Encrypted attachments must be uploaded as application/octet-stream',
      'Encrypted attachments are only supported in direct messages and secure channels',
      'Encrypted messages are only supported in secure channels',
      'Invalid encrypted message envelope',
      'Reported user does not match message author',
      'You can only view your own effective permissions',
      'Invalid before date',
      'Invalid ${name} parameter',
      'Each query parameter must be a single value',
      'Missing or invalid authorization header',
      'Invalid token type',
    ],
  },
  {
    reason:
      'HTTP-level answers of the error handler to a body the client did not build (an oversized or unparsable body, ' +
      'an unsupported encoding, a malformed address): the client serialises its own JSON',
    sentences: [
      'Request body too large',
      'Malformed JSON body',
      'Unsupported request encoding',
      'Invalid request',
      'Malformed URL',
    ],
  },
  {
    reason:
      'Limits and shapes the interface enforces before it sends (field lengths, counts, drag-reorder, pickers) and ' +
      'objects the theme code checks first (an import verifies that colors and patterns are objects, the editor and ' +
      'the publish call build them): a request that reaches the server with one of these is not from the official screens',
    sentences: [
      'Message must be ${LIMITS.SUPPORT_MESSAGE_MIN}-${LIMITS.SUPPORT_MESSAGE_MAX} characters',
      'reportedContent must be at most ${LIMITS.MESSAGE_MAX} characters',
      'ids must name 1 to ${MEMBER_LIST.LOOKUP_MAX_IDS} users',
      'Each order entry needs a category id and a whole-number position from 0 to ${MAX_SORT_POSITION}',
      'Each order entry needs a channel id and a whole-number position from 0 to ${MAX_SORT_POSITION}',
      'allow and deny cannot have overlapping bits',
      'Colors must be an object',
      'Patterns must be an object',
    ],
  },
  {
    reason:
      'Sentences whose screen reads something else: the owned-spaces dialog reads the answer\'s data, the mail-block ' +
      'page words its own failure, and the two constructor defaults ("Forbidden", "Unauthorized") are written by no ' +
      'route (every throw names its sentence)',
    sentences: [
      'Transfer or delete the servers you own before deleting your account',
      'Invalid or expired mail-block link',
      'Forbidden',
      'Unauthorized',
    ],
  },
  {
    reason:
      'An image or file the screen loads as a picture or a placeholder: a missing one is drawn as the expired or ' +
      'empty state, the sentence is never shown',
    sentences: ['Asset not found', 'Attachment not found', 'Attachment expired not found'],
  },
  {
    reason:
      'Socket acknowledgements the client words itself or only logs: the annotation toasts pick their own translated ' +
      'text (one for a full scene, one for the rest) and the media setup acknowledgements go to the console',
    sentences: [
      'DTLS connect failed',
      'Failed to create producer',
      'Invalid parameters',
      'Not in a voice channel',
      'Not the active screen sharer',
      'Rate limited',
      'Transport not found',
      'Voice session not found',
      'Voice state not found',
      'Internal error',
      'Invalid payload',
      'Not the active sharer',
      'Payload too large',
      'Scene is being modified concurrently',
      'Scene limit reached',
    ],
  },
  {
    reason: 'The text of a failure the server records or returns to its own code, never in an HTTP answer to a person',
    sentences: ['HTTP ${res.status}'],
  },
];
