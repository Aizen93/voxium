import { describe, it, expect } from 'vitest';
import {
  LIMITS,
  WEBHOOK_TYPES,
  WEBHOOKS_DISABLED_MESSAGE,
  OPAQUE_ID_RE,
  WS_EVENTS,
  Permissions,
  ALL_PERMISSIONS,
  DEFAULT_ADMIN_PERMISSIONS,
  DEFAULT_EVERYONE_PERMISSIONS,
  PERMISSION_LIST,
  validateWebhookName,
  type WebhookType,
} from '@voxium/shared';
import { WEBHOOK_AUTHOR_ID_PREFIX } from '../../utils/messageAuthor';

// The shared surface of incoming webhooks (docs/local/webhooks-plan.html):
// constants the routes and the client size themselves on, the 22nd permission
// bit, the two socket events and the name validator.

describe('webhook limits', () => {
  it('pins the caps the execute and management routes are sized on', () => {
    expect(LIMITS.MAX_WEBHOOKS_PER_SERVER).toBe(10);
    expect(LIMITS.WEBHOOK_NAME_MAX).toBe(64);
    expect(LIMITS.WEBHOOK_BODY_MAX_BYTES).toBe(1024 * 1024);
    expect(LIMITS.WEBHOOK_EMBEDS_MAX).toBe(10);
    expect(LIMITS.WEBHOOK_EMBED_FIELDS_MAX).toBe(25);
  });
});

describe('WEBHOOK_TYPES', () => {
  it('lists exactly the two kinds, generic first (the column default)', () => {
    expect(WEBHOOK_TYPES).toEqual(['generic', 'github']);
    const t: WebhookType = 'github';
    expect(WEBHOOK_TYPES).toContain(t);
  });
});

describe('validateWebhookName', () => {
  it('rejects an empty name', () => {
    expect(validateWebhookName('')).toBe('Webhook name cannot be empty');
  });

  it('rejects a whitespace-only name', () => {
    expect(validateWebhookName('   ')).toBe('Webhook name cannot be empty');
    expect(validateWebhookName('\n \n')).toBe('Webhook name cannot be empty');
  });

  it('accepts exactly WEBHOOK_NAME_MAX (64) characters', () => {
    expect(validateWebhookName('a'.repeat(64))).toBeNull();
  });

  it('rejects 65 characters', () => {
    expect(validateWebhookName('a'.repeat(65))).toBe('Webhook name must be at most 64 characters');
  });

  it('judges the TRIMMED name (the route stores it trimmed)', () => {
    expect(validateWebhookName(`  ${'a'.repeat(64)}  `)).toBeNull();
    expect(validateWebhookName('  GitHub  ')).toBeNull();
  });

  it('accepts an ordinary name', () => {
    expect(validateWebhookName('Deploy bot')).toBeNull();
  });
});

describe('MANAGE_WEBHOOKS', () => {
  it('is bit 21 — the 22nd flag, inside ALL_PERMISSIONS', () => {
    expect(Permissions.MANAGE_WEBHOOKS).toBe(1n << 21n);
    expect(ALL_PERMISSIONS & Permissions.MANAGE_WEBHOOKS).toBe(Permissions.MANAGE_WEBHOOKS);
  });

  it('is granted to the default Admin role, never to @everyone', () => {
    expect(DEFAULT_ADMIN_PERMISSIONS & Permissions.MANAGE_WEBHOOKS).toBe(Permissions.MANAGE_WEBHOOKS);
    expect(DEFAULT_EVERYONE_PERMISSIONS & Permissions.MANAGE_WEBHOOKS).toBe(0n);
  });

  it('is listed under general, right after CREATE_SECURE_CHANNELS', () => {
    const idx = PERMISSION_LIST.findIndex((p) => p.key === 'MANAGE_WEBHOOKS');
    expect(idx).toBeGreaterThan(-1);
    const entry = PERMISSION_LIST[idx];
    expect(entry).toEqual({
      flag: Permissions.MANAGE_WEBHOOKS,
      key: 'MANAGE_WEBHOOKS',
      name: 'Manage Webhooks',
      description: 'Allows members to create, edit, and delete incoming webhooks',
      category: 'general',
    });
    expect(PERMISSION_LIST[idx - 1].key).toBe('CREATE_SECURE_CHANNELS');
  });
});

describe('webhook socket events', () => {
  it('names the two events', () => {
    expect(WS_EVENTS.WEBHOOK_CHANGED).toBe('webhook:changed');
    expect(WS_EVENTS.MESSAGE_BULK_DELETED).toBe('message:bulk_deleted');
  });
});

// The audited admin actions and the AdminWebhook row are TYPES: server tests
// run outside `tsc`, so a literal written here could only pin itself. Their
// binding pins are compile-time: the admin's exhaustive
// `ACTION_LABELS: Record<AuditAction, string>` (fails admin typecheck for a
// missing label and for a label of no action) and the admin store/list code
// that reads `AdminWebhook`.

describe('WEBHOOKS_DISABLED_MESSAGE', () => {
  it('is the exact sentence the kill switch answers (the desktop keys its off state on it)', () => {
    expect(WEBHOOKS_DISABLED_MESSAGE).toBe('Webhooks are currently disabled');
  });
});

describe('OPAQUE_ID_RE', () => {
  it('accepts the ids a client may hand the server (cuids, role ids, user ids), 1 to 64 characters', () => {
    for (const id of ['cmg8x2k4f0000qz8h1abc2def', 'user-1', 'role_42', 'A', 'x'.repeat(64)]) {
      expect(OPAQUE_ID_RE.test(id), id).toBe(true);
    }
  });

  it('refuses everything else: empty, too long, separators, whitespace', () => {
    for (const id of ['', 'x'.repeat(65), 'a/b', 'a.b', 'a b', 'a?b', 'a%20b', 'é']) {
      expect(OPAQUE_ID_RE.test(id), id).toBe(false);
    }
  });

  it('can NEVER pass a synthesised webhook author id (the colon keeps it out of member lookups)', () => {
    expect(WEBHOOK_AUTHOR_ID_PREFIX).toContain(':');
    for (const id of [`${WEBHOOK_AUTHOR_ID_PREFIX}cmg8x2k4f0000qz8h1abc2def`, `${WEBHOOK_AUTHOR_ID_PREFIX}deleted`]) {
      expect(OPAQUE_ID_RE.test(id), id).toBe(false);
    }
  });

  it('is stateless across calls (no g flag, so no lastIndex carried between tests)', () => {
    expect(OPAQUE_ID_RE.flags).toBe('');
    expect(OPAQUE_ID_RE.test('user-1')).toBe(true);
    expect(OPAQUE_ID_RE.test('user-1')).toBe(true);
  });
});
