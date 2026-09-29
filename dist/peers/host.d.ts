/**
 * Host seam: narrow structural types plus the capability probe.
 *
 * STRUCTURAL RULE (1): never import host singletons (`registry/agent-registry`,
 * `irc/bus`, `tools/hub/messaging`). The extension's module graph may bind a
 * FOREIGN copy of the host modules (two `static #global` instances), so the
 * host is touched ONLY through `ctx`/`pi` surfaces plus the bridge probed
 * below via literal-specifier dynamic imports inside try/catch (the host
 * loader rewrites literal specifiers to the host's own module instances).
 * Future #7401 seams slot in here.
 */
import type { PeerRecord, PeerTodo } from '../types.js';
export interface SessionManagerLike {
    getSessionId?: () => string | undefined;
    /** Host session title (omp `ReadonlySessionManager.getSessionName`). */
    getSessionName?: () => string | undefined;
    /** Session header (omp `ReadonlySessionManager.getHeader`) — carries `titleSource`. */
    getHeader?: () => unknown;
    /** Title source on hosts exposing the full manager (`"user"` | `"auto"`). */
    titleSource?: unknown;
    /** Active-branch session entries, oldest first (omp `ReadonlySessionManager.getBranch`). */
    getBranch?: () => unknown;
    /** Every session entry, oldest first (omp `ReadonlySessionManager.getEntries`). */
    getEntries?: () => unknown;
}
export interface SelectOption {
    label: string;
    description?: string;
}
export interface UiLike {
    notify(message: string, type?: 'info' | 'warning' | 'error'): void;
    select?: (title: string, options: SelectOption[], dialogOptions?: unknown) => Promise<string | undefined>;
    /** Live composer text in interactive mode (absent headless) — typing protection reads this. */
    getEditorText?: () => string;
    [key: string]: unknown;
}
export interface CommandContextLike {
    cwd: string;
    mode: string;
    ui: UiLike;
    sessionManager: SessionManagerLike;
    model?: {
        id?: string;
    };
    isIdle: () => boolean;
    setInterval?: (callback: () => void, ms?: number) => unknown;
    clearTimer?: (timer: unknown) => void;
    [key: string]: unknown;
}
export interface ToolInvokeResult {
    content: Array<{
        type: string;
        text: string;
    }>;
    details?: unknown;
}
export interface ExtensionHostLike {
    on(event: string, handler: (event: unknown, ctx: CommandContextLike) => unknown): void;
    registerCommand(name: string, opts: {
        description?: string;
        handler: (args: string, ctx: CommandContextLike) => unknown;
    }): void;
    registerTool(tool: {
        name: string;
        label: string;
        description: string;
        parameters: unknown;
        /**
         * omp mounts `discoverable` tools (its default) behind `write xd://<name>`
         * rather than as direct tools; `essential` keeps them callable by name.
         */
        loadMode?: 'essential' | 'discoverable';
        execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolInvokeResult>;
    }): void;
    sendUserMessage?: (content: string, options?: {
        deliverAs?: 'steer' | 'followUp' | 'aside';
        attribution?: 'user' | 'agent';
    }) => void | Promise<void>;
    getSessionName?: () => string | undefined;
    logger?: {
        warn(message: string): void;
    };
}
/** Structural view of one host registry ref (only the fields we read). */
export interface RegistryRefLike {
    id: unknown;
    session?: unknown;
    sessionFile?: unknown;
    sessionId?: unknown;
}
/** Structural view of the HOST AgentRegistry (obtained via probe). */
export interface RegistryLike {
    get(id: string): {
        session?: {
            peerSocket?: unknown;
        } | null;
    } | undefined;
    list?: () => RegistryRefLike[];
    values?: () => Iterable<RegistryRefLike>;
    entries?: () => Iterable<[unknown, RegistryRefLike]>;
    register(input: Record<string, unknown>): unknown;
    unregister(id: string): boolean;
    setActivity?: (id: string, activity: string) => void;
}
export interface HubBridge {
    registry: RegistryLike;
}
/**
 * True when the probed registry is the HOST's own (shared) copy. The host
 * always keeps its driving agent registered, so a shared copy resolves
 * `Main`; a foreign module copy — which the compiled omp binary hands to
 * dynamic importers — has an empty map and nothing we claim there is
 * visible to the host's `hub`. Bridges that fail this probe must not claim
 * refs or promise `hub send` in the roster.
 */
export declare function bridgeResolvesHost(bridge: HubBridge): boolean;
export type HostProbe = {
    kind: 'hub-bridge';
    bridge: HubBridge;
} | {
    kind: 'tools';
};
/**
 * Capability probe. Literal specifiers only (the host rewrites them), always
 * inside try/catch: on any host without these modules this resolves
 * `{kind:'tools'}` and the extension falls back to the `peer_send` surface.
 * The result caches host MODULE handles only — never any session object.
 */
export declare function probeHost(): Promise<HostProbe>;
/**
 * `peerSocket` marker). Used to keep a session name from colliding with a
 * live subagent address during peer-name deconfliction.
 */
export declare function listLocalAgentIds(registry: RegistryLike): string[];
/**
 * Who named this session. The host marks explicit renames `"user"` and
 * model-generated titles `"auto"` on the session header (on-contract via
 * `ReadonlySessionManager.getHeader`) and on the manager itself (structural —
 * the runtime object is the full SessionManager). Returns undefined when the
 * host exposes neither; callers keep legacy adopt-or-warn behavior.
 */
export declare function readTitleSource(manager: SessionManagerLike | undefined | null): string | undefined;
/** Cap on published todos: the heartbeat is a glance, not a transcript. */
export declare const MAX_PEER_TODOS = 20;
/** Cap on each published text field (phase, task, blocker). */
export declare const MAX_PEER_TODO_TEXT_CHARS = 200;
/**
 * Read the host's NATIVE todo state out of the session transcript, newest
 * entry first: a `user_todo_edit` custom entry, else the latest successful
 * `todo` toolResult. Never throws — a host without the surface reads as [].
 */
export declare function readNativeTodos(manager: SessionManagerLike | undefined | null): PeerTodo[];
export declare function peerActivityFor(record: PeerRecord): string;
export type PeerRequestFn = (socket: string, frame: {
    t: 'msg';
    from: string;
    body: string;
    replyTo?: string;
    hop: number;
}) => Promise<{
    ok: boolean;
    outcome?: string;
    error?: string;
} | undefined>;
/**
 * Materialize a remote peer as a registry ref so native `hub send`/`hub list`
 * reach it. `kind:'sub'` + `status:'idle'` keeps the stub inside the host's
 * flat alive filter and clear of the parked lifecycle gate, so `hub send`
 * goes straight to the stub's `deliverIrcMessage` (socket round trip).
 * Refuses to overwrite a live local (non-peer) ref of the same id.
 */
export declare function claimBridgedPeer(bridge: HubBridge, record: PeerRecord, ownName: string, getHop: () => number, request: PeerRequestFn, onWarn?: (message: string) => void): boolean;
/** Release a bridged peer ref, but only one this extension owns (marker). */
export declare function releaseBridgedPeer(bridge: HubBridge, name: string): void;
