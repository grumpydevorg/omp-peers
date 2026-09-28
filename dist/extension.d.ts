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
import type { ExtensionHostLike } from './peers/host.js';
export default function peersExtension(pi: ExtensionHostLike): void;
