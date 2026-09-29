/**
 * The user's commands: `/peers` and `/msg`.
 *
 * `/peers` always has a text form. In the TUI (`ctx.ui.select` present and
 * `ctx.mode === 'tui'`) it is a picker of the OTHER peers — this session is
 * named in the title, not offered as a row — and picking one opens an action
 * menu: Message, Status, Hand to my agent. No UI module is ever imported; the
 * primitives are probed on the live ctx and called as receiver methods.
 *
 * `/msg <peer> <text>` and the Message action send text the user typed
 * straight to the peer, without a turn of this session's agent. The frame is
 * marked `human`, so the receiver labels it as typed by this peer's user; it
 * still carries no authority there.
 */

import type { CommandContextLike, ExtensionHostLike, UiLike } from '../peers/host.js';
import { formatBeatAge } from '../peers/presence.js';
import { describePeer, formatPeerStatus, peerActivity } from '../peers/status.js';
import type { PeerRecord } from '../types.js';

export interface PeersSnapshot {
  ownName: string;
  peers: PeerRecord[];
  /** Batches held while the peer types — shown so held mail is visible. */
  held?: number;
}

export interface PeerCommandDeps {
  getSnapshot: () => Promise<PeersSnapshot>;
  /** Deliver text the user typed; resolves to the human-readable receipt. Never throws. */
  sendAsUser: (to: string, body: string) => Promise<string>;
}

/** `backend · omp(1234) · C:\work · model-id · working · beat 3s ago`. */
export function formatPeerLine(p: PeerRecord, now: number, selfName: string): string {
  const self = p.name === selfName ? ' · you' : '';
  const tab = p.label !== undefined ? ` (tab ${p.label})` : '';
  const doing = peerActivity(p);
  const activity = doing !== undefined ? ` · ${doing}` : '';
  const todos = p.todos?.length
    ? ` · ${p.todos.length} todo${p.todos.length === 1 ? '' : 's'}`
    : '';
  return `${p.name}${tab} · ${p.harness}(${p.pid}) · ${p.cwd} · ${p.model === '' ? '—' : p.model} · ${p.busy ? 'working' : 'idle'} · beat ${formatBeatAge(p.beatAt, now)}${activity}${todos}${self}`;
}

export function formatPeersText(snap: PeersSnapshot, now: number): string {
  const lines = [...snap.peers]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => formatPeerLine(p, now, snap.ownName));
  const header = `peers (${snap.peers.length}) — you are \`${snap.ownName}\`${(snap.held ?? 0) > 0 ? ` · held ${snap.held}` : ''}`;
  const usage = 'Message one with `/msg <peer> <text>`.';
  return lines.length === 0 ? `${header} — no peers` : `${header}\n${lines.join('\n')}\n${usage}`;
}

/**
 * Split `/msg` arguments into the peer name and the message. The name is the
 * first word; everything after it, internal newlines included, is the body.
 */
export function parseMsgArgs(args: string): { to: string; body: string } | undefined {
  const match = /^\s*(\S+)\s+([\s\S]*\S)\s*$/.exec(args);
  if (match === null) return undefined;
  return { to: match[1] as string, body: match[2] as string };
}

/** A receipt for a send that did not reach the peer's session. */
function isFailedReceipt(receipt: string): boolean {
  return !/^(Delivered|Held|Queued|Replied|Ack delivered)/.test(receipt);
}

function notify(ctx: CommandContextLike, text: string, type: 'info' | 'warning' | 'error' = 'info'): void {
  try {
    ctx.ui.notify(text, type);
  } catch {
    // Notify is best-effort.
  }
}

async function sendAndReport(ctx: CommandContextLike, deps: PeerCommandDeps, to: string, body: string): Promise<void> {
  const receipt = await deps.sendAsUser(to, body);
  notify(ctx, receipt, isFailedReceipt(receipt) ? 'warning' : 'info');
}

/** Put `text` in the composer, when the host lets an extension do that. */
function fillComposer(ui: UiLike, text: string): boolean {
  if (typeof ui.setEditorText !== 'function') return false;
  ui.setEditorText.call(ui, text);
  return true;
}

export const PEER_ACTIONS = {
  message: 'Message',
  status: 'Status',
  handOff: 'Hand to my agent',
} as const;

async function runPeerAction(
  ctx: CommandContextLike,
  deps: PeerCommandDeps,
  peer: PeerRecord,
  select: NonNullable<UiLike['select']>
): Promise<void> {
  const ui = ctx.ui;
  const action = await select.call(ui, `${peer.name} — ${describePeer(peer, Date.now())}`, [
    { label: PEER_ACTIONS.message, description: 'Type a message; it goes straight to this peer, labelled as typed by you' },
    { label: PEER_ACTIONS.status, description: 'What it is doing, and its whole todo list' },
    { label: PEER_ACTIONS.handOff, description: 'Start a prompt asking your agent to talk to it' },
  ]);
  switch (action) {
    case PEER_ACTIONS.message: {
      if (typeof ui.input !== 'function') {
        if (!fillComposer(ui, `/msg ${peer.name} `)) notify(ctx, `Send it with /msg ${peer.name} <text>`);
        return;
      }
      const body = await ui.input.call(ui, `Message to ${peer.name}`);
      if (typeof body === 'string' && body.trim() !== '') await sendAndReport(ctx, deps, peer.name, body.trim());
      return;
    }
    case PEER_ACTIONS.status:
      notify(ctx, formatPeerStatus(peer, Date.now()));
      return;
    case PEER_ACTIONS.handOff:
      if (!fillComposer(ui, `Talk to peer \`${peer.name}\` about `)) {
        notify(ctx, `Ask your agent to talk to peer \`${peer.name}\`.`);
      }
      return;
    default:
      return; // Cancelled.
  }
}

export function registerPeersCommand(pi: ExtensionHostLike, deps: PeerCommandDeps): void {
  pi.registerCommand('peers', {
    description: 'List live peers; pick one to message it, see its status, or hand it to your agent',
    handler: async (_args: string, ctx: CommandContextLike) => {
      try {
        const snap = await deps.getSnapshot();
        const select = ctx.ui?.select;
        const others = snap.peers
          .filter((p) => p.name !== snap.ownName)
          .sort((a, b) => a.name.localeCompare(b.name));
        if (typeof select === 'function' && ctx.mode === 'tui' && others.length > 0) {
          let picked: string | undefined;
          try {
            const now = Date.now();
            const held = (snap.held ?? 0) > 0 ? ` · ${snap.held} held for you` : '';
            picked = await select.call(
              ctx.ui,
              `Peers — you are ${snap.ownName}${held} · ↵ message, status or hand to your agent`,
              others.map((p) => ({ label: p.name, description: describePeer(p, now) }))
            );
          } catch {
            // Picker failed — fall through to the text list.
            notify(ctx, formatPeersText(snap, Date.now()));
            return;
          }
          const peer = others.find((p) => p.name === picked);
          if (peer !== undefined) await runPeerAction(ctx, deps, peer, select);
          return;
        }
        notify(ctx, formatPeersText(snap, Date.now()));
      } catch (err) {
        notify(ctx, `/peers failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },
  });

  pi.registerCommand('msg', {
    description: 'Send a message you type to a peer: /msg <peer> <text>',
    handler: async (args: string, ctx: CommandContextLike) => {
      try {
        const parsed = parseMsgArgs(args);
        if (parsed === undefined) {
          const snap = await deps.getSnapshot();
          const names = snap.peers.filter((p) => p.name !== snap.ownName).map((p) => p.name);
          notify(
            ctx,
            `Usage: /msg <peer> <text>. Live peers: ${names.length > 0 ? names.join(', ') : 'none'}`,
            'warning'
          );
          return;
        }
        await sendAndReport(ctx, deps, parsed.to, parsed.body);
      } catch (err) {
        notify(ctx, `/msg failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },
  });
}
