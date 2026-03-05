import type { APIRequestContext } from '@playwright/test';

export const API_URL = 'http://localhost:3001/api/v1';

/** Register a new user via the API. Returns access + refresh tokens. */
export async function registerUser(
  request: APIRequestContext,
  user: { username: string; email: string; password: string },
) {
  const res = await request.post(`${API_URL}/auth/register`, { data: user });
  if (!res.ok()) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Register failed (${res.status()}): ${body.error || res.statusText()}`);
  }
  const { data } = await res.json();
  return data as { accessToken: string; refreshToken: string; user: { id: string; username: string } };
}

/** Login via the API. Returns access + refresh tokens. */
export async function loginUser(
  request: APIRequestContext,
  credentials: { email: string; password: string },
) {
  const res = await request.post(`${API_URL}/auth/login`, { data: credentials });
  if (!res.ok()) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Login failed (${res.status()}): ${body.error || res.statusText()}`);
  }
  const { data } = await res.json();
  return data as { accessToken: string; refreshToken: string; user: { id: string; username: string } };
}

/** Create a server via the API. Returns the created server. */
export async function createServer(
  request: APIRequestContext,
  token: string,
  name: string,
) {
  const res = await request.post(`${API_URL}/servers`, {
    data: { name },
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok()) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Create server failed (${res.status()}): ${body.error || res.statusText()}`);
  }
  const { data } = await res.json();
  return data as { id: string; name: string };
}

/** Create an invite for a server. Returns the invite code. */
export async function createInvite(
  request: APIRequestContext,
  token: string,
  serverId: string,
) {
  const res = await request.post(`${API_URL}/invites/servers/${serverId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok()) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Create invite failed (${res.status()}): ${body.error || res.statusText()}`);
  }
  const { data } = await res.json();
  return data.code as string;
}

/** Send a friend request. */
export async function sendFriendRequest(
  request: APIRequestContext,
  token: string,
  username: string,
) {
  const res = await request.post(`${API_URL}/friends/request`, {
    data: { username },
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok()) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Friend request failed (${res.status()}): ${body.error || res.statusText()}`);
  }
}

/** Accept a pending friend request from a specific user. */
export async function acceptFriendRequest(
  request: APIRequestContext,
  token: string,
  senderUserId: string,
) {
  // First, get the friendship list to find the pending request
  const listRes = await request.get(`${API_URL}/friends`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!listRes.ok()) throw new Error(`Failed to list friends`);
  const { data: friendships } = await listRes.json();

  const pending = friendships.find(
    (f: any) => f.status === 'pending' && f.user?.id === senderUserId,
  );
  if (!pending) throw new Error(`No pending friend request from user ${senderUserId}`);

  const res = await request.post(`${API_URL}/friends/${pending.id}/accept`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok()) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Accept friend failed (${res.status()}): ${body.error || res.statusText()}`);
  }
}
