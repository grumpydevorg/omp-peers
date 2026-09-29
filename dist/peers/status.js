/**
 * How a peer's heartbeat reads to a person or an agent: the full status view
 * (`peer_status`, the `/peers` Status action) and the one-line summary the
 * picker shows under each name. One module, so the two can't drift.
 */
import { formatBeatAge } from './presence.js';
/** Checklist box for one native/legacy todo status. */
function todoBox(status) {
    switch (status) {
        case 'completed':
        case 'done':
            return '[x]';
        case 'in_progress':
        case 'doing':
            return '[~]';
        case 'blocked':
            return '[!]';
        case 'abandoned':
            return '[-]';
        default:
            return '[ ]';
    }
}
function todoLine(todo) {
    const blocker = todo.status === 'blocked' && todo.blocker ? ` — ${todo.blocker}` : '';
    return `- ${todoBox(todo.status)} ${todo.text}${blocker}`;
}
/** Native phases render as headers; todos without one stay flat. */
function renderTodos(todos) {
    const lines = [`Todos (${todos.length}):`];
    const groups = new Map();
    for (const todo of todos) {
        const phase = todo.phase ?? '';
        const group = groups.get(phase);
        if (group === undefined)
            groups.set(phase, [todo]);
        else
            group.push(todo);
    }
    for (const [phase, group] of groups) {
        if (phase !== '')
            lines.push(`Phase: ${phase}`);
        for (const todo of group)
            lines.push(todoLine(todo));
    }
    return lines;
}
/**
 * What the peer is doing beyond busy/idle. A busy peer with no fresh tool
 * publishes the bare word `working`, which the state already says.
 */
export function peerActivity(peer) {
    const text = peer.activity?.trim();
    return text === undefined || text === '' || text === 'working' ? undefined : text;
}
/** `3 todos, 1 blocked`, or undefined when the peer publishes none. */
export function todoSummary(todos) {
    if (todos === undefined || todos.length === 0)
        return undefined;
    const open = todos.filter((t) => !['completed', 'done', 'abandoned'].includes(t.status ?? 'pending'));
    const blocked = todos.filter((t) => t.status === 'blocked').length;
    const count = `${open.length} open todo${open.length === 1 ? '' : 's'}`;
    return blocked > 0 ? `${count}, ${blocked} blocked` : count;
}
/** The full view: state, place, beat age, activity, and every todo by phase. */
export function formatPeerStatus(peer, now) {
    const tab = peer.label !== undefined ? ` (herdr tab \`${peer.label}\`)` : '';
    const lines = [
        `\`${peer.name}\`${tab} is ${peer.busy ? 'working' : 'idle'} in ${peer.cwd} · beat ${formatBeatAge(peer.beatAt, now)}.`,
        `Activity: ${peerActivity(peer) ?? '—'}`,
    ];
    if (peer.todos !== undefined && peer.todos.length > 0)
        lines.push(...renderTodos(peer.todos));
    else
        lines.push('Todos: none');
    return lines.join('\n');
}
/** One line under a picker row: state · activity · todos · herdr tab · beat · cwd. */
export function describePeer(peer, now) {
    return [
        peer.busy ? 'working' : 'idle',
        peerActivity(peer),
        todoSummary(peer.todos),
        peer.label !== undefined ? `herdr tab ${peer.label}` : undefined,
        `beat ${formatBeatAge(peer.beatAt, now)}`,
        peer.cwd,
    ]
        .filter((part) => part !== undefined)
        .join(' · ');
}
