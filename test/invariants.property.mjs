/**
 * Laws of the peer system's safety invariants, checked by fast-check.
 *
 * I1 — a message reaches only the instance it was resolved to.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import fc from 'fast-check';

const { peerSocketAddress, requestPeer, sendToPeer, startPeerServer } = await import('../dist/index.js');

let STATE;
before(async () => {
  STATE = await mkdtemp(join(tmpdir(), 'peers-laws-'));
  await mkdir(join(STATE, 'peers'), { recursive: true });
});
after(async () => {
  await rm(STATE, { recursive: true, force: true });
});

/** A server that records what reached its host. */
async function serve(pid, id) {
  const reached = [];
  const address = peerSocketAddress(STATE, pid);
  const server = startPeerServer({
    address,
    ownName: () => `srv-${id}`,
    ownId: () => id,
    coalesceMs: 1,
    onMessage: async (msg) => {
      reached.push(msg);
      return 'injected';
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  return { id, address, reached, stop: () => server.stop() };
}

function record(name, socket, instanceId) {
  return {
    v: 1,
    pid: 1,
    name,
    cwd: '/w',
    project: 'w',
    harness: 'omp',
    sessionId: '',
    model: '',
    socket,
    startedAt: 1,
    beatAt: 1,
    busy: false,
    ...(instanceId !== undefined ? { instanceId } : {}),
  };
}

let unique = 0;

describe('I1: a message reaches only the instance it was resolved to', () => {
  let a;
  let b;
  before(async () => {
    a = await serve(48101, 'id-a');
    b = await serve(48102, 'id-b');
  });
  after(() => {
    a.stop();
    b.stop();
  });

  it('a receiver runs its host only for frames addressed to it, or to nobody', async () => {
    const toId = fc.option(fc.constantFrom('id-a', 'id-b', 'id-a-old', ''), { nil: undefined });
    await fc.assert(
      fc.asyncProperty(fc.array(toId, { minLength: 1, maxLength: 6 }), async (targets) => {
        a.reached.length = 0;
        const replies = await Promise.all(
          targets.map((target) => {
            unique += 1;
            return requestPeer(a.address, {
              t: 'msg',
              from: `s${unique}`,
              fromId: `sender-${unique}`,
              body: `m${unique}`,
              hop: 0,
              ...(target !== undefined ? { toId: target } : {}),
            });
          })
        );
        const accepted = targets.filter((target) => target === undefined || target === 'id-a').length;
        assert.equal(a.reached.length, accepted);
        targets.forEach((target, index) => {
          if (target !== undefined && target !== 'id-a') {
            assert.deepEqual(replies[index], { ok: false, error: 'wrong peer' });
          }
        });
      }),
      { numRuns: 60 }
    );
  });

  it('a send is delivered at most once, and only where the id it resolved answers', async () => {
    // Each listing names `x` at one of two servers, claiming either id or none
    // (a peer older than instance ids). The first listing may be stale; the
    // send may re-list once.
    const entry = fc.record({
      at: fc.constantFrom('a', 'b'),
      claims: fc.option(fc.constantFrom('id-a', 'id-b'), { nil: undefined }),
    });
    await fc.assert(
      fc.asyncProperty(entry, entry, async (first, fresh) => {
        const servers = { a, b };
        a.reached.length = 0;
        b.reached.length = 0;
        const rosters = [first, fresh].map((e) => [record('x', servers[e.at].address, e.claims)]);
        let listings = 0;
        unique += 1;
        const receipt = await sendToPeer('x', `hello ${unique}`, {
          ownName: 'me',
          ownId: `me-${unique}`,
          hop: 0,
          listPeers: async () => rosters[Math.min(listings++, 1)],
        });
        // The oracle: where the message must land, if anywhere.
        const answers = (e) => e.claims === undefined || e.claims === servers[e.at].id;
        const expected = answers(first)
          ? first.at
          : fresh.claims !== first.claims && answers(fresh)
            ? fresh.at
            : undefined;
        assert.equal(a.reached.length, expected === 'a' ? 1 : 0, 'deliveries at a');
        assert.equal(b.reached.length, expected === 'b' ? 1 : 0, 'deliveries at b');
        if (expected !== undefined) assert.match(receipt, /^Delivered to x/);
        else assert.doesNotMatch(receipt, /^Delivered/);
      }),
      { numRuns: 60 }
    );
  });
});
