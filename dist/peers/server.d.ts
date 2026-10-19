/**
 * Peer protocol over the local line transport (`transport.ts`: omp's native
 * IPC inside omp, `node:net` elsewhere).
 *
 * Address: one endpoint per node boot — `<state>/peers/<pid>-<tag>.sock`, a
 * named pipe `\\.\pipe\peers-<pid>-<tag>` on Windows — so a successor node in
 * the same process never contends for its predecessor's endpoint. Frames are
 * newline-delimited JSON (`PeerFrame`); every frame gets a one-line
 * `PeerReply`. A received line over `MAX_FRAME_BYTES` closes the connection
 * without a reply, so `requestPeer` refuses an oversized frame before
 * writing any of it.
 *
 * Inbound policy lives here: hop cap (4 — a chain of agent-to-agent relays
 * past a human prompt is refused, never relayed) and 400ms per-sender burst
 * coalescing (N frames in one window cost one wake, not N).
 */
import type { PeerFrame, PeerReply } from '../types.js';
/** Max agent-to-agent relays from the last human prompt before refusal. */
export declare const MAX_HOPS = 4;
/** Burst window: frames from one sender inside it become a single wake. */
export declare const COALESCE_MS = 400;
/** Round-trip timeout for outbound sends. */
export declare const PEER_REQUEST_TIMEOUT_MS = 8000;
/** Idle server-side connections are closed after this long without a frame. */
export declare const SOCKET_IDLE_MS = 30000;
/** Largest line, in UTF-8 bytes with its LF, either side accepts. */
export declare const MAX_FRAME_BYTES = 1048576;
/** Reply error for a message addressed to another instance than the one listening here. */
export declare const WRONG_PEER = "wrong peer";
/** Reply error from a node that has left the peer list. */
export declare const LEFT = "left";
/**
 * Where this node boot listens (and where others reach it). The tag is the
 * first 8 alphanumerics of `instanceId`; reaping matches `<pid>-<tag>.sock`.
 */
export declare function peerSocketAddress(stateDir: string, pid: number, instanceId: string): string;
export interface InboundMessage {
    from: string;
    /** Sender's root session id, when the sender is 2.0.0 or later. */
    fromId?: string;
    body: string;
    replyTo?: string;
    hop: number;
    /** PURE RECEIPT — NEVER WAKES THE RECEIVER; RENDERED AS ONE DIM TOAST. */
    ack?: boolean;
    /** The sender's user typed every message in this batch (not its agent). */
    human?: boolean;
}
export interface PeerServerOptions {
    address: string;
    ownName: () => string;
    /** This node boot's `instanceId`: pings answer with it, and a message addressed to another id is refused. */
    ownId: () => string;
    onMessage: (msg: InboundMessage) => Promise<string>;
    /**
     * A reason to turn every message away (the node left the peer list), or
     * undefined. Checked when a frame arrives and again just before a batch
     * reaches the host, so a message accepted into the coalesce window before
     * a leave is refused too. Pings are still answered.
     */
    refuse?: () => string | undefined;
    onWarn?: (message: string) => void;
    coalesceMs?: number;
}
export interface PeerServerHandle {
    address: string;
    /**
     * Settles `true` once the socket accepts connections, `false` if listening
     * failed or the server stopped first. Publish the address only after `true`:
     * a record pointing at a socket not yet listening turns sends away.
     */
    listening: Promise<boolean>;
    /** Stop serving and remove this boot's endpoint. */
    stop(): void;
}
/**
 * Serve one peer address. `onMessage` runs once per coalesced batch and its
 * return becomes the reply `outcome`. Never throws into the host.
 */
export declare function startPeerServer(opts: PeerServerOptions): PeerServerHandle;
/**
 * One request/response round trip to a peer endpoint. Resolves `undefined`
 * when the connection closes before replying (peer gone — caller reaps).
 * Connect failures carry their errno code (`ECONNREFUSED: …`).
 */
export declare function requestPeer(address: string, frame: PeerFrame, timeoutMs?: number): Promise<PeerReply | undefined>;
