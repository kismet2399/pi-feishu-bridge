import { getRuntimeSource, readJson, writeJson } from "./config.js";
const DEFAULT_STATE = { version: 1, routes: {}, jobs: {}, sent: {}, cards: {} };
// [patch:quoted-card-recall] 出站卡片答案表按时间倒序保留的条数上限
const CARD_ANSWER_KEEP = 500;
// 飞书对 CardKit 卡片（card_id 引用）只回占位内容，被引用时正文只能从我们自己的出站记录补回来。
function pruneCardAnswers(cards) {
    const entries = Object.entries(cards);
    if (entries.length <= CARD_ANSWER_KEEP)
        return;
    entries.sort((a, b) => b[1].at - a[1].at);
    for (const [id] of entries.slice(CARD_ANSWER_KEEP))
        delete cards[id];
}
function bridgePath() {
    return getRuntimeSource().bridgePath;
}
export class FeishuBridgeStore {
    bindConversation(sessionKey, msg, sessionId) {
        const state = this.read();
        const previous = state.routes[sessionKey];
        const route = {
            sessionKey,
            sessionId: sessionId || previous?.sessionId,
            chatId: msg.chatId,
            chatType: msg.chatType,
            threadMessageId: routeThreadMessageId(msg, previous),
            lastMessageId: msg.messageId,
            updatedAt: Date.now(),
        };
        state.routes[sessionKey] = route;
        this.write(state);
        return route;
    }
    attachSession(sessionKey, sessionId) {
        const state = this.read();
        const route = state.routes[sessionKey];
        if (!route || route.sessionId === sessionId)
            return;
        state.routes[sessionKey] = { ...route, sessionId, updatedAt: Date.now() };
        this.write(state);
    }
    getRoute(sessionKey) {
        return this.read().routes[sessionKey];
    }
    bindJob(sessionKey, jobId, jobName, sessionId) {
        const state = this.read();
        const route = state.routes[sessionKey];
        if (!route)
            return undefined;
        const jobRoute = {
            ...route,
            sessionId: sessionId || route.sessionId,
            jobId,
            jobName,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        state.jobs[jobId] = jobRoute;
        this.write(state);
        return jobRoute;
    }
    getJob(jobId) {
        return this.read().jobs[jobId];
    }
    /** [patch:quoted-card-recall] 记录出站卡片消息 id → 本轮答案文本（落盘，daemon 重启后仍能回填）。 */
    rememberCardAnswer(messageId, text) {
        if (!messageId || !text.trim())
            return;
        const state = this.read();
        const cards = (state.cards = state.cards || {});
        cards[messageId] = { text, at: Date.now() };
        pruneCardAnswers(cards);
        this.write(state);
    }
    /** 取回被引用卡片的正文；没有出站记录时返回 undefined。 */
    getCardAnswer(messageId) {
        return this.read().cards?.[messageId]?.text;
    }
    markSent(deliveryKey) {
        const state = this.read();
        state.sent[deliveryKey] = Date.now();
        this.write(state);
    }
    hasSent(deliveryKey) {
        return Boolean(this.read().sent[deliveryKey]);
    }
    read() {
        const raw = readJson(bridgePath(), DEFAULT_STATE);
        return {
            version: 1,
            routes: { ...(raw.routes || {}) },
            jobs: { ...(raw.jobs || {}) },
            sent: { ...(raw.sent || {}) },
            cards: { ...(raw.cards || {}) },
        };
    }
    write(state) {
        writeJson(bridgePath(), state);
    }
}
function routeThreadMessageId(msg, previous) {
    if (msg.rootId || msg.parentId)
        return msg.rootId || msg.parentId;
    if (previous?.threadMessageId)
        return previous.threadMessageId;
    if (msg.threadId || msg.chatMode === "topic")
        return msg.messageId;
    return undefined;
}
