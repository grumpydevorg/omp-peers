/**
 * peers OMP/pi extension entry.
 *
 * Install is opt-in; every running instance is auto-present via its
 * `<state>/peers/<pid>.json` heartbeat — no join/leave/channels. Peers are
 * reached only through the `peer_*` tools; they are never registered in the
 * host's agent registry, so `agent://` messaging, Agent Hub and subagents
 * stay local to their own instance. Explicit names only, no `to:all`.
 *
 * Identity is the ROOT session id; the name is derived from it (see
 * `peers/ids.ts`): the `/rename` name, else the checkout, else the directory,
 * with a session-id suffix when peers share a base. A rejected `/rename` name
 * pops one warning per process; later ones log only.
 *
 * Session discipline: NOTHING session-shaped is captured at boot or in the
 * factory closure. The freshest root-session `{pi, ctx}` is re-read from the
 * live getter on every delivery tick (updated by every root-session host
 * event below). Subagent sessions load this extension too; their events are
 * ignored, so a subagent never becomes the published identity.
 */

import { randomUUID } from 'node:crypto';
import { registerPeersCommand } from './commands/peers.js';
import { type BeatLoop, createBeatLoop } from './peers/beat.js';
import type { CommandContextLike, ExtensionHostLike } from './peers/host.js';
import { detectHarness, PRESENCE_ENTRY, readLeft, readNativeTodos, readTitleSource } from './peers/host.js';
import { chooseBase, directoryBase, isValidPeerName, nameRoster, peerKey } from './peers/ids.js';
import { createEnvLookups, type EnvLookups } from './peers/context.js';
import { createHeldQueue, type HeldQueue } from './peers/held.js';
import {
  deliverInboundPeerMessage,
  HOLD_POLL_MS,
  type HeldBatch,
  type InboundOutcome,
  MAX_HELD_BATCHES,
} from './peers/inbound.js';
import { sendToPeer } from './peers/outbound.js';
import {
  HEARTBEAT_MS,
  listLivePeers,
  reapPeer,
  removeOwnRecord,
  startPresenceBeat,
  writePeerBeat,
} from './peers/presence.js';
import { appendNoteToMessages, buildPeersNote } from './peers/roster.js';
import type { RosterMessage } from './peers/roster.js';
import { LEFT, peerSocketAddress, startPeerServer } from './peers/server.js';
import type { InboundMessage, PeerServerHandle } from './peers/server.js';
import { ensureStateDirs, resolveStateDir } from './store/paths.js';
import { registerPeerSendTool, registerPeerStatusTool, registerPeerRequestTool } from './tools.js';
import type { PeerRecord, PeerTodo, PendingReply } from './types.js';

const HARNESS = await detectHarness();

/** How long a started tool keeps naming the peer's activity before busy/idle takes over. */
const ACTIVITY_FRESH_MS = 120_000;

interface NodeState {
  stateDir: string;
  pid: number;
  /** Random id of this node boot: published, answered on ping, checked against every frame's `toId`. */
  instanceId: string;
  startedAt: number;
  socketAddress: string;
  name: string;
  /** Name before any collision suffix. */
  base: string;
  /** Usable herdr tab label, published as an alias. */
  label: string | undefined;
  /** Names this peer published and gave up → when they stop answering. */
  previousNames: Map<string, number>;
  /** The name in the last presence record written; only published names become aliases. */
  publishedName: string | undefined;
  /** Root session id: this peer's identity. Never a subagent's. */
  sessionId: string;
  lookups: EnvLookups;
  peers: PeerRecord[];
  /** Wake timestamps per sender key ({@link peerKey}). */
  wakes: Map<string, number[]>;
  /** Sender key of the last message really delivered to this agent (undefined = fresh chain). */
  lastInboundPeer: string | undefined;
  /** Hop that last real delivery carried; 0 when there has been none. */
  lastInboundHop: number;
  /** Batches held while the peer types: each is delivered, or its sender told it never will be. */
  held: HeldQueue;
  holdTimer: NodeJS.Timeout | undefined;
  /** First rejected session name this process saw; doubles as the warned-once flag (undefined = never warned). */
  lastRejectedSessionName: string | undefined;
  current: { pi: ExtensionHostLike; ctx: CommandContextLike } | undefined;
  server: PeerServerHandle | undefined;
  stopBeat: (() => void) | undefined;
  /** Every beat runs through this: one at a time, and none after shutdown began. */
  beat: BeatLoop;
  /** The peer socket accepts connections; no beat publishes this node before it does. */
  listening: boolean;
  stopped: boolean;
  /** When this session left the peer list; undefined while it is in it. */
  left: number | undefined;
  /** Native host todo list, re-read from the session transcript on every tick. */
  nativeTodos: PeerTodo[];
  /** Last tool the agent started; published as activity while fresh. */
  nativeActivity: { text: string; at: number } | undefined;
  /** In-flight peer_request promises keyed by reply id. */
  pendingReplies: Map<string, PendingReply>;
}

/** One node per process, even when several sessions load the extension. */
let node: NodeState | undefined;

/** The live node for this process, if one is running. */
function liveNode(): NodeState | undefined {
  return node !== undefined && !node.stopped ? node : undefined;
}

function currentOf(): { pi: ExtensionHostLike; ctx: CommandContextLike } | undefined {
  return liveNode()?.current;
}

/** Hold a batch and make sure the retry poller runs; it stops once the queue is empty. */
function holdBatch(st: NodeState, msg: InboundMessage): void {
  st.held.hold({ message: { ...msg }, receivedAt: Date.now() });
  if (st.holdTimer !== undefined) return;
  st.holdTimer = setInterval(() => {
    void st.held.retry().then(() => {
      if (st.held.size === 0 && st.holdTimer !== undefined) {
        clearInterval(st.holdTimer);
        st.holdTimer = undefined;
      }
    });
  }, HOLD_POLL_MS);
  st.holdTimer.unref?.();
}

/** One delivery attempt of a held batch. */
async function deliverHeld(st: NodeState, batch: HeldBatch): Promise<InboundOutcome> {
  const res = await deliverInboundPeerMessage(batch.message, {
    getCurrent: () => currentOf(),
    getDraftText: () => {
      try {
        const text = currentOf()?.ctx.ui.getEditorText?.() ?? '';
        return typeof text === 'string' ? text : '';
      } catch {
        return '';
      }
    },
    receivedAt: batch.receivedAt,
    wakes: st.wakes,
  });
  // Only a real delivery advances the relay chain — 'held'/'dropped'/'aside'
  // never reached the agent, so they must not consume a hop.
  if (res.outcome === 'woken' || res.outcome === 'injected') {
    st.lastInboundPeer = peerKey(batch.message.fromId, batch.message.from);
    st.lastInboundHop = batch.message.hop;
  }
  return res.outcome;
}

/** The roster as this node sees it now: others under derived names, from the presence directory. */
async function rosterOf(st: NodeState): Promise<PeerRecord[]> {
  const records = await listLivePeers(st.stateDir, st.pid);
  return nameRoster(records, { pid: st.pid, base: st.base, sessionId: st.sessionId }).others;
}

/**
 * A held batch will never be delivered: its sender was told `held`, so it is
 * told this too — as an ack, a toast there that never wakes its agent.
 */
async function tellDropped(st: NodeState, batch: HeldBatch, reason: string): Promise<void> {
  const to =
    batch.message.fromId !== undefined && batch.message.fromId !== '' ? batch.message.fromId : batch.message.from;
  await sendToPeer(to, `Your message to \`${st.name}\` was not delivered: ${reason}.`, {
    ownName: st.name,
    ownId: st.sessionId,
    hop: 0,
    ack: true,
    listPeers: () => rosterOf(st),
  });
}

/** A held queue for the node `node()` returns; a rejoin gets a fresh one, since a drain is final. */
function newHeldQueue(node: () => NodeState): HeldQueue {
  return createHeldQueue({
    max: MAX_HELD_BATCHES,
    deliver: (batch) => deliverHeld(node(), batch),
    dropped: (batch, reason) => tellDropped(node(), batch, reason),
    onError: (err) => logOf(node(), `peers: held delivery failed: ${err instanceof Error ? err.message : String(err)}`),
  });
}

/** Drain `queue`, telling each held batch's sender `reason`; bounded so an unresponsive sender cannot stall. */
async function drainBounded(queue: HeldQueue, reason: string): Promise<void> {
  await Promise.race([
    queue.drain(reason),
    new Promise<void>((resolve) => setTimeout(resolve, DRAIN_NOTICE_MS).unref()),
  ]);
}

/** What this node's own sends return while it has left the peer list. */
const NOT_WHILE_LEFT = 'Not sent: this session has left the peer list. Your user can rejoin with `/peers join`.';

/**
 * Leave the peer list: from now on every message is refused with `left` —
 * the server checks on arrival and again before a coalesced batch reaches
 * the host. Held batches are dropped with their senders told, requests
 * waiting for replies end, and the next beat publishes `left` so senders
 * see it without a round trip. The node keeps beating and listening: its
 * name stays taken and no other peer reaps it as dead.
 */
async function leave(st: NodeState, at: number): Promise<void> {
  if (st.left !== undefined) return;
  st.left = at;
  for (const entry of st.pendingReplies.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error('this session left the peer list'));
  }
  st.pendingReplies.clear();
  if (st.holdTimer !== undefined) {
    clearInterval(st.holdTimer);
    st.holdTimer = undefined;
  }
  const held = st.held;
  st.held = newHeldQueue(() => st);
  await drainBounded(held, 'the peer left the peer list');
  await st.beat.request();
}

/** Rejoin: messages are accepted again, and the next beat drops `left`. */
async function join(st: NodeState): Promise<void> {
  if (st.left === undefined) return;
  st.left = undefined;
  await st.beat.request();
}

/** Take on a session's choice after a switch: `left` is when it left, or undefined. */
async function followSession(st: NodeState, left: number | undefined): Promise<void> {
  if (left !== undefined) await leave(st, left);
  else await join(st);
}

function warnOf(st: NodeState, text: string): void {
  try {
    st.current?.ctx.ui.notify(text, 'warning');
  } catch {
    // Warnings never throw into the host.
  }
}

function logOf(st: NodeState, text: string): void {
  try {
    st.current?.pi.logger?.warn(text);
  } catch {
    // Logging never throws into the host.
  }
}

/** Read one host fact; a throw is logged and becomes `fallback`. */
function hostRead<T>(st: NodeState, what: string, read: () => T, fallback: T): T {
  try {
    return read();
  } catch (err) {
    logOf(st, `peers: reading ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
}

/** How long a name this peer gave up keeps answering, as an alias. */
const PREVIOUS_NAME_MS = 10 * 60_000;

/** Longest shutdown waits to tell held batches' senders they will not be delivered. */
const DRAIN_NOTICE_MS = 1_500;

/**
 * This peer's name and the other records' names, derived from one set with
 * this peer's current base. Records the name it replaces so senders
 * mid-conversation still reach it for a while. Returns the others, named.
 */
function assignName(st: NodeState, base: string, others: PeerRecord[]): PeerRecord[] {
  const roster = nameRoster(others, { pid: st.pid, base, sessionId: st.sessionId });
  const next = roster.self;
  // Only a name other peers could have learned is worth keeping: one held
  // briefly before the first beat was never seen.
  if (st.publishedName !== undefined && st.publishedName.toLowerCase() !== next.toLowerCase()) {
    st.previousNames.set(st.publishedName, Date.now() + PREVIOUS_NAME_MS);
  }
  st.previousNames.delete(next);
  st.base = base;
  st.name = next;
  return roster.others;
}

/** Tab label (when a usable name) plus names held in the last minutes. */
function currentAliases(st: NodeState): string[] {
  const now = Date.now();
  for (const [old, until] of st.previousNames) if (until <= now) st.previousNames.delete(old);
  const aliases = [...st.previousNames.keys()];
  if (st.label !== undefined && st.label.toLowerCase() !== st.name.toLowerCase()) aliases.unshift(st.label);
  return aliases;
}

/** The base name for the current host session and working directory. */
function currentBase(st: NodeState, cwd: string): string {
  const ctx = st.current?.ctx;
  const sessionName = hostRead(
    st,
    'session name',
    () => st.current?.pi.getSessionName?.() ?? ctx?.sessionManager?.getSessionName?.(),
    undefined
  );
  const chosen = chooseBase({
    sessionName,
    titleSource: readTitleSource(ctx?.sessionManager),
    dirBase: directoryBase(cwd, st.lookups.gitTopLevel(cwd)),
  });
  if (chosen.rejected !== undefined && chosen.rejected !== st.lastRejectedSessionName) {
    const first = st.lastRejectedSessionName === undefined;
    st.lastRejectedSessionName = chosen.rejected;
    const text =
      `session name "${chosen.rejected}" can't be a peer name (1-24 of a-z A-Z 0-9 _ . -, not all digits, not main/all/self); ` +
      `using ${chosen.base} — /rename the session to a valid name`;
    if (first) warnOf(st, text);
    else logOf(st, `peers: ${text}`);
  }
  return chosen.base;
}

async function tick(st: NodeState): Promise<void> {
  const ctx = st.current?.ctx;
  const cwd = typeof ctx?.cwd === 'string' && ctx.cwd !== '' ? ctx.cwd : process.cwd();
  st.sessionId = hostRead(st, 'session id', () => ctx?.sessionManager?.getSessionId?.() ?? '', '');
  const model = hostRead(st, 'model', () => ctx?.model?.id ?? '', '');
  const busy = hostRead(st, 'idle state', () => !(ctx?.isIdle?.() ?? true), false);
  const rawLabel = st.lookups.tabLabel();
  st.label = rawLabel !== undefined && isValidPeerName(rawLabel) ? rawLabel : undefined;
  const base = currentBase(st, cwd);
  let listed: PeerRecord[] | undefined;
  try {
    listed = await listLivePeers(st.stateDir, st.pid);
  } catch (err) {
    // Transient listing failure: fall back to the last-good roster below.
    logOf(st, `peers: listing peers failed: ${err instanceof Error ? err.message : String(err)}`);
    listed = undefined;
  }
  const others = assignName(st, base, listed ?? st.peers);
  st.nativeTodos = readNativeTodos(ctx?.sessionManager);
  const lastActivity = st.nativeActivity;
  const activity =
    lastActivity !== undefined && Date.now() - lastActivity.at <= ACTIVITY_FRESH_MS
      ? lastActivity.text
      : busy
        ? 'working'
        : undefined;
  let own: PeerRecord | undefined;
  try {
    own = await writePeerBeat({
      stateDir: st.stateDir,
      pid: st.pid,
      name: st.name,
      base: st.base,
      ...(st.label !== undefined ? { label: st.label } : {}),
      aliases: currentAliases(st),
      cwd,
      harness: HARNESS,
      ...(st.sessionId !== '' ? { sessionId: st.sessionId } : {}),
      ...(model !== '' ? { model } : {}),
      socket: st.socketAddress,
      instanceId: st.instanceId,
      startedAt: st.startedAt,
      busy,
      ...(activity !== undefined && activity !== '' ? { activity } : {}),
      ...(st.nativeTodos.length > 0 ? { todos: st.nativeTodos } : {}),
      ...(st.left !== undefined ? { left: st.left } : {}),
    });
    st.publishedName = own.name;
  } catch (err) {
    logOf(st, `peers: heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  st.peers = own !== undefined ? [...others, own].sort((a, b) => a.name.localeCompare(b.name)) : others;
}

function armBeatTimer(st: NodeState, ctx: CommandContextLike): void {
  try {
    st.stopBeat?.();
  } catch {
    // Replacing a dead timer must not break re-arm.
  }
  const managed =
    typeof ctx.setInterval === 'function' && typeof ctx.clearTimer === 'function'
      ? { setInterval: ctx.setInterval.bind(ctx), clearTimer: ctx.clearTimer.bind(ctx) }
      : {};
  st.stopBeat = startPresenceBeat(() => st.beat.request(), {
    intervalMs: HEARTBEAT_MS,
    onError: (err) => logOf(st, `peers: tick failed: ${err instanceof Error ? err.message : String(err)}`),
    ...managed,
  }).stop;
}

/**
 * True for events from a subagent session. The extension is loaded into
 * every session in the process; only the root session is the peer, so a
 * subagent's context must never become `current` — its session id, cwd and
 * name would be published as this peer's identity.
 */
function isSubagent(ctx: CommandContextLike): boolean {
  return ctx.agent?.kind === 'sub';
}

/** Get the live node, starting one if this process has none. Re-arms on every root-session event. */
function ensureNode(pi: ExtensionHostLike, ctx: CommandContextLike): NodeState | undefined {
  if (isSubagent(ctx)) return undefined;
  const existing = liveNode();
  if (existing !== undefined) {
    existing.current = { pi, ctx };
    let sessionId = '';
    try {
      sessionId = ctx.sessionManager?.getSessionId?.() ?? '';
    } catch {
      sessionId = '';
    }
    if (sessionId !== '' && sessionId !== existing.sessionId) {
      // Leaving belongs to a session: a switch takes on the new session's choice.
      void followSession(existing, readLeft(ctx.sessionManager));
      if (existing.listening) armBeatTimer(existing, ctx);
    }
    return existing;
  }
  try {
    const stateDir = resolveStateDir();
    const st: NodeState = {
      stateDir,
      pid: process.pid,
      instanceId: randomUUID(),
      startedAt: Date.now(),
      socketAddress: peerSocketAddress(stateDir, process.pid),
      name: '',
      base: '',
      label: undefined,
      previousNames: new Map<string, number>(),
      publishedName: undefined,
      sessionId: '',
      lookups: createEnvLookups({ onError: (text) => logOf(st, text) }),
      peers: [],
      wakes: new Map<string, number[]>(),
      lastInboundPeer: undefined,
      lastInboundHop: 0,
      held: newHeldQueue(() => st),
      holdTimer: undefined,
      current: { pi, ctx },
      server: undefined,
      stopBeat: undefined,
      beat: createBeatLoop(
        () => (st.listening ? tick(st) : Promise.resolve()),
        (err) => logOf(st, `peers: tick failed: ${err instanceof Error ? err.message : String(err)}`)
      ),
      lastRejectedSessionName: undefined,
      listening: false,
      stopped: false,
      nativeTodos: [],
      nativeActivity: undefined,
      pendingReplies: new Map<string, PendingReply>(),
      left: readLeft(ctx.sessionManager),
    };
    const cwd = typeof ctx.cwd === 'string' && ctx.cwd !== '' ? ctx.cwd : process.cwd();
    st.sessionId = hostRead(st, 'session id', () => ctx.sessionManager?.getSessionId?.() ?? '', '');
    assignName(st, directoryBase(cwd), []);
    node = st;
    void Promise.all([ensureStateDirs(stateDir), st.lookups.prime(cwd)])
      .then(() => {
        if (st.stopped) return;
        st.server = startPeerServer({
          address: st.socketAddress,
          ownName: () => liveNode()?.name ?? '',
          ownId: () => st.instanceId,
          onMessage: async (msg) => {
            const live = liveNode();
            const replyTo = msg.replyTo;
            const entry =
              live !== undefined && replyTo !== undefined && replyTo !== ''
                ? live.pendingReplies.get(replyTo)
                : undefined;
            if (live !== undefined && replyTo !== undefined && entry !== undefined) {
              live.pendingReplies.delete(replyTo);
              clearTimeout(entry.timer);
              entry.resolve(msg.body);
              live.lastInboundPeer = peerKey(msg.fromId, msg.from);
              live.lastInboundHop = msg.hop;
              return 'replied';
            }
            const res = await deliverInboundPeerMessage(msg, {
              getCurrent: () => currentOf(),
              getDraftText: () => {
                try {
                  const text = currentOf()?.ctx.ui.getEditorText?.() ?? '';
                  return typeof text === 'string' ? text : '';
                } catch {
                  return '';
                }
              },
              ...(live !== undefined ? { wakes: live.wakes } : {}),
            });
            // Only a real delivery advances the relay chain — 'held'/'dropped'/
            // 'aside' never reached the agent, so they must not consume a hop.
            if ((res.outcome === 'woken' || res.outcome === 'injected') && live !== undefined) {
              live.lastInboundPeer = peerKey(msg.fromId, msg.from);
              live.lastInboundHop = msg.hop;
            }
            if (res.outcome === 'held' && live !== undefined) holdBatch(live, msg);
            return res.outcome;
          },
          refuse: () => (st.left !== undefined ? LEFT : undefined),
          onWarn: (text) => {
            const live = liveNode();
            if (live !== undefined) warnOf(live, text);
          },
        });
        return st.server.listening;
      })
      .then((listening) => {
        if (st.stopped) return;
        if (!listening) {
          warnOf(st, 'peers: could not listen on the peer socket — not joining the peer list');
          return;
        }
        // Published only now: a record whose socket is not yet listening turns
        // sends away. The timer beats once immediately, then every HEARTBEAT_MS.
        st.listening = true;
        armBeatTimer(st, ctx);
      })
      .catch((err: unknown) => {
        try {
          ctx.ui.notify(`peers: could not start — ${err instanceof Error ? err.message : String(err)}`, 'warning');
        } catch {
          // Boot failures never throw into the host.
        }
      });
    return st;
  } catch (err) {
    node = undefined;
    try {
      pi.logger?.warn(`peers: could not start (${String(err)})`);
    } catch {
      // Logging never throws.
    }
    return undefined;
  }
}
async function stopNode(st: NodeState): Promise<void> {
  st.stopped = true;
  // A successor node for this same pid may already exist (session_switch →
  // ensureNode after `node` was cleared). When it does, this teardown must
  // not delete the successor's live record or socket file.
  const hasSuccessor = (): boolean => {
    const successor = liveNode();
    return successor !== undefined && successor !== st;
  };
  try {
    st.stopBeat?.();
  } catch {
    // Shutdown never throws.
  }
  st.stopBeat = undefined;
  // The beat in flight finishes before the record is unlinked below, and no
  // beat starts after this: a stopped node is never written back.
  await st.beat.stop();
  if (st.holdTimer !== undefined) {
    try {
      clearInterval(st.holdTimer);
    } catch {
      // Shutdown never throws.
    }
    st.holdTimer = undefined;
  }
  for (const entry of st.pendingReplies.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error('shutting down'));
  }
  st.pendingReplies.clear();
  try {
    st.server?.stop({ unlinkSocket: !hasSuccessor() });
  } catch {
    // Shutdown never throws.
  }
  st.server = undefined;
  // Senders of held batches were told `held`: each now hears its batch will
  // not be delivered. Bounded, so a peer that does not answer cannot stall
  // shutdown.
  await drainBounded(st.held, 'the peer shut down');
  if (hasSuccessor()) return;
  try {
    await removeOwnRecord(st.stateDir, st.pid);
  } catch {
    // Final unlink is best-effort.
  }
}

export default function peersExtension(pi: ExtensionHostLike): void {
  // Sends resolve names from the presence directory at call time, not from
  // the heartbeat cache: a /rename reaches the directory at the renamer's next
  // beat, and a cached roster answers "Unknown peer" until the sender's own
  // next beat as well. The pid filter drops our own record, so a stale own
  // name (post-/rename) can't route a send back to ourselves.
  const freshPeers = async () => {
    const st = liveNode();
    return st === undefined ? [] : rosterOf(st);
  };

  registerPeersCommand(pi, {
    getSnapshot: async () => {
      const st = liveNode();
      if (st !== undefined) {
        // Fresh beat before rendering: a just-run /rename must be visible
        // immediately, not on the next 15s tick. The loop owns its failures.
        await st.beat.request();
        return {
          ownName: st.name,
          peers: st.peers,
          held: st.held.size,
          ...(st.left !== undefined ? { left: st.left } : {}),
        };
      }
      return { ownName: '', peers: [], held: 0 };
    },
    cachedSnapshot: () => {
      const st = liveNode();
      return st !== undefined ? { ownName: st.name, peers: st.peers, held: st.held.size } : { ownName: '', peers: [] };
    },
    // Typed by the user, so it starts a fresh chain: hop 0, never a relay.
    sendAsUser: (to, body) => {
      const st = liveNode();
      if (st?.left !== undefined) return Promise.resolve(NOT_WHILE_LEFT);
      return sendToPeer(to, body, {
        ownName: st?.name ?? '',
        ...(st !== undefined ? { ownId: st.sessionId } : {}),
        hop: 0,
        human: true,
        listPeers: freshPeers,
        reap: (record) => {
          if (st !== undefined) void reapPeer(st.stateDir, record);
        },
      });
    },
    leave: async () => {
      const st = liveNode();
      if (st === undefined) return 'peers are not running in this session.';
      if (st.left !== undefined) return 'This session has already left the peer list. `/peers join` to rejoin.';
      await leave(st, Date.now());
      // Saved with the session: `omp --resume` and reloads stay out.
      pi.appendEntry?.(PRESENCE_ENTRY, { left: st.left });
      return `Left the peer list as \`${st.name}\`: peers see you as left and cannot message you, and you cannot message them. Saved with this session; \`/peers join\` to rejoin.`;
    },
    join: async () => {
      const st = liveNode();
      if (st === undefined) return 'peers are not running in this session.';
      if (st.left === undefined) return `This session is already in the peer list as \`${st.name}\`.`;
      await join(st);
      pi.appendEntry?.(PRESENCE_ENTRY, { left: null });
      return `Rejoined the peer list as \`${st.name}\`.`;
    },
  });

  registerPeerSendTool(pi, {
    send: (to, message, replyTo, ack) => {
      const st = liveNode();
      if (st?.left !== undefined) return Promise.resolve(NOT_WHILE_LEFT);
      return sendToPeer(to, message, {
        ownName: st?.name ?? '',
        ...(st !== undefined ? { state: st, ownId: st.sessionId } : {}),
        isReply: replyTo !== undefined,
        listPeers: freshPeers,
        ...(replyTo !== undefined ? { replyTo } : {}),
        ...(ack ? { ack: true } : {}),
        reap: (record) => {
          if (st !== undefined) void reapPeer(st.stateDir, record);
        },
      });
    },
  });

  registerPeerStatusTool(pi, {
    listPeers: freshPeers,
  });

  registerPeerRequestTool(pi, {
    ownName: () => liveNode()?.name ?? '',
    listPeers: freshPeers,
    send: (to, message, outDeps) => {
      const st = liveNode();
      if (st?.left !== undefined) return Promise.resolve(NOT_WHILE_LEFT);
      return sendToPeer(to, message, {
        ...outDeps,
        ...(st !== undefined
          ? {
              state: st,
              ownId: st.sessionId,
              reap: (record) => {
                void reapPeer(st.stateDir, record);
              },
            }
          : {}),
      });
    },
    getPendingReplies: () => liveNode()?.pendingReplies,
  });

  pi.on('session_start', (_event, ctx) => {
    ensureNode(pi, ctx);
  });

  pi.on('session_shutdown', (_event, ctx) => {
    // omp disposes every finished `task` subagent session, which fires
    // session_shutdown on that session's own extension instance. Only the
    // root session's shutdown ends this peer.
    if (ctx?.agent?.kind === 'sub') return;
    const st = node;
    node = undefined;
    if (st !== undefined) void stopNode(st);
  });
  for (const event of ['session_switch', 'session_branch', 'session_tree']) {
    pi.on(event, (_payload, ctx) => {
      ensureNode(pi, ctx);
    });
  }

  pi.on('input', (event) => {
    const payload = event as { source?: unknown; text?: unknown } | undefined;
    if (payload?.source === 'extension') return;
    // omp emits `input` before it parses slash commands, so `/msg` or `/peers`
    // arrives here too. Those don't prompt this agent and must not end a relay
    // chain it is still carrying.
    if (typeof payload?.text === 'string' && payload.text.trimStart().startsWith('/')) return;
    // A human prompt ends any relay chain: the next send starts at hop 0.
    // (No re-beat here: the context handler builds the roster from the last
    // good tick, so an async beat could never land in time for this prompt.)
    const live = liveNode();
    if (live !== undefined) {
      live.lastInboundPeer = undefined;
      live.lastInboundHop = 0;
    }
  });
  // `input` only fires for interactive TTY submits — on rpc/print/headless
  // hosts it never runs, so `before_agent_start` (emitted by the agent loop
  // in every mode) is the reset that keeps the hop state from sticking
  // forever. Peer injections are identified by the `[peer <name>]` prefix
  // formatPeerText stamps on every delivery; a human prompt that happens to
  // start with `[peer ` won't reset — conservative direction, acceptable.
  pi.on('before_agent_start', (event) => {
    const prompt = (event as { prompt?: unknown } | undefined)?.prompt;
    if (typeof prompt === 'string' && prompt.startsWith('[peer ')) return;
    const live = liveNode();
    if (live !== undefined) {
      live.lastInboundPeer = undefined;
      live.lastInboundHop = 0;
    }
  });
  // Activity is never synchronous on ctx, so it is captured from the agent's
  // own tool events: a started tool names what the peer is doing right now,
  // and its end clears the name (busy/idle still describes the turn).
  pi.on('tool_execution_start', (event) => {
    const st = liveNode();
    if (st === undefined) return;
    const payload = event as { toolName?: unknown; intent?: unknown } | undefined;
    const toolName = typeof payload?.toolName === 'string' ? payload.toolName : '';
    const intent = typeof payload?.intent === 'string' ? payload.intent.trim() : '';
    const text = intent !== '' ? intent : toolName;
    if (text === '') return;
    st.nativeActivity = { text, at: Date.now() };
  });
  pi.on('tool_execution_end', (event) => {
    const st = liveNode();
    if (st !== undefined) {
      st.nativeActivity = undefined;
      // A todo flip must land before the next 15s beat, not after it.
      if ((event as { toolName?: unknown } | undefined)?.toolName === 'todo') {
        void st.beat.request();
      }
    }
  });
  pi.on('agent_end', () => {
    const st = liveNode();
    if (st !== undefined) st.nativeActivity = undefined;
  });
  // The reminder fires after the turn's todos came back unfinished; the beat
  // that follows must carry the fresh phases.
  pi.on('todo_reminder', () => {
    const st = liveNode();
    if (st === undefined) return;
    void st.beat.request();
  });
  pi.on('context', (event, ctx) => {
    const st = ensureNode(pi, ctx);
    if (st === undefined) return undefined;
    // Hot-rename: recompute the name from the LIVE session name before
    // building the note — the async re-beat may not have landed yet, and
    // the first prompt after /rename must not show a stale name.
    const cwd = typeof ctx?.cwd === 'string' && ctx.cwd !== '' ? ctx.cwd : process.cwd();
    const others = assignName(st, currentBase(st, cwd), st.peers);
    // Always inject: the agent learns its OWN peer name here, even solo.
    const note = buildPeersNote(st.name, others, { left: st.left !== undefined });
    const payload = event as { messages?: unknown } | undefined;
    if (payload === undefined || !Array.isArray(payload.messages)) return undefined;
    return { messages: appendNoteToMessages(payload.messages as RosterMessage[], note) };
  });
}
