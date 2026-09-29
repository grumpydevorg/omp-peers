/**
 * Outbound delivery — name→socket send. Never throws into the agent turn:
 * every failure (unknown name, refused relay, dead socket, timeout) resolves
 * to a human-readable text receipt. A frame carries the `instanceId` the
 * name resolved to; a receiver with another id refuses it unread, and the
 * send re-resolves once. A socket that closes without a reply hands the
 * record to `reap`, which removes it only when its instance is confirmed dead.
 */
import { MAX_HOPS, requestPeer, WRONG_PEER } from './server.js';
import { lookupPeer, peerKey } from './ids.js';
/**
 * The hop an outbound send from `st` must carry.
 *
 * A single hop counter per node cannot tell a relay from a conversation: every
 * send would advance the chain, so an orchestrator<->agent request/reply round
 * trip hit the cap after a few rounds. Tracking the last inbound peer instead
 * keeps a conversation (or a reply) at the depth it arrived — only relaying to
 * a DIFFERENT peer advances the chain. Nothing received since the last human
 * prompt means a fresh chain: hop 0.
 */
export function outboundHop(st, to, isReply) {
    if (st.lastInboundPeer === undefined)
        return 0;
    if (isReply || to === st.lastInboundPeer)
        return st.lastInboundHop;
    return st.lastInboundHop + 1;
}
function refusal(hop) {
    return `Refused: this message is ${hop} hops from a human prompt and the limit is ${MAX_HOPS}. The chain has to end here — do not resend. Ask your user if it must continue.`;
}
/** Send one message to the peer named `to`. Never throws. */
export async function sendToPeer(to, message, deps) {
    const name = to?.trim() ?? '';
    const body = message?.trim() ?? '';
    if (name === '' || body === '')
        return 'Both `to` and `message` are required.';
    if (name === 'all')
        return 'Broadcasts are not supported in v1 — address one peer by name (see `/peers`).';
    if (name.toLowerCase() === deps.ownName.toLowerCase())
        return 'Cannot send a message to yourself.';
    if (deps.hop !== undefined && deps.hop > MAX_HOPS)
        return refusal(deps.hop);
    try {
        const found = lookupPeer(name, await deps.listPeers());
        if (!found.found)
            return found.reason;
        let record = found.record;
        const hop = deps.hop ??
            (deps.state !== undefined
                ? outboundHop(deps.state, peerKey(record.sessionId, record.name), deps.isReply === true)
                : 0);
        // Same refusal the server would send — checked locally so an over-limit
        // chain never costs a socket round-trip.
        if (hop > MAX_HOPS)
            return refusal(hop);
        const frame = {
            t: 'msg',
            from: deps.ownName,
            ...(deps.ownId !== undefined && deps.ownId !== '' ? { fromId: deps.ownId } : {}),
            body,
            ...(deps.replyTo !== undefined && deps.replyTo !== '' ? { replyTo: deps.replyTo } : {}),
            ...(deps.ack === true ? { ack: true } : {}),
            ...(deps.human === true ? { human: true } : {}),
            hop,
        };
        let reply;
        for (let attempt = 0;; attempt += 1) {
            reply = await requestPeer(record.socket, {
                ...frame,
                ...(record.instanceId !== undefined ? { toId: record.instanceId } : {}),
            });
            if (attempt > 0 || reply?.ok !== false || reply.error !== WRONG_PEER)
                break;
            // The name moved between listing and delivery: the refused frame reached
            // nothing, so one retry against a fresh listing cannot deliver twice.
            const again = lookupPeer(name, await deps.listPeers());
            if (!again.found)
                return again.reason;
            if (again.record.instanceId === record.instanceId) {
                return `Delivery to ${record.name} failed: its address belongs to another instance. Check \`/peers\`.`;
            }
            record = again.record;
        }
        if (reply === undefined) {
            try {
                await deps.reap?.(record);
            }
            catch {
                // Reaping is best-effort.
            }
            return `No response from ${record.name} (socket closed).`;
        }
        if (!reply.ok)
            return `Delivery to ${record.name} failed: ${reply.error ?? 'unknown error'}`;
        if (reply.outcome === 'dropped')
            return `Delivery to ${record.name} failed (dropped by receiver)`;
        if (reply.outcome === 'aside')
            return `Queued at ${record.name} (wake budget reached — delivers without waking)`;
        if (reply.outcome === 'coalesced')
            return `Delivered to ${record.name} (coalesced into a batch). Its reply will arrive as a peer message.`;
        if (reply.outcome === 'held')
            return `Held at ${record.name} (typing) — delivers when they submit. Its reply will arrive as a peer message.`;
        if (reply.outcome === 'replied')
            return `Replied to ${record.name}.`;
        if (reply.outcome === 'acked')
            return `Ack delivered to ${record.name} (toast — no wake, no reply expected).`;
        return `Delivered to ${record.name} (${reply.outcome ?? 'injected'}). Its reply will arrive as a peer message.`;
    }
    catch (err) {
        return `Delivery to ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
}
