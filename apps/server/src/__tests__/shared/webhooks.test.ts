import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  LIMITS,
  WEBHOOK_TYPES,
  WS_EVENTS,
  Permissions,
  ALL_PERMISSIONS,
  DEFAULT_ADMIN_PERMISSIONS,
  DEFAULT_EVERYONE_PERMISSIONS,
  PERMISSION_LIST,
  validateWebhookName,
  type WebhookType,
  type AuditAction,
  type AdminWebhook,
  type Webhook,
} from '@voxium/shared';

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

describe('webhook moderation (platform admins)', () => {
  it('names the three audited admin actions', () => {
    // Typed AuditAction[] (and expectTypeOf) for type-aware runs; server
    // tests are outside `tsc`, so the binding compile-time pin is the admin's
    // exhaustive `ACTION_LABELS: Record<AuditAction, string>`, which fails
    // admin typecheck both for a missing label and for a label of no action
    const actions: AuditAction[] = ['webhook.disable', 'webhook.enable', 'webhook.delete'];
    expect(actions).toEqual(['webhook.disable', 'webhook.enable', 'webhook.delete']);
    expectTypeOf<'webhook.disable' | 'webhook.enable' | 'webhook.delete'>().toMatchTypeOf<AuditAction>();
  });

  it('the admin list row is the Webhook shape plus a nullable channel name', () => {
    expectTypeOf<AdminWebhook>().toMatchTypeOf<Webhook>();
    expectTypeOf<AdminWebhook['channelName']>().toEqualTypeOf<string | null>();
    const row: AdminWebhook = {
      id: 'wh-1', serverId: 'srv-1', channelId: 'ch-1', name: 'CI', type: 'generic', enabled: true,
      createdBy: null, createdAt: '2026-10-18T10:00:00.000Z', lastUsedAt: null, channelName: null,
    };
    expect(row.channelName).toBeNull();
  });
});
