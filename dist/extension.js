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
import { registerPeersCommand } from './commands/peers.js';
import { detectHarness, readNativeTodos, readTitleSource } from './peers/host.js';
import { chooseBase, directoryBase, isValidPeerName, peerKey, resolvePeerName } from './peers/ids.js';
import { createEnvLookups } from './peers/context.js';
import { deliverInboundPeerMessage, HOLD_POLL_MS, MAX_HELD_BATCHES } from './peers/inbound.js';
import { sendToPeer } from './peers/outbound.js';
import { HEARTBEAT_MS, listLivePeers, removePeerRecord, startPresenceBeat, writePeerBeat } from './peers/presence.js';
import { appendNoteToMessages, buildPeersNote } from './peers/roster.js';
import { peerSocketAddress, startPeerServer } from './peers/server.js';
import { ensureStateDirs, resolveStateDir } from './store/paths.js';
import { registerPeerSendTool, registerPeerStatusTool, registerPeerRequestTool } from './tools.js';
const HARNESS = await detectHarness();
/** How long a started tool keeps naming the peer's activity before busy/idle takes over. */
const ACTIVITY_FRESH_MS = 120_000;
/** One node per process, even when several sessions load the extension. */
let node;
/** The live node for this process, if one is running. */
function liveNode() {
    return node !== undefined && !node.stopped ? node : undefined;
}
function currentOf() {
    return liveNode()?.current;
}
/** Stash a held batch (bounded) and ensure the retry poller runs. */
function holdBatch(st, msg) {
    st.held.push({ message: { ...msg }, receivedAt: Date.now() });
    while (st.held.length > MAX_HELD_BATCHES) {
        // Overflow drops the oldest batch — the sender got a 'held' receipt
        // promising delivery, so the drop must not be silent.
        const dropped = st.held.shift();
        if (dropped !== undefined) {
            warnOf(st, `peers: held queue full — dropped a message from ${dropped.message.from}`);
        }
    }
    if (st.holdTimer !== undefined)
        return;
    st.holdTimer = setInterval(() => {
        void pumpHeld(st).catch((err) => logOf(st, `peers: held retry failed: ${err instanceof Error ? err.message : String(err)}`));
    }, HOLD_POLL_MS);
    st.holdTimer.unref?.();
}
/** Retry held batches oldest-first; drop each once it delivers or ages out. */
async function pumpHeld(st) {
    if (st.stopped || node !== st)
        return;
    for (const batch of [...st.held]) {
        if (st.stopped || node !== st)
            return;
        const res = await deliverInboundPeerMessage(batch.message, {
            getCurrent: () => currentOf(),
            getDraftText: () => {
                try {
                    const text = currentOf()?.ctx.ui.getEditorText?.() ?? '';
                    return typeof text === 'string' ? text : '';
                }
                catch {
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
        if (res.outcome !== 'held')
            st.held = st.held.filter((b) => b !== batch);
    }
    if (st.held.length === 0 && st.holdTimer !== undefined) {
        clearInterval(st.holdTimer);
        st.holdTimer = undefined;
    }
}
function warnOf(st, text) {
    try {
        st.current?.ctx.ui.notify(text, 'warning');
    }
    catch {
        // Warnings never throw into the host.
    }
}
function logOf(st, text) {
    try {
        st.current?.pi.logger?.warn(text);
    }
    catch {
        // Logging never throws into the host.
    }
}
/** Read one host fact; a throw is logged and becomes `fallback`. */
function hostRead(st, what, read, fallback) {
    try {
        return read();
    }
    catch (err) {
        logOf(st, `peers: reading ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
        return fallback;
    }
}
/** How long a name this peer gave up keeps answering, as an alias. */
const PREVIOUS_NAME_MS = 10 * 60_000;
/**
 * This peer's name from its base and the live roster, recording the name it
 * replaces so senders mid-conversation still reach it for a while.
 */
function assignName(st, base, others) {
    const next = resolvePeerName({ base, sessionId: st.sessionId, pid: st.pid, peers: others });
    // Only a name other peers could have learned is worth keeping: one held
    // briefly before the first beat was never seen.
    if (st.publishedName !== undefined && st.publishedName.toLowerCase() !== next.toLowerCase()) {
        st.previousNames.set(st.publishedName, Date.now() + PREVIOUS_NAME_MS);
    }
    st.previousNames.delete(next);
    st.base = base;
    st.name = next;
}
/** Tab label (when a usable name) plus names held in the last minutes. */
function currentAliases(st) {
    const now = Date.now();
    for (const [old, until] of st.previousNames)
        if (until <= now)
            st.previousNames.delete(old);
    const aliases = [...st.previousNames.keys()];
    if (st.label !== undefined && st.label.toLowerCase() !== st.name.toLowerCase())
        aliases.unshift(st.label);
    return aliases;
}
/** The base name for the current host session and working directory. */
function currentBase(st, cwd) {
    const ctx = st.current?.ctx;
    const sessionName = hostRead(st, 'session name', () => st.current?.pi.getSessionName?.() ?? ctx?.sessionManager?.getSessionName?.(), undefined);
    const chosen = chooseBase({
        sessionName,
        titleSource: readTitleSource(ctx?.sessionManager),
        dirBase: directoryBase(cwd, st.lookups.gitTopLevel(cwd)),
    });
    if (chosen.rejected !== undefined && chosen.rejected !== st.lastRejectedSessionName) {
        const first = st.lastRejectedSessionName === undefined;
        st.lastRejectedSessionName = chosen.rejected;
        const text = `session name "${chosen.rejected}" can't be a peer name (1-24 of a-z A-Z 0-9 _ . -, not all digits, not main/all/self); ` +
            `using ${chosen.base} — /rename the session to a valid name`;
        if (first)
            warnOf(st, text);
        else
            logOf(st, `peers: ${text}`);
    }
    return chosen.base;
}
async function tick(st) {
    const ctx = st.current?.ctx;
    const cwd = typeof ctx?.cwd === 'string' && ctx.cwd !== '' ? ctx.cwd : process.cwd();
    st.sessionId = hostRead(st, 'session id', () => ctx?.sessionManager?.getSessionId?.() ?? '', '');
    const model = hostRead(st, 'model', () => ctx?.model?.id ?? '', '');
    const busy = hostRead(st, 'idle state', () => !(ctx?.isIdle?.() ?? true), false);
    const rawLabel = st.lookups.tabLabel();
    st.label = rawLabel !== undefined && isValidPeerName(rawLabel) ? rawLabel : undefined;
    const base = currentBase(st, cwd);
    let others;
    try {
        others = (await listLivePeers(st.stateDir, st.pid)).filter((p) => p.pid !== st.pid);
    }
    catch (err) {
        // Transient listing failure: fall back to the last-good roster below.
        logOf(st, `peers: listing peers failed: ${err instanceof Error ? err.message : String(err)}`);
        others = undefined;
    }
    assignName(st, base, others ?? st.peers.filter((p) => p.pid !== st.pid));
    st.nativeTodos = readNativeTodos(ctx?.sessionManager);
    const lastActivity = st.nativeActivity;
    const activity = lastActivity !== undefined && Date.now() - lastActivity.at <= ACTIVITY_FRESH_MS
        ? lastActivity.text
        : busy
            ? 'working'
            : undefined;
    let own;
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
            startedAt: st.startedAt,
            busy,
            ...(activity !== undefined && activity !== '' ? { activity } : {}),
            ...(st.nativeTodos.length > 0 ? { todos: st.nativeTodos } : {}),
        });
        st.publishedName = own.name;
    }
    catch (err) {
        logOf(st, `peers: heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const lastOthers = st.peers.filter((p) => p.pid !== st.pid);
    st.peers =
        own !== undefined
            ? [...(others ?? lastOthers), own].sort((a, b) => a.name.localeCompare(b.name))
            : (others ?? lastOthers);
}
function armBeatTimer(st, ctx) {
    try {
        st.stopBeat?.();
    }
    catch {
        // Replacing a dead timer must not break re-arm.
    }
    const managed = typeof ctx.setInterval === 'function' && typeof ctx.clearTimer === 'function'
        ? { setInterval: ctx.setInterval.bind(ctx), clearTimer: ctx.clearTimer.bind(ctx) }
        : {};
    st.stopBeat = startPresenceBeat(() => tick(st), {
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
function isSubagent(ctx) {
    return ctx.agent?.kind === 'sub';
}
/** Get the live node, starting one if this process has none. Re-arms on every root-session event. */
function ensureNode(pi, ctx) {
    if (isSubagent(ctx))
        return undefined;
    const existing = liveNode();
    if (existing !== undefined) {
        existing.current = { pi, ctx };
        let sessionId = '';
        try {
            sessionId = ctx.sessionManager?.getSessionId?.() ?? '';
        }
        catch {
            sessionId = '';
        }
        if (sessionId !== '' && sessionId !== existing.sessionId)
            armBeatTimer(existing, ctx);
        return existing;
    }
    try {
        const stateDir = resolveStateDir();
        const st = {
            stateDir,
            pid: process.pid,
            startedAt: Date.now(),
            socketAddress: peerSocketAddress(stateDir, process.pid),
            name: '',
            base: '',
            label: undefined,
            previousNames: new Map(),
            publishedName: undefined,
            sessionId: '',
            lookups: createEnvLookups({ onError: (text) => logOf(st, text) }),
            peers: [],
            wakes: new Map(),
            lastInboundPeer: undefined,
            lastInboundHop: 0,
            held: [],
            holdTimer: undefined,
            current: { pi, ctx },
            server: undefined,
            stopBeat: undefined,
            lastRejectedSessionName: undefined,
            stopped: false,
            nativeTodos: [],
            nativeActivity: undefined,
            pendingReplies: new Map(),
        };
        const cwd = typeof ctx.cwd === 'string' && ctx.cwd !== '' ? ctx.cwd : process.cwd();
        st.sessionId = hostRead(st, 'session id', () => ctx.sessionManager?.getSessionId?.() ?? '', '');
        assignName(st, directoryBase(cwd), []);
        node = st;
        void Promise.all([ensureStateDirs(stateDir), st.lookups.prime(cwd)])
            .then(() => {
            if (st.stopped)
                return;
            st.server = startPeerServer({
                address: st.socketAddress,
                ownName: () => liveNode()?.name ?? '',
                onMessage: async (msg) => {
                    const live = liveNode();
                    if (live !== undefined &&
                        msg.replyTo !== undefined &&
                        msg.replyTo !== '' &&
                        live.pendingReplies.has(msg.replyTo)) {
                        const entry = live.pendingReplies.get(msg.replyTo);
                        live.pendingReplies.delete(msg.replyTo);
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
                            }
                            catch {
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
                    if (res.outcome === 'held' && live !== undefined)
                        holdBatch(live, msg);
                    return res.outcome;
                },
                onWarn: (text) => {
                    const live = liveNode();
                    if (live !== undefined)
                        warnOf(live, text);
                },
            });
            armBeatTimer(st, ctx);
            void tick(st);
        })
            .catch((err) => {
            try {
                ctx.ui.notify(`peers: could not start — ${err instanceof Error ? err.message : String(err)}`, 'warning');
            }
            catch {
                // Boot failures never throw into the host.
            }
        });
        return st;
    }
    catch (err) {
        node = undefined;
        try {
            pi.logger?.warn(`peers: could not start (${String(err)})`);
        }
        catch {
            // Logging never throws.
        }
        return undefined;
    }
}
async function stopNode(st) {
    st.stopped = true;
    // A successor node for this same pid may already exist (session_switch →
    // ensureNode after `node` was cleared). When it does, this teardown must
    // not delete the successor's live record or socket file.
    const hasSuccessor = () => {
        const successor = liveNode();
        return successor !== undefined && successor !== st;
    };
    try {
        st.stopBeat?.();
    }
    catch {
        // Shutdown never throws.
    }
    st.stopBeat = undefined;
    if (st.holdTimer !== undefined) {
        try {
            clearInterval(st.holdTimer);
        }
        catch {
            // Shutdown never throws.
        }
        st.holdTimer = undefined;
    }
    if (st.held.length > 0) {
        logOf(st, `peers: dropping ${st.held.length} held message(s) on shutdown`);
    }
    st.held = [];
    for (const entry of st.pendingReplies.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('shutting down'));
    }
    st.pendingReplies.clear();
    try {
        st.server?.stop({ unlinkSocket: !hasSuccessor() });
    }
    catch {
        // Shutdown never throws.
    }
    st.server = undefined;
    if (hasSuccessor())
        return;
    try {
        await removePeerRecord(st.stateDir, st.pid);
    }
    catch {
        // Final unlink is best-effort.
    }
}
export default function peersExtension(pi) {
    // Sends resolve names from the presence directory at call time, not from
    // the heartbeat cache: a /rename reaches the directory at the renamer's next
    // beat, and a cached roster answers "Unknown peer" until the sender's own
    // next beat as well. The pid filter drops our own record, so a stale own
    // name (post-/rename) can't route a send back to ourselves.
    const freshPeers = async () => {
        const st = liveNode();
        if (st === undefined)
            return [];
        return (await listLivePeers(st.stateDir, st.pid)).filter((p) => p.pid !== st.pid);
    };
    registerPeersCommand(pi, {
        getSnapshot: async () => {
            const st = liveNode();
            if (st !== undefined) {
                // Fresh beat before rendering: a just-run /rename must be visible
                // immediately, not on the next 15s tick. tick() owns its failures.
                try {
                    await tick(st);
                }
                catch {
                    // Snapshot stays last-good.
                }
                return { ownName: st.name, peers: st.peers, held: st.held.length };
            }
            return { ownName: '', peers: [], held: 0 };
        },
        // Typed by the user, so it starts a fresh chain: hop 0, never a relay.
        sendAsUser: (to, body) => {
            const st = liveNode();
            return sendToPeer(to, body, {
                ownName: st?.name ?? '',
                ...(st !== undefined ? { ownId: st.sessionId } : {}),
                hop: 0,
                human: true,
                listPeers: freshPeers,
                reap: (record) => {
                    if (st !== undefined)
                        void removePeerRecord(st.stateDir, record.pid);
                },
            });
        },
    });
    registerPeerSendTool(pi, {
        send: (to, message, replyTo, ack) => {
            const st = liveNode();
            return sendToPeer(to, message, {
                ownName: st?.name ?? '',
                ...(st !== undefined ? { state: st, ownId: st.sessionId } : {}),
                isReply: replyTo !== undefined,
                listPeers: freshPeers,
                ...(replyTo !== undefined ? { replyTo } : {}),
                ...(ack ? { ack: true } : {}),
                reap: (record) => {
                    if (st !== undefined)
                        void removePeerRecord(st.stateDir, record.pid);
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
            return sendToPeer(to, message, {
                ...outDeps,
                ...(st !== undefined
                    ? {
                        state: st,
                        ownId: st.sessionId,
                        reap: (record) => {
                            void removePeerRecord(st.stateDir, record.pid);
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
        if (ctx?.agent?.kind === 'sub')
            return;
        const st = node;
        node = undefined;
        if (st !== undefined)
            void stopNode(st);
    });
    for (const event of ['session_switch', 'session_branch', 'session_tree']) {
        pi.on(event, (_payload, ctx) => {
            ensureNode(pi, ctx);
        });
    }
    pi.on('input', (event) => {
        const source = event?.source;
        if (source === 'extension')
            return;
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
        const prompt = event?.prompt;
        if (typeof prompt === 'string' && prompt.startsWith('[peer '))
            return;
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
        if (st === undefined)
            return;
        const payload = event;
        const toolName = typeof payload?.toolName === 'string' ? payload.toolName : '';
        const intent = typeof payload?.intent === 'string' ? payload.intent.trim() : '';
        const text = intent !== '' ? intent : toolName;
        if (text === '')
            return;
        st.nativeActivity = { text, at: Date.now() };
    });
    pi.on('tool_execution_end', (event) => {
        const st = liveNode();
        if (st !== undefined) {
            st.nativeActivity = undefined;
            // A todo flip must land before the next 15s beat, not after it.
            if (event?.toolName === 'todo') {
                void tick(st).catch((err) => logOf(st, `peers: tick failed: ${err instanceof Error ? err.message : String(err)}`));
            }
        }
    });
    pi.on('agent_end', () => {
        const st = liveNode();
        if (st !== undefined)
            st.nativeActivity = undefined;
    });
    // The reminder fires after the turn's todos came back unfinished; the beat
    // that follows must carry the fresh phases.
    pi.on('todo_reminder', () => {
        const st = liveNode();
        if (st === undefined)
            return;
        void tick(st).catch((err) => logOf(st, `peers: tick failed: ${err instanceof Error ? err.message : String(err)}`));
    });
    pi.on('context', (event, ctx) => {
        const st = ensureNode(pi, ctx);
        if (st === undefined)
            return undefined;
        // Hot-rename: recompute the name from the LIVE session name before
        // building the note — the async re-beat may not have landed yet, and
        // the first prompt after /rename must not show a stale name.
        const cwd = typeof ctx?.cwd === 'string' && ctx.cwd !== '' ? ctx.cwd : process.cwd();
        assignName(st, currentBase(st, cwd), st.peers.filter((p) => p.pid !== st.pid));
        // Always inject: the agent learns its OWN peer name here, even solo.
        const others = st.peers.filter((p) => p.pid !== st.pid);
        const note = buildPeersNote(st.name, others);
        const payload = event;
        if (payload === undefined || !Array.isArray(payload.messages))
            return undefined;
        return { messages: appendNoteToMessages(payload.messages, note) };
    });
}
