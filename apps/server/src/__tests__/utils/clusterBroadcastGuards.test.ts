import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Source-shape guards for adapter-wide broadcasts whose failure mode is a
 * CLUSTER-WIDE outage rather than a wrong value — the kind nothing else in the
 * suite can see, because a unit test mocks the adapter that would have done the
 * damage and an e2e run only ever has one node.
 *
 * These assert the shape of the call, not its behaviour. That is a weak test in
 * general and the right one here: the bug is a missing `.local`, it reads like
 * a redundancy, and the next person to touch the shutdown path will write the
 * obvious thing.
 */

const SERVER = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(SERVER, rel), 'utf8');

describe('shutdown disconnects only THIS node', () => {
  const index = read('index.ts');

  it('calls io.local.disconnectSockets, never the bare form', () => {
    // The Redis adapter turns a bare disconnectSockets into a REMOTE_DISCONNECT
    // carrying an EMPTY room filter, which every peer applies to its entire
    // namespace. Restarting one of two production nodes therefore hung up 100%
    // of connected users cluster-wide, tearing down the surviving node's voice
    // sessions and DM calls with them — triggered by a routine deploy.
    expect(index).toContain('io.local.disconnectSockets(');
    expect(index).not.toMatch(/(?<!\.local)\bio\.disconnectSockets\(/);
  });

  it('keeps the reason for the .local next to the call', () => {
    // Without it the next reader deletes a word that looks redundant.
    expect(index).toMatch(/REMOTE_DISCONNECT/);
  });
});

describe('the socket-connect hot path never serializes every socket in the cluster', () => {
  // CLAUDE.md: io.fetchSockets() serializes every socket on every node AND
  // waits for every node's reply, so one unresponsive peer makes it throw after
  // 5s and kills everything after it in the handler. Targeted work uses
  // `user:{id}` rooms instead.
  it('socketServer.ts uses no unscoped io.fetchSockets()', () => {
    expect(read('websocket/socketServer.ts')).not.toMatch(/\bio\.fetchSockets\(/);
  });
});

describe('deleting a space never waits on every node', () => {
  // A room-scoped fetchSockets() has the same failure mode: it waits for every
  // node's reply and throws after 5 s when one peer is unresponsive. The space
  // delete route fetched the sockets of each of its rooms to make them leave,
  // so a stalled node sharing the Redis answered the delete with a 500 after
  // 5010 ms. Room membership is an adapter operation (`socketsLeave`).
  it('routes/servers.ts calls no fetchSockets()', () => {
    expect(read('routes/servers.ts')).not.toMatch(/\.fetchSockets\(/);
  });
});
