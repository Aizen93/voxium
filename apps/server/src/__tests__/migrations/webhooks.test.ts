import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The webhooks migration (docs/local/webhooks-plan.html, "Data model") is
 * hand-written from `prisma migrate diff`, with the dev database's unrelated
 * drift removed. What these pin is what a review would otherwise have to
 * re-derive: the one column made nullable, the ON DELETE behaviour of every
 * new relation (messages must SURVIVE their webhook), that nothing is dropped
 * or rewritten, and that schema.prisma says the same thing.
 */

const REPO = resolve(__dirname, '../../../../..');
const MIGRATION = resolve(REPO, 'apps/server/prisma/migrations/20261018120000_webhooks/migration.sql');
const SCHEMA = resolve(REPO, 'apps/server/prisma/schema.prisma');

const sql = readFileSync(MIGRATION, 'utf8');
const schema = readFileSync(SCHEMA, 'utf8');

describe('webhooks migration', () => {
  it('creates the webhooks table with its two lookup indexes', () => {
    expect(sql).toMatch(/CREATE TABLE "webhooks"/);
    for (const col of ['server_id', 'channel_id', 'name', 'token_hash']) {
      expect(sql).toMatch(new RegExp(`"${col}" TEXT NOT NULL`));
    }
    expect(sql).toMatch(/"type" TEXT NOT NULL DEFAULT 'generic'/);
    expect(sql).toMatch(/"secret_enc" TEXT,/);
    expect(sql).toMatch(/"enabled" BOOLEAN NOT NULL DEFAULT true/);
    expect(sql).toMatch(/"created_by_id" TEXT,/);
    expect(sql).toMatch(/"last_used_at" TIMESTAMP\(3\),/);
    expect(sql).toMatch(/CONSTRAINT "webhooks_pkey" PRIMARY KEY \("id"\)/);
    expect(sql).toMatch(/CREATE INDEX "webhooks_server_id_idx" ON "webhooks"\("server_id"\)/);
    expect(sql).toMatch(/CREATE INDEX "webhooks_channel_id_idx" ON "webhooks"\("channel_id"\)/);
  });

  it('makes messages.author_id nullable and adds the two nullable webhook columns', () => {
    expect(sql).toMatch(/ALTER COLUMN "author_id" DROP NOT NULL/);
    expect(sql).toMatch(/ADD COLUMN\s+"webhook_id" TEXT,/);
    expect(sql).toMatch(/ADD COLUMN\s+"webhook_name" TEXT,/);
  });

  it('adds the limit columns: global default 10, the per-server override nullable', () => {
    expect(sql).toMatch(/ALTER TABLE "global_config" ADD COLUMN\s+"max_webhooks_per_server" INTEGER NOT NULL DEFAULT 10;/);
    expect(sql).toMatch(/ALTER TABLE "server_limits" ADD COLUMN\s+"max_webhooks_per_server" INTEGER;/);
  });

  it('keeps posted messages when their webhook is deleted (SET NULL), and lets a webhook die with its server, channel or creator link', () => {
    expect(sql).toMatch(/"messages_webhook_id_fkey" FOREIGN KEY \("webhook_id"\) REFERENCES "webhooks"\("id"\) ON DELETE SET NULL/);
    expect(sql).toMatch(/"webhooks_server_id_fkey" FOREIGN KEY \("server_id"\) REFERENCES "servers"\("id"\) ON DELETE CASCADE/);
    expect(sql).toMatch(/"webhooks_channel_id_fkey" FOREIGN KEY \("channel_id"\) REFERENCES "channels"\("id"\) ON DELETE CASCADE/);
    expect(sql).toMatch(/"webhooks_created_by_id_fkey" FOREIGN KEY \("created_by_id"\) REFERENCES "users"\("id"\) ON DELETE SET NULL/);
  });

  it('adds exactly one index on messages: webhook_id (the FK SET NULL action and the purge look rows up by it)', () => {
    // statements only (line start): the header comment quotes a CONCURRENTLY form
    const onMessages = [...sql.matchAll(/^CREATE (?:UNIQUE )?INDEX[^;]*ON "messages"[^;]*;/gm)].map((m) => m[0]);
    expect(onMessages).toEqual(['CREATE INDEX "messages_webhook_id_idx" ON "messages"("webhook_id");']);
    // built inside the migration's transaction; the header documents the
    // CONCURRENTLY + `migrate resolve --applied` route for a very large table
    expect(sql).not.toMatch(/^CREATE INDEX CONCURRENTLY/m);
    expect(sql).toMatch(/CREATE INDEX CONCURRENTLY/);
    expect(sql).toMatch(/prisma migrate resolve --applied 20261018120000_webhooks/);
  });

  it('carries none of the dev database drift: no DROP, no backfill, no functional username index', () => {
    expect(sql).not.toMatch(/users_username_lower_key/);
    expect(sql).not.toMatch(/\bDROP (TABLE|INDEX|COLUMN|CONSTRAINT)\b/);
    expect(sql).not.toMatch(/^UPDATE /m);
    expect(sql).not.toMatch(/^DELETE /m);
    // only these four tables are touched
    const touched = new Set([...sql.matchAll(/(?:ALTER|CREATE) TABLE "([a-z_]+)"/g)].map((m) => m[1]));
    expect([...touched].sort()).toEqual(['global_config', 'messages', 'server_limits', 'webhooks']);
  });
});

describe('schema.prisma mirrors the migration', () => {
  it('declares the Webhook model with its relations and indexes', () => {
    expect(schema).toMatch(/model Webhook \{[\s\S]*@@index\(\[serverId\]\)[\s\S]*@@index\(\[channelId\]\)[\s\S]*@@map\("webhooks"\)/);
    expect(schema).toMatch(/createdBy User\?\s+@relation\("WebhookCreator", fields: \[createdById\], references: \[id\], onDelete: SetNull\)/);
    // once on User, once on Webhook
    expect(schema.split('@relation("WebhookCreator"')).toHaveLength(3);
  });

  it('declares the nullable author and the SET NULL webhook relation on Message', () => {
    expect(schema).toMatch(/authorId\s+String\?\s+@map\("author_id"\)/);
    expect(schema).toMatch(/author\s+User\?\s+@relation\(fields: \[authorId\], references: \[id\], onDelete: Cascade\)/);
    expect(schema).toMatch(/webhook\s+Webhook\?\s+@relation\(fields: \[webhookId\], references: \[id\], onDelete: SetNull\)/);
  });

  it('indexes Message.webhookId (the one index the migration adds on messages)', () => {
    const message = schema.match(/model Message \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(message).toMatch(/@@map\("messages"\)/);
    expect(message).toMatch(/^\s*@@index\(\[webhookId\]\)\s*$/m);
  });

  it('declares both limit columns', () => {
    expect(schema).toMatch(/maxWebhooksPerServer\s+Int\s+@default\(10\) @map\("max_webhooks_per_server"\)/);
    expect(schema).toMatch(/maxWebhooksPerServer\s+Int\?\s+@map\("max_webhooks_per_server"\)/);
  });
});
