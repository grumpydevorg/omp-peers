/**
 * Laws of the peer system's safety invariants, checked by fast-check.
 *
 * I1 — a message reaches only the instance it was resolved to.
 * I3 — a presence file is deleted only by its owner, or once its instance
 *      is proven dead.
 */

import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import fc from 'fast-check';

const { PEER_TTL_MS, listLivePeers, peerSocketAddress, reapPeer, requestPeer, sendToPeer, startPeerServer } =
  await import('../dist/index.js');

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

describe('I3: only the owner, or proof of death, deletes a presence file', () => {
  const NOW = 10_000_000;
  let run = 0;

  /** A fresh state dir holding `entries`; returns what each file should be judged by. */
  async function layout(entries) {
    run += 1;
    const state = join(STATE, `reap-${run}`);
    const dir = join(state, 'peers');
    await mkdir(dir, { recursive: true });
    for (const e of entries) {
      const socket = peerSocketAddress(state, e.pid);
      const body = e.malformed
        ? { v: 1, pid: e.pid, name: 'broken' }
        : {
            ...record(`p${e.pid}`, socket, `inst-${e.pid}`),
            pid: e.pid,
            beatAt: e.stale ? NOW - PEER_TTL_MS - 1 : NOW,
          };
      if (e.file) await writeFile(join(dir, `${e.pid}.json`), `${JSON.stringify(body)}\n`);
      if (e.socketFile) await writeFile(socket, '');
    }
    return { state, dir };
  }

  const present = (path) =>
    access(path).then(
      () => true,
      () => false
    );

  const entries = fc.uniqueArray(
    fc.record({
      pid: fc.integer({ min: 1000, max: 1015 }),
      pidAlive: fc.boolean(),
      stale: fc.boolean(),
      probe: fc.constantFrom('alive', 'dead', 'unknown'),
      malformed: fc.boolean(),
      file: fc.boolean(),
      socketFile: fc.boolean(),
    }),
    { selector: (e) => e.pid, maxLength: 8 }
  );

  it('listing deletes exactly the files of proven-dead instances, and lists the rest', async () => {
    await fc.assert(
      fc.asyncProperty(entries, async (es) => {
        const { state, dir } = await layout(es);
        const table = new Map(es.map((e) => [e.pid, e]));
        const listed = await listLivePeers(state, 0, {
          now: NOW,
          isAlive: (pid) => table.get(pid)?.pidAlive ?? false,
          probe: async (r) => table.get(r.pid)?.probe ?? 'unknown',
        });
        for (const e of es) {
          const dead = !e.pidAlive || (!e.malformed && e.stale && e.probe === 'dead');
          if (e.file) {
            assert.equal(await present(join(dir, `${e.pid}.json`)), !dead, `record of ${JSON.stringify(e)}`);
          }
          if (e.socketFile) {
            // A socket belongs to its pid: only a gone pid loses it.
            assert.equal(await present(peerSocketAddress(state, e.pid)), e.pidAlive, `socket of ${JSON.stringify(e)}`);
          }
        }
        const expected = es.filter((e) => e.file && !e.malformed && e.pidAlive && !(e.stale && e.probe === 'dead'));
        assert.deepEqual(listed.map((r) => r.pid).sort(), expected.map((e) => e.pid).sort());
      }),
      { numRuns: 150 }
    );
  });

  it('a reap never deletes a file its owner rewrote since the reaper read it', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.boolean(), fc.boolean(), async (pidAlive, rewritten, newInstance) => {
        const { state, dir } = await layout([
          { pid: 1000, pidAlive, stale: true, probe: 'dead', malformed: false, file: true, socketFile: false },
        ]);
        const [seen] = await listLivePeers(state, 0, { now: NOW, isAlive: () => true, probe: async () => 'alive' });
        if (rewritten) {
          const next = { ...seen, beatAt: NOW + 1, ...(newInstance ? { instanceId: 'inst-new' } : {}) };
          await writeFile(join(dir, '1000.json'), `${JSON.stringify(next)}\n`);
        }
        await reapPeer(state, seen, { now: NOW, isAlive: () => pidAlive, probe: async () => 'dead' });
        assert.equal(await present(join(dir, '1000.json')), rewritten, 'deleted only the version judged');
      }),
      { numRuns: 20 }
    );
  });

  it('the ping probe calls dead only a refused socket or another instance answering', async () => {
    const pid = 48201;
    const socket = peerSocketAddress(STATE, pid);
    const listed = () =>
      listLivePeers(STATE, 0, { now: NOW, isAlive: () => true }).then((live) => live.some((l) => l.pid === pid));
    const write = (instanceId) =>
      writeFile(
        join(STATE, 'peers', `${pid}.json`),
        `${JSON.stringify({ ...record('probe-me', socket, instanceId), pid, beatAt: NOW - PEER_TTL_MS - 1 })}\n`
      );
    // No socket at all: dead.
    await write('inst-x');
    assert.equal(await listed(), false);
    // A live server answering as the same instance: alive.
    const srv = await serve(pid, 'inst-x');
    await write('inst-x');
    assert.equal(await listed(), true);
    // The same socket answering as another instance: dead.
    await write('inst-old');
    assert.equal(await listed(), false);
    srv.stop();
    const leftovers = await readdir(join(STATE, 'peers'));
    assert.ok(!leftovers.includes(`${pid}.json`));
  });
});
