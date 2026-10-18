import axios from 'axios';
import { WEBHOOKS_DISABLED_MESSAGE } from '@voxium/shared';
import type { Webhook, WebhookCreated, WebhookType } from '@voxium/shared';
import { api, API_BASE } from './api';

/**
 * Incoming-webhook management (Server settings → Integrations). Thin typed
 * calls over the authenticated API; every route needs MANAGE_WEBHOOKS.
 *
 * The token is a credential: only `createWebhook` and `rotateWebhook` ever
 * return it, the caller shows it once and keeps it nowhere but component
 * state. Nothing here caches, logs or stores it.
 */

export interface CreateWebhookInput {
  channelId: string;
  name: string;
  type: WebhookType;
}

export interface UpdateWebhookInput {
  name?: string;
  channelId?: string;
  enabled?: boolean;
}

/** The flag-off answer of every management route (403). */
// The sentence the server's kill switch answers with: ONE copy, in @voxium/shared
export { WEBHOOKS_DISABLED_MESSAGE };

const base = (serverId: string) => `/servers/${serverId}/webhooks`;

export interface WebhookList {
  /** The webhooks on channels the caller can VIEW. */
  webhooks: Webhook[];
  /**
   * Every webhook of the server, hidden channels included: what the per-server
   * cap counts. Never below `webhooks.length`.
   */
  total: number;
}

export async function listWebhooks(serverId: string): Promise<WebhookList> {
  const { data } = await api.get<{ success: boolean; data: Webhook[]; total?: number }>(base(serverId));
  const webhooks = data.data;
  // An older server sends no `total`: the visible rows are the best count there is
  const total = typeof data.total === 'number' && Number.isInteger(data.total) && data.total >= 0
    ? Math.max(data.total, webhooks.length)
    : webhooks.length;
  return { webhooks, total };
}

export async function createWebhook(serverId: string, input: CreateWebhookInput): Promise<WebhookCreated> {
  const { data } = await api.post<{ success: boolean; data: WebhookCreated }>(base(serverId), input);
  return data.data;
}

export async function updateWebhook(serverId: string, webhookId: string, patch: UpdateWebhookInput): Promise<Webhook> {
  const { data } = await api.patch<{ success: boolean; data: Webhook }>(`${base(serverId)}/${webhookId}`, patch);
  return data.data;
}

/** A new token; the old URL stops working the moment this resolves. */
export async function rotateWebhook(serverId: string, webhookId: string): Promise<WebhookCreated> {
  const { data } = await api.post<{ success: boolean; data: WebhookCreated }>(`${base(serverId)}/${webhookId}/rotate`);
  return data.data;
}

/** `purge` also deletes every message the webhook posted (in one transaction, server-side). */
export async function deleteWebhook(serverId: string, webhookId: string, purge: boolean): Promise<{ deletedMessages: number }> {
  const { data } = await api.delete<{ success: boolean; data: { deletedMessages: number } }>(
    `${base(serverId)}/${webhookId}`,
    purge ? { params: { purge: '1' } } : undefined,
  );
  return data.data;
}

/**
 * What a webhook id (a cuid) and its token (base64url) are made of. Anything
 * else in a create/rotate answer is a server that should not be trusted with
 * the URL: a `/`, `?`, `#` or `..` would point the copied URL somewhere else,
 * and a quote or `;` would break out of the curl line below.
 */
const URL_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

/**
 * The public execute URL. Composed HERE, from the client's own API base: the
 * server does not know its public origin (proxies), so it never builds it.
 * `null` when the id or the token is not a plain URL segment: the caller
 * says so (a toast) instead of showing a URL that goes somewhere else.
 */
export function webhookUrl(webhookId: string, token: string): string | null {
  if (typeof webhookId !== 'string' || typeof token !== 'string') return null;
  if (!URL_SEGMENT_RE.test(webhookId) || !URL_SEGMENT_RE.test(token)) return null;
  return `${API_BASE.replace(/\/+$/, '')}/webhooks/${webhookId}/${token}`;
}

/** `value` as ONE single-quoted POSIX shell word: nothing inside is interpreted. */
function shellQuote(value: string): string {
  return `'${value.split("'").join(`'"'"'`)}'`;
}

/**
 * The one-liner the copy-once panel offers to try the URL from a terminal.
 * The URL is single-quoted: the API base is configuration, and nothing in it
 * may run in the user's shell when the line is pasted.
 */
export function webhookCurlCommand(url: string): string {
  return `curl -H 'content-type: application/json' -d '{"content":"hello from cron"}' ${shellQuote(url)}`;
}

/** The flag-off answer is a STATE (the tab's "turned off" view), not an error to toast. */
export function isWebhooksOff(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 403
    && err.response?.data?.error === WEBHOOKS_DISABLED_MESSAGE;
}
