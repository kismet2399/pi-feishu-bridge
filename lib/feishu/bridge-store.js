import { getRuntimeSource, readJson, writeJson } from "./config.js";
const DEFAULT_STATE = { version: 1, routes: {}, jobs: {}, sent: {} };
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
