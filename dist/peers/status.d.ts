/**
 * How a peer's heartbeat reads to a person or an agent: the full status view
 * (`peer_status`, the `/peers` Status action) and the one-line summary the
 * picker shows under each name. One module, so the two can't drift.
 */
import type { PeerRecord, PeerTodo } from '../types.js';
/**
 * What the peer is doing beyond busy/idle. A busy peer with no fresh tool
 * publishes the bare word `working`, which the state already says.
 */
export declare function peerActivity(peer: PeerRecord): string | undefined;
/** `3 todos, 1 blocked`, or undefined when the peer publishes none. */
export declare function todoSummary(todos: PeerTodo[] | undefined): string | undefined;
/** The full view: state, place, beat age, activity, and every todo by phase. */
export declare function formatPeerStatus(peer: PeerRecord, now: number): string;
/** One line under a picker row: state · activity · todos · herdr tab · beat · cwd. */
export declare function describePeer(peer: PeerRecord, now: number): string;
