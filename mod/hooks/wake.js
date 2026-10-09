// Generated from packages/claude-plugin/src/wake/wake.ts in recordplane/pendingyou: edit that, then run
// `pnpm --filter @pendingyou/claude-plugin generate`.

export const TICK_MS = 5000;
export const FAST_MS = 20_000;
export const SLOW_MS = 60_000;
export const RECENT_MS = 30 * 60_000;
export const MAX_BACKOFF_MS = 15 * 60_000;
export const HINT_FLOOR_MS = 5000;
export const BLOCKED_MS = 60_000;
export const FRESH_MS = 10_000;
export const KEEP_MS = 7 * 24 * 60 * 60_000;
export const MAX_CARDS = 50;
export const LEASE_MS = 60_000;
export const RENEW_MS = 20_000;
export const TITLE_CHARS = 80;
const REQUEST_ID = /^req_[A-Za-z0-9-]{1,40}$/;
const OPEN = new Set(['pending', 'snoozed', 'delegated']);
const CLOSED = new Set(['resolved', 'cancelled', 'expired']);
const URGENCIES = new Set(['now', 'today', 'whenever']);
const isUrgency = (value) => typeof value === 'string' && URGENCIES.has(value);
const READS = new Set([
    'post_request',
    'get_request',
    'update_request',
    'reply_in_thread',
    'ack_answer',
    'cancel_request',
    'whoami',
    'list_pending',
    'answer_delegated',
    'hand_back',
]);
export const HANDED_READS = new Set(['get_request', 'answer_delegated', 'hand_back']);
export const APPROVED_DRAFT_NOTICE = 'The approved words are in get_request’s answer.approvedDrafts: send them exactly.';
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const parseJson = (text) => {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
};
const text = (value, max = 200) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined;
const count = (value) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const requestIdOf = (value) => typeof value === 'string' && REQUEST_ID.test(value) ? value : undefined;
export function clip(title) {
    const flat = title.replace(/\s+/g, ' ').trim().replaceAll('“', '‘').replaceAll('”', '’');
    const chars = [...flat];
    return chars.length <= TITLE_CHARS
        ? flat
        : `${chars
            .slice(0, TITLE_CHARS - 1)
            .join('')
            .trimEnd()}…`;
}
export const isPendingYou = (server) => server
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .includes('pendingyou');
export function cardTool(name) {
    const match = /^mcp__(.+)__([a-z_]+)$/.exec(name);
    if (!match)
        return null;
    const [, server = '', tool = ''] = match;
    return READS.has(tool) && isPendingYou(server) ? { server, tool } : null;
}
export function resultObject(result) {
    if (!isObject(result) || result.deny !== undefined || result.isError === true)
        return null;
    if (isObject(result.structuredContent))
        return result.structuredContent;
    const texts = [];
    const blocks = (value) => {
        if (Array.isArray(value))
            for (const block of value)
                if (isObject(block) && typeof block.text === 'string')
                    texts.push(block.text);
    };
    if (typeof result.text === 'string')
        texts.push(result.text);
    if (typeof result.result === 'string')
        texts.push(result.result);
    else if (isObject(result.result)) {
        if (isObject(result.result.structuredContent))
            return result.result.structuredContent;
        blocks(result.result.content);
    }
    else
        blocks(result.result);
    blocks(result.content);
    for (const each of texts) {
        const parsed = parseJson(each);
        if (isObject(parsed))
            return parsed;
    }
    return null;
}
export function nameOf(tool, input) {
    const name = text(input.name, 120);
    if (name || tool !== 'post_request')
        return name;
    const session = typeof input.session === 'string' ? parseJson(input.session) : input.session;
    return isObject(session) ? text(session.label, 120) : undefined;
}
export function argumentsOf(call) {
    const { tool: _tool, tool_use_id: _id, agentId: _agent, consent: _consent, ...rest } = call;
    return rest;
}
export const isClosed = (status) => CLOSED.has(status);
export const isReady = (state) => state.turn === 'agent' || isClosed(state.status);
export const isWaitingOnYou = (state) => state.turn === 'you' && OPEN.has(state.status);
export const momentOf = (state) => `${state.status}/${state.turn}/${state.version}/${state.cursor}`;
export function stateOf(output) {
    const status = text(output.status, 40);
    const turn = output.turn === 'you' || output.turn === 'agent' ? output.turn : undefined;
    const version = count(output.version);
    if (!status || !turn || version === undefined)
        return null;
    const given = isObject(output.answer) ? output.answer.handled : output.handled;
    const handled = given === 'self' || given === 'leave' ? given : undefined;
    const approvedDraft = isObject(output.answer)
        ? Array.isArray(output.answer.approvedDrafts) && output.answer.approvedDrafts.length > 0
        : output.approvedDraft === true;
    return {
        status,
        turn,
        version,
        cursor: typeof output.cursor === 'string' ? output.cursor : '',
        ...(handled ? { handled } : {}),
        ...(approvedDraft ? { approvedDraft: true } : {}),
    };
}
export const emptyBook = (now = 0) => ({ v: 1, updatedAt: now, cards: {} });
export function readBook(value) {
    if (!isObject(value) || value.v !== 1 || !isObject(value.cards))
        return emptyBook();
    const cards = {};
    for (const [requestId, card] of Object.entries(value.cards)) {
        if (!isObject(card) || card.requestId !== requestId || !requestIdOf(requestId))
            continue;
        if (typeof card.server !== 'string' || !isPendingYou(card.server))
            continue;
        const learnedAt = count(card.learnedAt);
        const changedAt = count(card.changedAt);
        if (learnedAt === undefined || changedAt === undefined)
            continue;
        const state = isObject(card.state) ? stateOf(card.state) : null;
        cards[requestId] = {
            requestId,
            server: card.server,
            learnedAt,
            changedAt,
            ...(text(card.name, 120) ? { name: text(card.name, 120) } : {}),
            ...(text(card.title, 400) ? { title: text(card.title, 400) } : {}),
            ...(isUrgency(card.urgency) ? { urgency: card.urgency } : {}),
            ...(card.blocking === true ? { blocking: true } : {}),
            ...(card.askedFirst === true ? { askedFirst: true } : {}),
            ...(state ? { state } : {}),
            ...(typeof card.told === 'string' ? { told: card.told } : {}),
            ...(typeof card.seen === 'string' ? { seen: card.seen } : {}),
            ...(count(card.failures) ? { failures: count(card.failures) } : {}),
            ...(count(card.nextAt) !== undefined ? { nextAt: count(card.nextAt) } : {}),
        };
    }
    return {
        v: 1,
        updatedAt: count(value.updatedAt) ?? 0,
        ...(text(value.name, 120) ? { name: text(value.name, 120) } : {}),
        ...(typeof value.server === 'string' && isPendingYou(value.server)
            ? { server: value.server }
            : {}),
        cards,
    };
}
const listening = (card) => {
    const state = card.state;
    if (!state || isWaitingOnYou(state))
        return true;
    const moment = momentOf(state);
    return moment !== card.told && moment !== card.seen;
};
export function put(book, card) {
    const cards = { ...book.cards, [card.requestId]: card };
    const all = Object.values(cards);
    if (all.length > MAX_CARDS)
        for (const old of all
            .sort((a, b) => Number(listening(a)) - Number(listening(b)) || a.changedAt - b.changedAt)
            .slice(0, all.length - MAX_CARDS))
            delete cards[old.requestId];
    return { ...book, cards };
}
export function drop(book, requestId) {
    if (!book.cards[requestId])
        return book;
    const { [requestId]: _gone, ...cards } = book.cards;
    return { ...book, cards };
}
const pressingOfCard = (card) => ({
    ...(card?.urgency ? { urgency: card.urgency } : {}),
    ...(card?.blocking ? { blocking: true } : {}),
    ...(card?.askedFirst ? { askedFirst: true } : {}),
});
function askedFirstIn(input) {
    const asked = typeof input.askedFirst === 'string' ? parseJson(input.askedFirst) : input.askedFirst;
    return isObject(asked);
}
function pressingFrom(tool, input, card) {
    const urgency = isUrgency(input.urgency) ? input.urgency : card?.urgency;
    const blocking = typeof input.blocking === 'boolean' ? input.blocking : card?.blocking === true;
    const askedFirst = tool === 'post_request' ? askedFirstIn(input) : card?.askedFirst === true;
    return {
        ...(urgency ? { urgency } : {}),
        ...(blocking ? { blocking: true } : {}),
        ...(askedFirst ? { askedFirst: true } : {}),
    };
}
function tracked(book, facts, now) {
    const card = book.cards[facts.requestId];
    const name = facts.name ?? card?.name;
    const title = facts.title ?? card?.title;
    return put(book, {
        requestId: facts.requestId,
        server: facts.server,
        ...(name ? { name } : {}),
        ...(title ? { title } : {}),
        ...(facts.pressing ?? pressingOfCard(card)),
        learnedAt: card?.learnedAt ?? now,
        changedAt: now,
        state: facts.state,
        nextAt: now + FAST_MS,
    });
}
function followedUp(book, follows, now) {
    const card = follows ? book.cards[follows] : undefined;
    if (!card)
        return book;
    const heard = card.state && isReady(card.state) ? { seen: momentOf(card.state) } : {};
    return put(book, { ...card, ...heard, nextAt: now });
}
export function learn(book, call, now) {
    const { server, tool, input, output } = call;
    if (!output)
        return book;
    const name = nameOf(tool, input);
    let next = book;
    if (name && (book.name !== name || book.server !== server))
        next = { ...next, name, server };
    const requestId = requestIdOf(output.requestId) ?? requestIdOf(input.requestId);
    if (!requestId)
        return next;
    const card = next.cards[requestId];
    const version = count(output.version);
    switch (tool) {
        case 'post_request':
        case 'update_request': {
            const status = text(output.status, 40);
            if (!status || !OPEN.has(status) || version === undefined)
                return next;
            const title = text(input.title, 400);
            const posted = tracked(next, {
                requestId,
                server,
                ...(name ? { name } : {}),
                ...(title ? { title: clip(title) } : {}),
                pressing: pressingFrom(tool, input, card),
                state: { status, turn: 'you', version, cursor: card?.state?.cursor ?? '' },
            }, now);
            return tool === 'post_request' ? followedUp(posted, requestIdOf(input.follows), now) : posted;
        }
        case 'reply_in_thread': {
            const reopen = isObject(input.reopen) ? input.reopen : null;
            if (version === undefined || (!reopen && output.turn !== 'you'))
                return next;
            const title = reopen ? text(reopen.title, 400) : undefined;
            const status = reopen ? 'pending' : (card?.state?.status ?? 'pending');
            const cursor = typeof output.messageId === 'string' ? output.messageId : '';
            return tracked(next, {
                requestId,
                server,
                ...(name ? { name } : {}),
                ...(title ? { title: clip(title) } : {}),
                state: { status: OPEN.has(status) ? status : 'pending', turn: 'you', version, cursor },
            }, now);
        }
        case 'get_request': {
            const state = stateOf(output);
            if (!state)
                return next;
            if (!card)
                return isWaitingOnYou(state)
                    ? tracked(next, { requestId, server, ...(name ? { name } : {}), state }, now)
                    : next;
            const moment = momentOf(state);
            const changed = !card.state || momentOf(card.state) !== moment;
            return put(next, {
                ...card,
                state,
                ...(changed ? { changedAt: now } : {}),
                ...(isReady(state) ? { seen: moment } : {}),
            });
        }
        case 'ack_answer':
            return output.status === 'resolved' ? drop(next, requestId) : next;
        case 'cancel_request':
            return output.status === 'cancelled' ? drop(next, requestId) : next;
        default:
            return next;
    }
}
export function checked(card, output, now) {
    const state = stateOf(output) ?? card.state;
    if (!state)
        return failed(card, now, false);
    const changed = !card.state || momentOf(card.state) !== momentOf(state);
    const changedAt = changed ? now : card.changedAt;
    let wait = now - changedAt < RECENT_MS ? FAST_MS : SLOW_MS;
    const pollAfter = count(output.pollAfterSeconds);
    if (!isReady(state) && pollAfter !== undefined && pollAfter * 1000 < wait)
        wait = Math.max(HINT_FLOOR_MS, pollAfter * 1000 + 1000);
    const { failures: _failures, ...rest } = card;
    return { ...rest, state, changedAt, nextAt: now + wait, checkedAt: now };
}
export function failed(card, now, blocked) {
    if (blocked)
        return { ...card, nextAt: now + BLOCKED_MS };
    const failures = (card.failures ?? 0) + 1;
    return {
        ...card,
        failures,
        nextAt: now + Math.min(MAX_BACKOFF_MS, FAST_MS * 2 ** (failures - 1)),
    };
}
export function dueCards(book, now) {
    return Object.values(book.cards)
        .filter((card) => !(card.state && isClosed(card.state.status)) && (card.nextAt ?? 0) <= now)
        .sort((a, b) => (a.nextAt ?? 0) - (b.nextAt ?? 0));
}
export function needsTelling(card) {
    const state = card.state;
    if (!state || !isReady(state))
        return false;
    if (state.status === 'resolved')
        return false;
    const moment = momentOf(state);
    if (moment === card.told || moment === card.seen)
        return false;
    if (state.status === 'cancelled' && (card.told || card.seen))
        return false;
    return true;
}
export const isFresh = (card, now) => card.checkedAt !== undefined && now - card.checkedAt <= FRESH_MS;
export const toTell = (book) => Object.values(book.cards)
    .filter(needsTelling)
    .sort((a, b) => a.changedAt - b.changedAt);
export function told(book, cards) {
    let next = book;
    for (const card of cards) {
        const current = next.cards[card.requestId];
        if (current?.state)
            next = put(next, { ...current, told: momentOf(current.state) });
    }
    return next;
}
export function untold(book, before) {
    let next = book;
    for (const card of before) {
        const current = next.cards[card.requestId];
        if (!current?.state || current.told !== momentOf(current.state))
            continue;
        const { told: _told, ...rest } = current;
        next = put(next, card.told === undefined ? rest : { ...rest, told: card.told });
    }
    return next;
}
export function settle(book, now) {
    let next = book;
    for (const card of Object.values(book.cards)) {
        const done = card.state && isClosed(card.state.status) && !needsTelling(card);
        if (done || now - Math.max(card.learnedAt, card.changedAt) > KEEP_MS)
            next = drop(next, card.requestId);
    }
    return next;
}
export const isStale = (book, now) => now - book.updatedAt > KEEP_MS;
const titled = (card) => card.title ? `“${clip(card.title)}” (${card.requestId})` : card.requestId;
const named = (card) => (card.name ? `name “${card.name}”` : 'your name');
function line(card) {
    const state = card.state;
    const get = `get_request (requestId ${card.requestId}, ${named(card)})`;
    switch (state.status) {
        case 'expired':
            return [
                `nobody answered ${titled(card)} in time, so its fallback is due`,
                'do it now if you haven’t already; there’s nothing to acknowledge',
            ];
        case 'cancelled':
            return [`${titled(card)} was withdrawn`, 'nothing to do'];
        case 'answered':
            if (state.handled === 'self')
                return [
                    `your person will handle ${titled(card)} themselves`,
                    `call ${get} to read it, then close it out: take no action on it, leave things as they are and don’t follow up; ack_answer with its version and an outcome like “Left to you”`,
                ];
            if (state.handled === 'leave')
                return [
                    `your person won’t do ${titled(card)}`,
                    `call ${get} to read it, then close it out: don’t do it for them and don’t follow up; ack_answer with its version and an outcome like “Skipped”`,
                ];
            return [
                `your person answered ${titled(card)}`,
                `call ${get}, act on their words, then ack_answer with its version and a one-line outcome${state.approvedDraft ? `. ${APPROVED_DRAFT_NOTICE.slice(0, -1)}` : ''}`,
            ];
        case 'delegated':
            return [
                `there’s word on ${titled(card)}, which your person handed to another assistant`,
                `call ${get} and do what its helper.next says`,
            ];
        default:
            return [
                `your person wrote to you on ${titled(card)}`,
                `call ${get} to read it, then answer with reply_in_thread`,
            ];
    }
}
const capital = (sentence) => sentence.charAt(0).toUpperCase() + sentence.slice(1);
export function wakeText(cards) {
    const asked = cards.some((card) => card.state?.turn === 'agent' &&
        !isClosed(card.state.status) &&
        card.state.status !== 'delegated' &&
        !card.state.handled);
    const reopen = asked
        ? ' If you need more from them, or the next step, post a new card with follows: that card’s requestId; never reopen.'
        : '';
    if (cards.length === 1) {
        const [happened, todo] = line(cards[0]);
        return `Pending You: ${happened}. ${capital(todo)}.${reopen}`;
    }
    return [
        `Pending You: ${cards.length} of your cards need you.`,
        ...cards.map((card) => {
            const [happened, todo] = line(card);
            return `- ${capital(happened)}: ${todo}.`;
        }),
        ...(reopen ? [reopen.trim()] : []),
    ].join('\n');
}
export function statusText(book, blocked) {
    if (blocked)
        return `to hear answers here, allow mcp__${blocked} in /permissions`;
    const waiting = Object.values(book.cards).filter((card) => card.state && isWaitingOnYou(card.state)).length;
    return waiting ? `${waiting} waiting on you` : undefined;
}
export const blockedNote = (server) => `Pending You can’t wake this session when your person answers: Claude Code doesn’t let it check your cards yet. Ask them to allow mcp__${server} in /permissions (Allow, user settings). Until then, check get_request at breakpoints.`;
export const isRefusal = (error) => /refused|permission|not allowed|haven.t granted/i.test(error instanceof Error ? error.message : String(error));
export function shellWords(command) {
    const words = [];
    let word = '';
    let inWord = false;
    let quote = null;
    for (let index = 0; index < command.length; index++) {
        const char = command[index];
        if (quote === "'") {
            if (char === "'")
                quote = null;
            else
                word += char;
            continue;
        }
        if (quote === '"') {
            if (char === '"')
                quote = null;
            else if (char === '$' || char === '`')
                return null;
            else if (char === '\\' && '"\\$`'.includes(command[index + 1] ?? ''))
                word += command[++index];
            else
                word += char;
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            inWord = true;
        }
        else if (char === '\\') {
            const escaped = command[++index];
            if (escaped === undefined || escaped === '\n')
                return null;
            word += escaped;
            inWord = true;
        }
        else if (char === ' ' || char === '\t') {
            if (inWord)
                words.push(word);
            word = '';
            inWord = false;
        }
        else if (char === '#' && !inWord)
            break;
        else if (';&|<>()`$\n\r'.includes(char))
            return null;
        else {
            word += char;
            inWord = true;
        }
    }
    if (quote)
        return null;
    if (inWord)
        words.push(word);
    return words;
}
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PACKAGE = /^pendingyou(@[\w.^~=<>*-]+)?$/;
const NPX_FLAGS = new Set(['-y', '--yes', '-q', '--quiet', '--prefer-offline', '--prefer-online']);
const OPTION = /^--(origin|timeout)=\S+$/;
export function holdOf(command) {
    const words = shellWords(command.trim());
    if (!words?.length)
        return null;
    let index = 0;
    const at = () => words[index] ?? '';
    if (at() === 'env')
        index++;
    while (ASSIGNMENT.test(at()))
        index++;
    if (at() === 'npx') {
        index++;
        while (NPX_FLAGS.has(at()))
            index++;
        if (!PACKAGE.test(at()))
            return null;
        index++;
    }
    else if (at() === 'pnpm' && words[index + 1] === 'dlx') {
        index += 2;
        if (!PACKAGE.test(at()))
            return null;
        index++;
    }
    else if (at() === 'pendingyou')
        index++;
    else {
        if (/(^|\/)node$/.test(at()))
            index++;
        if (!/(^|\/)pendingyou\/dist\/cli\.js$/.test(at()))
            return null;
        index++;
    }
    let requestId = null;
    let held = false;
    while (index < words.length) {
        const word = at();
        if (OPTION.test(word))
            index++;
        else if (word === '--origin' || word === '--timeout') {
            if (index + 1 >= words.length)
                return null;
            index += 2;
        }
        else if (!held && word === 'hold') {
            held = true;
            index++;
        }
        else if (held && !requestId && REQUEST_ID.test(word)) {
            requestId = word;
            index++;
        }
        else
            return null;
    }
    return held ? requestId : null;
}
export const holdReply = (requestId) => `Pending You: no hold is needed in this session. It’s woken when your person answers ${requestId}, writes to you on it, or its fallback runs, even while it’s idle. Nothing is running in the background and there’s nothing to wait on: keep working, or end your turn.`;
function leaseOf(value) {
    const match = /^(\S+) (\d+)$/.exec(value ?? '');
    return match ? { holder: match[1], until: Number(match[2]) } : null;
}
export function leaseHolder(value, now) {
    const lease = leaseOf(value);
    return lease && lease.until > now ? lease.holder : null;
}
export function claimLease(value, me, now) {
    const lease = leaseOf(value);
    if (lease && lease.until > now && lease.holder !== me)
        return null;
    if (lease && lease.holder === me && lease.until - now > LEASE_MS - RENEW_MS)
        return null;
    return `${me} ${now + LEASE_MS}`;
}
export const HANDED_FAST_MS = 60_000;
export const HANDED_SLOW_MS = 3 * 60_000;
export const HANDED_FOR_MS = 12 * 60 * 60_000;
export const HANDED_GRACE_MS = 30_000;
export const CLAIM_PREFIX = 'handed:';
export const HANDED_PREFIX = 'Pending You: your person handed you';
export const HANDED_REPLY = 'on the question handed to you';
export const HANDED_TALK_TODO = 'If you know now, answer_delegated with your answer and how you know; if you need more, reply_in_thread to “asker”; if it’s your person’s to decide, reply_in_thread with escalate true; if not, hand_back with what you checked.';
const SAID_CHARS = 300;
export const HANDED_TODO = 'If you know, answer_delegated with your answer and how you know; if not, hand_back with what you checked.';
const NAME_CHARS = 60;
export function latestSaid(talk, from) {
    if (!Array.isArray(talk))
        return null;
    const said = talk.filter(isObject);
    const mine = said.findLastIndex((each) => each.from === 'helper');
    const last = said.slice(mine + 1).at(-1);
    const words = last ? text(last.body, 4000) : undefined;
    if (!last || !words || (last.from !== 'asker' && last.from !== 'you'))
        return null;
    return { who: last.from === 'you' ? 'your person' : from, words };
}
export function readSince(known, updatedAt) {
    if (!known?.startsWith('*'))
        return false;
    const at = Number(known.slice(1));
    return !Number.isFinite(at) || at === 0 || Date.parse(updatedAt) <= at;
}
export const handedDue = (seenAt, nextAt, now) => seenAt > 0 && now - seenAt < HANDED_FOR_MS && now >= nextAt;
export const handedNext = (seenAt, now) => now + (now - seenAt < RECENT_MS ? HANDED_FAST_MS : HANDED_SLOW_MS);
export function handedOf(output) {
    const requests = output && Array.isArray(output.requests) ? output.requests : [];
    return requests.flatMap((request) => {
        if (!isObject(request) || request.delegated !== true)
            return [];
        if (request.status !== 'delegated' || request.turn !== 'agent')
            return [];
        const requestId = requestIdOf(request.id);
        const title = text(request.title, 400);
        const updatedAt = text(request.updatedAt, 40);
        const cwd = text(request.cwd, 1000);
        return requestId && title && updatedAt
            ? [
                {
                    requestId,
                    title,
                    updatedAt,
                    ...(cwd ? { cwd } : {}),
                    ...(request.byName === true ? { byName: true } : {}),
                },
            ]
            : [];
    });
}
export function folderKey(path, home) {
    const given = path
        .trim()
        .replaceAll('\\', '/')
        .replace(/\/{2,}/g, '/');
    const base = home?.replace(/\/+$/, '');
    const full = base && given === '~'
        ? base
        : base && given.startsWith('~/')
            ? `${base}${given.slice(1)}`
            : given;
    return (full.replace(/\/+$/, '') || '/').toLowerCase();
}
export function inTaskFolder(folders, task, home) {
    const there = folderKey(task, home);
    return folders.some((folder) => {
        const here = folderKey(folder, home);
        return here === there || here.startsWith(there === '/' ? '/' : `${there}/`);
    });
}
export function takesHanded(handed, folders, home, now) {
    if (handed.byName || !handed.cwd)
        return true;
    if (folders.length === 0)
        return now - Date.parse(handed.updatedAt) >= HANDED_GRACE_MS;
    return inTaskFolder(folders, handed.cwd, home);
}
export function graceEnds(handed, folders) {
    if (handed.byName || !handed.cwd || folders.length > 0)
        return null;
    const at = Date.parse(handed.updatedAt);
    return Number.isFinite(at) ? at + HANDED_GRACE_MS : null;
}
export function folderOf(tool, input) {
    if (tool !== 'post_request')
        return undefined;
    const session = typeof input.session === 'string' ? parseJson(input.session) : input.session;
    return isObject(session) ? text(session.cwd, 1000) : undefined;
}
export function handedView(output, handed, name) {
    const delegated = output && isObject(output.delegated) ? output.delegated : null;
    if (!delegated || output?.status !== 'delegated' || output.turn !== 'agent')
        return null;
    const from = text(delegated.from, 200);
    const mode = delegated.mode === 'freely' || delegated.mode === 'loop' ? delegated.mode : null;
    if (!from || !mode)
        return null;
    const said = latestSaid(delegated.talk, from);
    return {
        requestId: handed.requestId,
        title: text(delegated.title, 400) ?? handed.title,
        from,
        mode,
        note: typeof delegated.note === 'string' && delegated.note.trim() !== '',
        name,
        ...(said ? { said } : {}),
    };
}
export function readClaim(value) {
    if (!isObject(value) || typeof value.moment !== 'string')
        return null;
    const by = text(value.by, 200);
    return { moment: value.moment, at: count(value.at) ?? 0, ...(by ? { by } : {}) };
}
export function claimedElsewhere(value, moment, me) {
    const claim = readClaim(value);
    return claim?.moment === moment && claim.by !== me;
}
export function claimHeld(value, moment, me) {
    const claim = readClaim(value);
    return claim?.moment === moment && claim.by === me;
}
export const LISTENER_KEY = 'handed-listener';
export const SIGNAL_KEY = 'handed-signal';
export const LISTEN_RUN_MS = 4 * 60_000;
export const LISTENER_LEASE_MS = LISTEN_RUN_MS + 30_000;
export const LISTENER_KEEP_MS = 15_000;
export const LISTEN_RETRY_MS = 2 * 60_000;
export const LISTEN_QUIET_MS = 30 * 60_000;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const isoOf = (value) => typeof value === 'string' && ISO_TIME.test(value) ? value : undefined;
export function readListener(value) {
    if (!isObject(value))
        return null;
    const by = text(value.by, 200);
    const until = count(value.until);
    if (!by || until === undefined)
        return null;
    const since = isoOf(value.since);
    const quietUntil = count(value.quietUntil);
    return { by, until, ...(since ? { since } : {}), ...(quietUntil ? { quietUntil } : {}) };
}
export function mayListen(record, me, seenAt, now) {
    if (seenAt <= 0 || now - seenAt >= HANDED_FOR_MS)
        return false;
    if (record?.quietUntil && now < record.quietUntil)
        return false;
    return !record || record.by === me || now >= record.until;
}
export const leaseFor = (record, me, now) => ({
    by: me,
    until: now + LISTENER_LEASE_MS,
    ...(record?.since ? { since: record.since } : {}),
});
export function readWait(stdout) {
    const line = stdout.trim().split('\n').at(-1) ?? '';
    const parsed = parseJson(line);
    if (!isObject(parsed))
        return { error: 'unknown' };
    const since = isoOf(parsed.since);
    if (parsed.error === 'signin' || parsed.error === 'unavailable')
        return { error: parsed.error, ...(since ? { since } : {}) };
    if (!Array.isArray(parsed.handed))
        return { error: 'unknown' };
    const handed = parsed.handed.filter((id) => typeof id === 'string' && REQUEST_ID.test(id));
    return { handed, ...(since ? { since } : {}) };
}
export function listened(record, heard, now) {
    const since = heard.since ?? record.since;
    const quiet = 'error' in heard
        ? now + (heard.error === 'unavailable' ? LISTEN_RETRY_MS : LISTEN_QUIET_MS)
        : undefined;
    return {
        by: record.by,
        until: now + LISTENER_KEEP_MS,
        ...(since ? { since } : {}),
        ...(quiet ? { quietUntil: quiet } : {}),
    };
}
export function listenArgv(config, origin, since) {
    return [
        `${config}/bin/pendingyou-hook`,
        'listen',
        '--handed',
        '--app',
        'claude-code',
        ...(since ? ['--since', since] : []),
        ...(origin === PRODUCTION ? [] : ['--origin', origin]),
    ];
}
export const readSignal = (value) => (isObject(value) ? (count(value.at) ?? 0) : 0);
function cut(value, max) {
    const chars = [...value.replace(/\s+/g, ' ').trim()];
    return chars.length <= max
        ? chars.join('')
        : `${chars
            .slice(0, max - 1)
            .join('')
            .trimEnd()}…`;
}
const handedTitled = (card) => `“${clip(card.title)}” (${card.requestId})`;
function asked(card) {
    const from = cut(card.from, NAME_CHARS);
    return `from ${from} (${card.mode === 'freely' ? `answer freely: your answer goes straight to ${from}` : 'they’ll see your answer first'})`;
}
const readIt = (card) => `get_request (requestId ${card.requestId}, name “${card.name}”) to read it${card.note ? ' and their note' : ''}`;
export function handedText(cards) {
    const quotedSaid = (card) => card.said
        ? `: “${cut(card.said.words, SAID_CHARS).replaceAll('“', '‘').replaceAll('”', '’')}”`
        : '';
    const replied = (said) => said.who === 'your person'
        ? 'your person wrote to you both'
        : `${cut(said.who, NAME_CHARS)} replied`;
    const readTalk = (card) => `get_request (requestId ${card.requestId}, name “${card.name}”) to read what you’ve said to each other`;
    if (cards.length === 1) {
        const card = cards[0];
        if (card.said)
            return `Pending You: ${replied(card.said)} ${HANDED_REPLY}, ${handedTitled(card)}${quotedSaid(card)}. Call ${readTalk(card)}. ${HANDED_TALK_TODO}`;
        return `${HANDED_PREFIX} ${handedTitled(card)}, a question ${asked(card)}. Call ${readIt(card)}. ${HANDED_TODO}`;
    }
    return [
        `${HANDED_PREFIX} ${cards.length} questions from other assistants.`,
        ...cards.map((card) => card.said
            ? `- ${handedTitled(card)}, ${asked(card)}; ${replied(card.said)}${quotedSaid(card)}: call ${readTalk(card)}.`
            : `- ${handedTitled(card)}, ${asked(card)}: call ${readIt(card)}.`),
        `For each one: ${HANDED_TODO.charAt(0).toLowerCase()}${HANDED_TODO.slice(1)}${cards.some((card) => card.said) ? ' Where one replied, you may also reply_in_thread to “asker”, or escalate.' : ''}`,
    ].join('\n');
}
export const CLI_COPY = 'pendingyou-wake';
export const SETUP_SERVER = 'pendingyou';
export const SETUP_AFTER_MS = 3000;
export const SETUP_RETRY_MS = 10_000;
export const SETUP_TRIES = 3;
export const SETUP_SESSIONS = 3;
export const SETUP_QUIET_MS = 10 * 60_000;
export function readSetup(value) {
    if (!isObject(value))
        return { done: false, sessions: [], lastAt: 0 };
    return {
        done: value.done === true,
        sessions: Array.isArray(value.sessions)
            ? value.sessions.filter((id) => typeof id === 'string').slice(-SETUP_SESSIONS)
            : [],
        lastAt: count(value.lastAt) ?? 0,
    };
}
export function setUpOf(output) {
    const app = output && isObject(output.app) ? output.app : null;
    return typeof app?.setUp === 'boolean' ? app.setUp : null;
}
export function setupNeeded(record, sessionId, now) {
    return (!record.done &&
        !record.sessions.includes(sessionId) &&
        record.sessions.length < SETUP_SESSIONS &&
        now - record.lastAt >= SETUP_QUIET_MS);
}
export const prompted = (record, sessionId, now) => ({
    ...record,
    sessions: [...record.sessions, sessionId].slice(-SETUP_SESSIONS),
    lastAt: now,
});
export function connectionOf(output) {
    const app = output && isObject(output.app) ? output.app : null;
    const agent = output && isObject(output.agent) ? output.agent : null;
    const name = typeof app?.name === 'string' && app.name.trim() ? app.name.trim() : 'Claude Code';
    const machine = typeof agent?.machine === 'string' ? agent.machine.trim() : '';
    return machine ? `${name} on ${machine}` : name;
}
export function setupPrompt(connection = 'Claude Code') {
    return `Pending You: ${connection} is connected, but its setup isn’t finished. Three calls, nothing to install or approve: 1. whoami with your name. If it says app.setUp is true, another session did this: stop. 2. report_setup with source claude-code, your name, skillSaved true, hears instant, and skillVersion set to whoami’s skill.latest. Its answer has a testAreaId. 3. post_request a short test question in that testAreaId, tell your person it’s on its way, and end your turn: you’re woken when they answer, so don’t ask them to type anything.`;
}
export const PRESENCE_EVERY_MS = 5 * 60_000;
export const PRESENCE_RUN_MS = 15_000;
const PRODUCTION = 'https://www.pendingyou.com';
export function cliConfigOf(root, name = CLI_COPY) {
    if (name !== CLI_COPY)
        return null;
    return (/^(.+)[\\/]cli[\\/][^\\/]+[\\/]node_modules[\\/]pendingyou[\\/]mod[\\/]?$/.exec(root)?.[1] ??
        /^(.+)[\\/]mod[\\/]?$/.exec(root)?.[1] ??
        null);
}
const SESSION_FILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
export function loadedPath(config, sessionId) {
    return SESSION_FILE.test(sessionId) ? `${config}/wake/sessions/${sessionId}.json` : null;
}
export const loadedNote = (at) => `${JSON.stringify({ at: Math.floor(at) })}\n`;
export function originOf(manifest) {
    let parsed = manifest;
    if (typeof manifest === 'string')
        try {
            parsed = JSON.parse(manifest);
        }
        catch {
            return null;
        }
    const origin = typeof parsed === 'object' && parsed !== null ? parsed.origin : null;
    return typeof origin === 'string' && /^https?:\/\/[^\s/]+$/.test(origin) ? origin : null;
}
export function presenceArgv(config, origin, session) {
    return [
        `${config}/bin/pendingyou-hook`,
        'presence',
        '--app',
        'claude-code',
        '--state',
        'live',
        '--session',
        session.id,
        ...(session.cwd ? ['--cwd', session.cwd] : []),
        ...(session.name ? ['--name', session.name] : []),
        '--at',
        String(Math.floor(session.at)),
        ...(origin === PRODUCTION ? [] : ['--origin', origin]),
    ];
}
export const HERDR_EVERY_MS = 5 * 60_000;
export const HERDR_RUN_MS = 15_000;
export function inHerdr(on, bin, pane) {
    return (on === '1' &&
        typeof bin === 'string' &&
        bin.startsWith('/') &&
        typeof pane === 'string' &&
        /^[A-Za-z0-9]{1,16}:[A-Za-z0-9]{1,16}$/.test(pane));
}
export function herdrCards(book) {
    return Object.values(book.cards)
        .filter((card) => card.state && isWaitingOnYou(card.state))
        .sort((a, b) => (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0))
        .map((card) => ({
        requestId: card.requestId,
        ...(card.title ? { title: card.title } : {}),
        ...pressingOfCard(card),
        at: card.learnedAt,
    }));
}
export const herdrPayload = (book) => JSON.stringify({ name: book.name ?? null, cards: herdrCards(book) });
export function herdrArgv(config, session) {
    return [
        `${config}/bin/pendingyou-hook`,
        'herdr',
        'report',
        '--app',
        'claude-code',
        '--session',
        session.id,
        '--at',
        String(Math.floor(session.at)),
    ];
}
