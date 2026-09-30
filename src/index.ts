/**
 * peers — opt-in live peer awareness for OMP/pi agent instances.
 *
 * Install is opt-in; every running instance is auto-present via its
 * `<state>/peers/<pid>.json` heartbeat. Library entry (storage + presence +
 * transport + delivery); the extension entry is `./extension.js`.
 */

// Store layer.
export {
  resolveStateDir,
  ensureStateDirs,
  peersDir,
  peerPath,
} from './store/paths.js';
export {
  durableWriteJson,
  readJsonFile,
} from './store/atomic.js';

// Peer identity.
export {
  PEER_NAME_PATTERN,
  isValidPeerName,
  validatePeerName,
  directoryBase,
  chooseBase,
  SUFFIX_SEPARATOR,
  deriveNames,
  nameRoster,
  recordBase,
  peerKey,
  lookupPeer,
  type NameSource,
  type PeerLookup,
} from './peers/ids.js';

// Environment lookups (git top level, herdr tab label).
export { createEnvLookups, type EnvLookups, type EnvLookupOptions } from './peers/context.js';

// Presence.
export {
  writePeerBeat,
  listLivePeers,
  reapPeer,
  removeOwnRecord,
  startPresenceBeat,
  formatBeatAge,
  HEARTBEAT_MS,
  PEER_TTL_MS,
  type BeatInput,
  type ListPeersOptions,
  type Liveness,
  type PresenceBeatOptions,
} from './peers/presence.js';

// Heartbeat loop (single-flight; stop is final) and the held queue built on it.
export { createBeatLoop, type BeatLoop } from './peers/beat.js';
export { createHeldQueue, type HeldQueue, type HeldQueueDeps } from './peers/held.js';

// Transport.
export {
  MAX_HOPS,
  COALESCE_MS,
  PEER_REQUEST_TIMEOUT_MS,
  SOCKET_IDLE_MS,
  MAX_FRAME_BYTES,
  WRONG_PEER,
  LEFT,
  peerSocketAddress,
  startPeerServer,
  requestPeer,
  type InboundMessage,
  type PeerServerOptions,
  type PeerServerHandle,
} from './peers/server.js';

// Delivery.
export {
  deliverInboundPeerMessage,
  formatPeerText,
  isWakeOverBudget,
  recordPeerWake,
  readWakeBudget,
  MAX_WAKES_PER_PEER_PER_HOUR,
  WAKE_WINDOW_MS,
  DEFAULT_WAKE_BUDGET,
  DEFERRED_ENTRY,
  MAX_WAKES_ENV,
  WAKE_WINDOW_ENV,
  HOLD_TIMEOUT_MS,
  MAX_HELD_BATCHES,
  HOLD_POLL_MS,
  type InboundCarrier,
  type CurrentHost,
  type InboundOutcome,
  type InboundDeps,
  type WakeBudget,
  type HeldBatch,
} from './peers/inbound.js';
export { sendToPeer, outboundHop, type HopState, type OutboundDeps } from './peers/outbound.js';

// Roster.
export {
  buildPeersNote,
  appendNoteToMessages,
  type RosterMessage,
} from './peers/roster.js';

// Host seam.
export {
  detectHarness,
  readTitleSource,
  readNativeTodos,
  readLeft,
  PRESENCE_ENTRY,
  MAX_PEER_TODOS,
  MAX_PEER_TODO_TEXT_CHARS,
  type CommandContextLike,
  type ExtensionHostLike,
  type UiLike,
  type AutocompleteItemLike,
  type SelectOption,
} from './peers/host.js';

// Socket input checks.
export { checkFrame, checkReply, type FrameCheck, type FrameRejection } from './peers/wire.js';

// Peer status text (peer_status and the /peers picker share it).
export { formatPeerStatus, describePeer, peerActivity, todoSummary } from './peers/status.js';
// User commands: /peers and /msg.
export {
  formatPeersText,
  formatPeerLine,
  parseMsgArgs,
  completePeerNames,
  registerPeersCommand,
  PEER_ACTIONS,
  type PeersSnapshot,
  type PeerCommandDeps,
} from './commands/peers.js';
// Agent tool surface (registered unconditionally in every mode).
export {
  registerPeerSendTool,
  registerPeerStatusTool,
  registerPeerRequestTool,
  type PeerSendDeps,
  type PeerStatusDeps,
  type PeerRequestDeps,
} from './tools.js';

// Errors and shared schemas.
export * from './errors.js';
export type {
  HarnessKind,
  PeerRecord,
  PeerTodo,
  PendingReply,
  PeerFrame,
  PeerReply,
} from './types.js';
