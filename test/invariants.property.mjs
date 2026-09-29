/**
 * Laws of the peer system's safety invariants, checked by fast-check.
 *
 * I1 — a message reaches only the instance it was resolved to.
 * I2 — once a node is stopped, it writes nothing more (its beat loop is
 *      single-flight and stop is final).
 * I3 — a presence file is deleted only by its owner, or once its instance
 *      is proven dead.
 * I5 — every accepted message reaches exactly one end, and the sender's
 *      receipt never claims more than that end.
 * I6 — a reader never sees a torn presence record while its owner rewrites it
 *      (POSIX; Windows copies over the target and relies on a read retry).
 * I7 — a node's record appears only once its socket accepts connections.
 * I8 — while a node has left the peer list, nothing reaches its host, and
 *      every sender's receipt says what happened.
 */

import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import fc from 'fast-check';

const {
  PEER_TTL_MS,
  createBeatLoop,
  durableWriteJson,
  createHeldQueue,
  listLivePeers,
  peerSocketAddress,
  reapPeer,
  requestPeer,
  sendToPeer,
  startPeerServer,
} = await import('../dist/index.js');

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

describe('I2: a stopped node writes nothing more', () => {
  it('the beat loop is single-flight, loses no request, and stop is final — in every interleaving', async () => {
    const command = fc.constantFrom('request', 'request', 'stop');
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(command, { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 3 }),
        async (s, commands, awaitsPerRun) => {
          let clock = 0;
          let active = 0;
          let maxActive = 0;
          let stopAt;
          const runs = [];
          const requests = [];
          const activeAtStopSettle = [];
          const loop = createBeatLoop(
            async () => {
              const run = { start: ++clock, end: undefined };
              runs.push(run);
              active += 1;
              maxActive = Math.max(maxActive, active);
              // A heartbeat awaits I/O (listing, writing) between its steps.
              for (let i = 0; i < awaitsPerRun; i += 1) await s.schedule(Promise.resolve(i), 'job I/O');
              active -= 1;
              run.end = ++clock;
            },
            () => undefined
          );
          const issued = commands.map((c, i) =>
            s.schedule(Promise.resolve(c), `command ${i}`).then(() => {
              if (c === 'request') {
                const r = { at: ++clock, settledAt: undefined };
                requests.push(r);
                return loop.request().then(() => {
                  r.settledAt = ++clock;
                });
              }
              stopAt ??= ++clock;
              return loop.stop().then(() => {
                activeAtStopSettle.push(active);
              });
            })
          );
          await s.waitFor(Promise.all(issued));

          assert.ok(maxActive <= 1, `${maxActive} runs at once`);
          for (const run of runs) assert.ok(stopAt === undefined || run.start < stopAt, 'a run started after stop');
          for (const count of activeAtStopSettle) assert.equal(count, 0, 'stop settled with a run in flight');
          for (const r of requests) {
            assert.ok(r.settledAt !== undefined, 'a request never settled');
            const served = runs.some((run) => run.start > r.at && run.end !== undefined && run.end < r.settledAt);
            const released = stopAt !== undefined && r.settledAt > stopAt;
            assert.ok(served || released, `request at ${r.at} settled at ${r.settledAt} without a fresh run`);
          }
        }
      ),
      { numRuns: 300 }
    );
  });
});

describe('I5: every accepted message ends exactly once, as its receipt says', () => {
  let pid = 48300;

  it('every member of a coalesced batch gets the batch outcome, or all are refused at stop', async () => {
    const outcome = fc.constantFrom('injected', 'woken', 'held', 'aside', 'dropped', 'throw');
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), outcome, fc.boolean(), async (burst, result, stopInWindow) => {
        pid += 1;
        const address = peerSocketAddress(STATE, pid);
        const calls = [];
        const server = startPeerServer({
          address,
          ownName: () => 'receiver',
          ownId: () => 'receiver-id',
          coalesceMs: 150,
          onMessage: async (msg) => {
            calls.push(msg);
            if (result === 'throw') throw new Error('host failed');
            return result;
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        try {
          const bodies = Array.from({ length: burst }, (_, i) => `body-${pid}-${i}`);
          const replies = Promise.all(
            bodies.map((body) => requestPeer(address, { t: 'msg', from: 'sender', fromId: 'sid', body, hop: 0 }))
          );
          if (stopInWindow) setTimeout(() => server.stop(), 40);
          const answers = await replies;
          if (stopInWindow) {
            assert.equal(calls.length, 0, 'a refused batch reached the host');
            for (const a of answers) assert.deepEqual(a, { ok: false, error: 'peer shutting down' });
            return;
          }
          assert.equal(calls.length, 1, 'one batch, one host call');
          for (const body of bodies) assert.ok(calls[0].body.includes(body), `${body} in the delivered batch`);
          const expected = result === 'throw' ? { ok: false, error: 'host failed' } : { ok: true, outcome: result };
          for (const a of answers) assert.deepEqual(a, expected);
        } finally {
          server.stop();
        }
      }),
      { numRuns: 30 }
    );
  });

  it('a held batch is delivered or its sender told, exactly once, in every interleaving', async () => {
    const fate = fc.constantFrom('woken', 'aside', 'dropped', 'throw');
    // Weighted toward what makes the queue interesting: more holds than the
    // limit arriving while a retry is delivering, with the peer not typing.
    const command = fc.oneof(
      { arbitrary: fate.map((f) => ({ kind: 'hold', fate: f })), weight: 4 },
      { arbitrary: fc.constant({ kind: 'retry' }), weight: 2 },
      { arbitrary: fc.boolean().map((typing) => ({ kind: 'typing', typing })), weight: 1 },
      { arbitrary: fc.constant({ kind: 'drain' }), weight: 1 }
    );
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(command, { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 1, max: 2 }),
        async (s, commands, max) => {
          let typing = true;
          let nextId = 0;
          const fates = new Map();
          const ends = new Map(); // id → ['delivered' | 'dropped: <reason>']
          const end = (id, what) => ends.set(id, [...(ends.get(id) ?? []), what]);
          let largest = 0;
          const queue = createHeldQueue({
            max,
            onError: () => undefined,
            deliver: async (batch) => {
              await s.schedule(Promise.resolve(), `deliver ${batch.message.body}`);
              const f = fates.get(batch.message.body);
              if (typing) return 'held';
              if (f === 'throw') throw new Error('host failed');
              if (f !== 'dropped') end(batch.message.body, 'delivered');
              return f;
            },
            dropped: async (batch, reason) => {
              await s.schedule(Promise.resolve(), `notify ${batch.message.body}`);
              end(batch.message.body, `dropped: ${reason}`);
            },
          });
          const issued = commands.map((c, i) =>
            s.schedule(Promise.resolve(), `command ${i}`).then(() => {
              if (c.kind === 'hold') {
                nextId += 1;
                const id = `m${nextId}`;
                fates.set(id, c.fate);
                queue.hold({ message: { from: 'sender', body: id, hop: 0 }, receivedAt: 0 });
                largest = Math.max(largest, queue.size);
                return undefined;
              }
              if (c.kind === 'typing') {
                typing = c.typing;
                return undefined;
              }
              return c.kind === 'retry' ? queue.retry() : queue.drain('the peer shut down');
            })
          );
          await s.waitFor(Promise.all(issued).then(() => queue.drain('the peer shut down')));

          assert.ok(largest <= max, `${largest} batches held with a limit of ${max}`);
          assert.equal(queue.size, 0, 'batches left after drain');
          for (const id of fates.keys()) {
            assert.equal(ends.get(id)?.length, 1, `${id} ended ${JSON.stringify(ends.get(id) ?? [])}`);
          }
        }
      ),
      { numRuns: 1000 }
    );
  });
});

describe('I6: a record is replaced atomically', { skip: process.platform === 'win32' }, () => {
  it('a reader with no retry parses every read while the owner rewrites the record', async () => {
    const file = join(STATE, 'atomic.json');
    // Large enough that a non-atomic replace is observable mid-write.
    const pad = 'x'.repeat(200_000);
    await durableWriteJson(file, { n: 0, pad });
    let writing = true;
    let reads = 0;
    const torn = [];
    const writer = (async () => {
      for (let n = 1; n <= 200; n += 1) await durableWriteJson(file, { n, pad });
      writing = false;
    })();
    while (writing) {
      reads += 1;
      const raw = await readFile(file, 'utf8');
      try {
        JSON.parse(raw);
      } catch {
        torn.push(raw.length);
      }
    }
    await writer;
    assert.ok(reads > 100, `only ${reads} reads raced the writer`);
    assert.deepEqual(torn, [], `${torn.length} of ${reads} reads were torn`);
  });
});

describe('I7: a record is published only once its socket listens', () => {
  it('listening settles true exactly when the socket accepts, false on a failed or aborted listen', async () => {
    const ok = startPeerServer({
      address: peerSocketAddress(STATE, 48500),
      ownName: () => 'l',
      ownId: () => 'l-id',
      onMessage: async () => 'injected',
    });
    assert.equal(await ok.listening, true);
    assert.equal((await requestPeer(ok.address, { t: 'ping', from: 'x' }))?.ok, true);
    ok.stop();
    const aborted = startPeerServer({
      address: peerSocketAddress(STATE, 48501),
      ownName: () => 'a',
      ownId: () => 'a-id',
      onMessage: async () => 'injected',
    });
    aborted.stop();
    assert.equal(await aborted.listening, false);
    if (process.platform !== 'win32') {
      const failed = startPeerServer({
        address: join(STATE, 'no-such-dir', 'x.sock'),
        ownName: () => 'f',
        ownId: () => 'f-id',
        onMessage: async () => 'injected',
      });
      assert.equal(await failed.listening, false);
      failed.stop();
    }
  });

  it('the first record a booting node writes points at a socket that answers', async () => {
    process.env.OMP_PEERS_DIR = STATE;
    const record = join(STATE, 'peers', `${process.pid}.json`);
    const handlers = {};
    const peersExtension = (await import('../dist/extension.js')).default;
    peersExtension({
      registerCommand: () => {},
      registerTool: () => {},
      on: (event, handler) => {
        handlers[event] = handler;
      },
      sendUserMessage: () => {},
    });
    handlers['session_start'](undefined, {
      cwd: join(STATE, 'booting'),
      mode: 'tui',
      ui: { notify: () => {} },
      sessionManager: { getSessionId: () => 'sess-booting' },
      isIdle: () => true,
    });
    // A beat requested during boot, as /peers or a todo hook would.
    handlers['todo_reminder']();
    try {
      let seen;
      for (let i = 0; i < 2000 && seen === undefined; i += 1) {
        seen = await readFile(record, 'utf8').then(JSON.parse, () => undefined);
        if (seen === undefined) await new Promise((r) => setImmediate(r));
      }
      assert.ok(seen !== undefined, 'the node never published');
      const pong = await requestPeer(seen.socket, { t: 'ping', from: 'x' });
      assert.deepEqual(pong, { ok: true, name: seen.name, id: seen.instanceId });
    } finally {
      handlers['session_shutdown']();
      await new Promise((r) => setTimeout(r, 200));
    }
  });
});

describe('I8: a node that left lets nothing reach its host', () => {
  let pid = 48600;

  it('leaves and joins racing sends and coalesce windows: the host sees nothing while left, and every receipt matches', async () => {
    const step = fc.oneof(
      { arbitrary: fc.record({ kind: fc.constant('send'), sender: fc.constantFrom('s1', 's2') }), weight: 3 },
      { arbitrary: fc.constant({ kind: 'toggle' }), weight: 1 }
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(step, fc.integer({ min: 0, max: 40 })), { minLength: 1, maxLength: 10 }),
        async (steps) => {
          pid += 1;
          let left = false;
          const reached = new Set();
          const server = startPeerServer({
            address: peerSocketAddress(STATE, pid),
            ownName: () => 'leaver',
            ownId: () => 'leaver-id',
            coalesceMs: 30,
            refuse: () => (left ? 'left' : undefined),
            onMessage: async (msg) => {
              assert.equal(left, false, `host reached while left: ${msg.body}`);
              for (const line of msg.body.split('\n')) {
                const body = /m\d+-\d+/.exec(line)?.[0];
                if (body !== undefined) reached.add(body);
              }
              return 'injected';
            },
          });
          assert.equal(await server.listening, true);
          try {
            const sends = [];
            let n = 0;
            for (const [s, wait] of steps) {
              await new Promise((r) => setTimeout(r, wait));
              if (s.kind === 'toggle') {
                left = !left;
                continue;
              }
              n += 1;
              const body = `m${pid}-${n}`;
              sends.push(
                requestPeer(server.address, { t: 'msg', from: s.sender, fromId: s.sender, body, hop: 0 }).then(
                  (reply) => ({
                    body,
                    reply,
                  })
                )
              );
            }
            for (const { body, reply } of await Promise.all(sends)) {
              if (reached.has(body)) assert.deepEqual(reply, { ok: true, outcome: 'injected' }, body);
              else assert.deepEqual(reply, { ok: false, error: 'left' }, body);
            }
          } finally {
            server.stop();
          }
        }
      ),
      { numRuns: 40 }
    );
  });

  it('/peers leave refuses messages, tells senders without a round trip, survives a resume; /peers join undoes it', async () => {
    process.env.OMP_PEERS_DIR = STATE;
    const branch = []; // The session's entries, as omp's getBranch returns them.
    const commands = {};
    const tools = {};
    const handlers = {};
    const peersExtension = (await import('../dist/extension.js')).default;
    peersExtension({
      registerCommand: (name, def) => {
        commands[name] = def;
      },
      registerTool: (def) => {
        tools[def.name] = def;
      },
      on: (event, handler) => {
        handlers[event] = handler;
      },
      sendUserMessage: () => {},
      appendEntry: (customType, data) => branch.push({ type: 'custom', customType, data }),
    });
    const notes = [];
    const ctx = {
      cwd: join(STATE, 'leaver'),
      mode: 'print',
      ui: { notify: (text) => notes.push(text) },
      sessionManager: { getSessionId: () => 'sess-leaver', getBranch: () => branch },
      isIdle: () => true,
    };
    const recordFile = join(STATE, 'peers', `${process.pid}.json`);
    const read = () => readFile(recordFile, 'utf8').then(JSON.parse);
    const boot = async () => {
      handlers['session_start'](undefined, ctx);
      for (let i = 0; i < 200; i += 1) {
        if (
          await read().then(
            () => true,
            () => false
          )
        )
          return;
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const sendAsOther = (to) =>
      sendToPeer(to, 'hello', {
        ownName: 'other',
        hop: 0,
        listPeers: async () => listLivePeers(STATE, 0),
      });
    await boot();
    try {
      const name = (await read()).name;
      assert.match(await sendAsOther(name), /^Delivered to/);

      await commands['peers'].handler('leave', ctx);
      assert.match(notes.at(-1), /Left the peer list/);
      const record = await read();
      assert.equal(typeof record.left, 'number', 'the record says it left');
      assert.equal(record.instanceId !== undefined, true);
      // Senders see it from the record, and a raw frame is refused unread.
      assert.match(await sendAsOther(name), /left the peer list at \d\d:\d\d/);
      const raw = await requestPeer(record.socket, { t: 'msg', from: 'x', body: 'sneak', hop: 0 });
      assert.deepEqual(raw, { ok: false, error: 'left' });
      // It cannot message out either, and its own note says so.
      const out = await tools['peer_send'].execute('1', { to: 'anyone', message: 'hi' });
      assert.match(out.content[0].text, /left the peer list/);
      const prompt = handlers['context']({ messages: [{ role: 'user', content: 'q' }] }, ctx);
      assert.match(prompt.messages.at(-1).content, /have left the peer list/);
      // Still listed (alive, answering pings), never reaped, and hidden from others' notes.
      assert.ok((await listLivePeers(STATE, 0)).some((p) => p.pid === process.pid));

      // Resume: the choice is read back from the session.
      handlers['session_shutdown']();
      await new Promise((r) => setTimeout(r, 300));
      await boot();
      assert.equal(typeof (await read()).left, 'number', 'still left after a resume');

      await commands['peers'].handler('join', ctx);
      assert.match(notes.at(-1), /Rejoined the peer list/);
      assert.equal((await read()).left, undefined);
      assert.match(await sendAsOther(name), /^Delivered to/);
      assert.deepEqual(
        branch.map((e) => e.data.left === null),
        [false, true],
        'one saved entry per choice'
      );
    } finally {
      handlers['session_shutdown']();
      await new Promise((r) => setTimeout(r, 300));
    }
  });
});
