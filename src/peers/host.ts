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
  select?: (
    title: string,
    options: SelectOption[],
    dialogOptions?: unknown
  ) => Promise<string | undefined>;
  /** Live composer text in interactive mode (absent headless) — typing protection reads this. */
  getEditorText?: () => string;
  [key: string]: unknown;
}

export interface CommandContextLike {
  cwd: string;
  mode: string;
  ui: UiLike;
  sessionManager: SessionManagerLike;
  model?: { id?: string };
  isIdle: () => boolean;
  setInterval?: (callback: () => void, ms?: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  [key: string]: unknown;
}

export interface ToolInvokeResult {
  content: Array<{ type: string; text: string }>;
  details?: unknown;
}

export interface ExtensionHostLike {
  on(event: string, handler: (event: unknown, ctx: CommandContextLike) => unknown): void;
  registerCommand(
    name: string,
    opts: { description?: string; handler: (args: string, ctx: CommandContextLike) => unknown }
  ): void;
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
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal
    ) => Promise<ToolInvokeResult>;
  }): void;
  sendUserMessage?: (
    content: string,
    options?: { deliverAs?: 'steer' | 'followUp' | 'aside'; attribution?: 'user' | 'agent' }
  ) => void | Promise<void>;
  getSessionName?: () => string | undefined;
  logger?: { warn(message: string): void };
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
  get(id: string): { session?: { peerSocket?: unknown } | null } | undefined;
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
export function bridgeResolvesHost(bridge: HubBridge): boolean {
  try {
    // 'Main' is the host driving agent's registry id — a presence probe,
    // never a delivery address (see ids.ts REFUSED_HOST_NAME).
    return bridge.registry.get('Main') !== undefined;
  } catch {
    return false;
  }
}


export type HostProbe = { kind: 'hub-bridge'; bridge: HubBridge } | { kind: 'tools' };

/**
 * Capability probe. Literal specifiers only (the host rewrites them), always
 * inside try/catch: on any host without these modules this resolves
 * `{kind:'tools'}` and the extension falls back to the `peer_send` surface.
 * The result caches host MODULE handles only — never any session object.
 */
export async function probeHost(): Promise<HostProbe> {
  try {
    const registryModule = (await import(
      '@oh-my-pi/pi-coding-agent/registry/agent-registry'
    )) as unknown as Record<string, unknown>;
    const agentRegistry = registryModule['AgentRegistry'] as
      | { global?: () => unknown }
      | undefined;
    if (typeof agentRegistry?.global !== 'function') {
      return { kind: 'tools' };
    }
    return {
      kind: 'hub-bridge',
      bridge: { registry: agentRegistry.global() as RegistryLike },
    };
  } catch {
    return { kind: 'tools' };
  }
}

function registryRefs(registry: RegistryLike): RegistryRefLike[] {
  try {
    if (typeof registry.values === 'function') return [...registry.values()];
    if (typeof registry.list === 'function') {
      const out: unknown = registry.list();
      return Array.isArray(out) ? (out as RegistryRefLike[]) : [];
    }
    if (typeof registry.entries === 'function') {
      return [...registry.entries()].map(([, v]) => v);
    }
  } catch {
    return [];
  }
  return [];
}

/**
 * `peerSocket` marker). Used to keep a session name from colliding with a
 * live subagent address during peer-name deconfliction.
 */
export function listLocalAgentIds(registry: RegistryLike): string[] {
  const ids: string[] = [];
  for (const ref of registryRefs(registry)) {
    if (typeof ref.id !== 'string' || ref.id === '') continue;
    const session = ref.session as { peerSocket?: unknown } | null | undefined;
    if (session !== null && typeof session === 'object' && session.peerSocket !== undefined) {
      continue;
    }
    ids.push(ref.id);
  }
  return ids;
}

/**
 * Who named this session. The host marks explicit renames `"user"` and
 * model-generated titles `"auto"` on the session header (on-contract via
 * `ReadonlySessionManager.getHeader`) and on the manager itself (structural —
 * the runtime object is the full SessionManager). Returns undefined when the
 * host exposes neither; callers keep legacy adopt-or-warn behavior.
 */
export function readTitleSource(manager: SessionManagerLike | undefined | null): string | undefined {
  if (manager === undefined || manager === null) return undefined;
  // Header first (on-contract), then the manager itself (structural) — first
  // non-empty string wins. Every read is guarded: unknown host shapes fall
  // through to undefined and callers keep legacy adopt-or-warn behavior.
  const candidates: unknown[] = [];
  try {
    candidates.push(manager.getHeader?.());
  } catch {
    // Header read is best-effort.
  }
  candidates.push(manager);
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    if (!('titleSource' in candidate)) continue;
    const source: unknown = candidate.titleSource;
    if (typeof source === 'string' && source !== '') return source;
  }
  return undefined;
}

/** Marker the host stamps on a user todo edit entry (`tools/todo.ts`). */
const USER_TODO_EDIT_CUSTOM_TYPE = 'user_todo_edit';
/** Cap on published todos: the heartbeat is a glance, not a transcript. */
export const MAX_PEER_TODOS = 20;
/** Cap on each published text field (phase, task, blocker). */
export const MAX_PEER_TODO_TEXT_CHARS = 200;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function clampTodoText(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > MAX_PEER_TODO_TEXT_CHARS ? text.slice(0, MAX_PEER_TODO_TEXT_CHARS) : text;
}

/** Native `TodoStatus`, defaulting anything unrecognized (incl. legacy spellings) to pending. */
function nativeTodoStatus(raw: unknown): NonNullable<PeerTodo['status']> {
  switch (raw) {
    case 'in_progress':
      return 'in_progress';
    case 'completed':
      return 'completed';
    case 'abandoned':
      return 'abandoned';
    case 'blocked':
      return 'blocked';
    default:
      return 'pending';
  }
}

/** Phases carried by one session entry, or undefined when the entry is not a todo snapshot. */
function nativePhasesFromEntry(entry: unknown): unknown[] | undefined {
  const e = asRecord(entry);
  if (e === undefined) return undefined;
  if (e['type'] === 'custom' && e['customType'] === USER_TODO_EDIT_CUSTOM_TYPE) {
    const phases = asRecord(e['data'])?.['phases'];
    return Array.isArray(phases) ? phases : undefined;
  }
  if (e['type'] !== 'message') return undefined;
  const message = asRecord(e['message']);
  if (message === undefined) return undefined;
  if (message['role'] !== 'toolResult' || message['toolName'] !== 'todo' || message['isError']) return undefined;
  const phases = asRecord(message['details'])?.['phases'];
  return Array.isArray(phases) ? phases : undefined;
}

/** Flatten native phases/tasks into bounded peer todos. */
function mapNativeTodos(phases: unknown[]): PeerTodo[] {
  const flat: Array<{ todo: PeerTodo; order: number }> = [];
  let order = 0;
  for (const rawPhase of phases) {
    const phase = asRecord(rawPhase);
    if (phase === undefined) continue;
    const tasks = phase['tasks'];
    if (!Array.isArray(tasks)) continue;
    const phaseName = clampTodoText(phase['name']);
    for (const rawTask of tasks) {
      const task = asRecord(rawTask);
      if (task === undefined) continue;
      const text = clampTodoText(task['content']);
      if (text === '') continue;
      const status = nativeTodoStatus(task['status']);
      const blocker = status === 'blocked' ? clampTodoText(task['blocker']) : '';
      flat.push({
        order: order++,
        todo: {
          text,
          status,
          ...(phaseName !== '' ? { phase: phaseName } : {}),
          ...(blocker !== '' ? { blocker } : {}),
        },
      });
    }
  }
  if (flat.length > MAX_PEER_TODOS) {
    // Trim by usefulness — an in-progress task tells a peer more than a
    // completed one — then restore the host's own order for display.
    const priority = (todo: PeerTodo): number =>
      todo.status === 'in_progress' ? 0 : todo.status === 'pending' ? 1 : 2;
    flat.sort((a, b) => priority(a.todo) - priority(b.todo) || a.order - b.order);
    flat.length = MAX_PEER_TODOS;
    flat.sort((a, b) => a.order - b.order);
  }
  return flat.map((entry) => entry.todo);
}

/**
 * Read the host's NATIVE todo state out of the session transcript, newest
 * entry first: a `user_todo_edit` custom entry, else the latest successful
 * `todo` toolResult. Never throws — a host without the surface reads as [].
 */
export function readNativeTodos(manager: SessionManagerLike | undefined | null): PeerTodo[] {
  let entries: unknown;
  try {
    entries = manager?.getBranch?.() ?? manager?.getEntries?.() ?? [];
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const phases = nativePhasesFromEntry(entries[index]);
    if (phases !== undefined) return mapNativeTodos(phases);
  }
  return [];
}

export function peerActivityFor(record: PeerRecord): string {
  return `${record.harness} instance pid ${record.pid} in ${record.cwd}${record.busy ? ' (working)' : ''}`;
}

export type PeerRequestFn = (
  socket: string,
  frame: { t: 'msg'; from: string; body: string; replyTo?: string; hop: number }
) => Promise<{ ok: boolean; outcome?: string; error?: string } | undefined>;

/**
 * Materialize a remote peer as a registry ref so native `hub send`/`hub list`
 * reach it. `kind:'sub'` + `status:'idle'` keeps the stub inside the host's
 * flat alive filter and clear of the parked lifecycle gate, so `hub send`
 * goes straight to the stub's `deliverIrcMessage` (socket round trip).
 * Refuses to overwrite a live local (non-peer) ref of the same id.
 */
export function claimBridgedPeer(
  bridge: HubBridge,
  record: PeerRecord,
  ownName: string,
  getHop: () => number,
  request: PeerRequestFn,
  onWarn?: (message: string) => void
): boolean {
  let existing: { session?: { peerSocket?: unknown } | null } | undefined;
  try {
    existing = bridge.registry.get(record.name);
  } catch {
    existing = undefined;
  }
  if (existing !== undefined && existing.session?.peerSocket === undefined) {
    try {
      onWarn?.(`peers: name "${record.name}" collides with a local agent; skipping bridge`);
    } catch {
      // Warning delivery is best-effort.
    }
    return false;
  }
  const stub = {
    isStreaming: false,
    peerSocket: record.socket,
    subscribe: (): (() => void) => () => undefined,
    subscribeRunState: (): (() => void) => () => undefined,
    waitForIrcReplies: async (): Promise<never[]> => [],
    deliverIrcMessage: async (msg: { body: string; replyTo?: string }): Promise<string> => {
      const reply = await request(record.socket, {
        t: 'msg',
        from: ownName,
        body: msg.body,
        ...(msg.replyTo !== undefined && msg.replyTo !== '' ? { replyTo: msg.replyTo } : {}),
        hop: getHop(),
      });
      // A dead socket or refused frame is a FAILURE, not a delivery: throwing
      // makes the host bus report outcome 'failed' with this error text
      // instead of the old blanket 'injected' that lied to hub senders.
      if (reply === undefined || !reply.ok) {
        throw new Error(reply?.error ?? 'peer socket unreachable');
      }
      // Pass the real outcome through ('woken'/'injected'/'held'/'aside'/
      // 'dropped') — the receipt must show what the peer actually did.
      return reply.outcome ?? 'injected';
    },
  };
  try {
    bridge.registry.register({
      id: record.name,
      displayName: `${record.name} · ${record.project}`,
      kind: 'sub',
      status: 'idle',
      session: stub,
      sessionFile: null,
      activity: peerActivityFor(record),
    });
  } catch {
    return false;
  }
  return true;
}

/** Release a bridged peer ref, but only one this extension owns (marker). */
export function releaseBridgedPeer(bridge: HubBridge, name: string): void {
  try {
    const ref = bridge.registry.get(name);
    if (ref?.session?.peerSocket === undefined) return;
    bridge.registry.unregister(name);
  } catch {
    // Release is best-effort.
  }
}
