import { debugLog } from "./debug.js";
export class FeishuBridgeRuntime {
    pendingBySession = new Map();
    activeFeishuInputs = new Set();
    store;
    delivery;
    constructor(store, delivery) {
        this.store = store;
        this.delivery = delivery;
    }
    attachSession(sessionKey, sessionId) {
        this.store.attachSession(sessionKey, sessionId);
    }
    beginFeishuInput(sessionId) {
        this.activeFeishuInputs.add(sessionId);
    }
    endFeishuInput(sessionId) {
        this.activeFeishuInputs.delete(sessionId);
    }
    /** Runtime 适配器把自身事件标准化后调用。 */
    handleJobEvent(event) {
        switch (event.kind) {
            case "created":
                this.captureCreatedJobs(event);
                return;
            case "marker":
                void this.handleScheduledMarker(event);
                return;
            case "done":
                void this.deliverJobResult(event.jobId, event.text, event.dedupeKey);
                return;
            case "error":
                void this.deliverJobResult(event.jobId, `定时任务执行失败：${event.error}`, event.dedupeKey);
                return;
            case "output":
                void this.handleAssistantOutput(event);
                return;
        }
    }
    captureCreatedJobs(event) {
        const { sessionId, sessionKey, jobs } = event;
        if (!sessionKey || !this.activeFeishuInputs.has(sessionId))
            return;
        for (const job of jobs) {
            this.store.bindJob(sessionKey, job.id, job.name, sessionId);
            debugLog("feishu.bridge.job_bound", { sessionKey, sessionId, jobId: job.id, jobName: job.name });
        }
    }
    async handleScheduledMarker(event) {
        const { sessionId, jobId } = event;
        const route = this.store.getJob(jobId);
        if (!route)
            return;
        const pending = this.pendingBySession.get(sessionId) || [];
        pending.push(jobId);
        this.pendingBySession.set(sessionId, pending);
        debugLog("feishu.bridge.scheduled_started", { sessionId, jobId });
    }
    async handleAssistantOutput(event) {
        const pending = this.pendingBySession.get(event.sessionId);
        const nextJobId = pending?.[0];
        if (!nextJobId)
            return;
        const route = this.store.getJob(nextJobId);
        if (!route) {
            pending?.shift();
            if (!pending?.length)
                this.pendingBySession.delete(event.sessionId);
            return;
        }
        const text = event.text;
        if (!text)
            return;
        const deliveryKey = `assistant:${nextJobId}:${event.messageId || event.timestamp || text}`;
        await this.deliverOnce(deliveryKey, route, text);
        pending?.shift();
        if (!pending?.length)
            this.pendingBySession.delete(event.sessionId);
    }
    async deliverJobResult(jobId, text, dedupeKey) {
        const route = this.store.getJob(jobId);
        if (!route)
            return;
        await this.deliverOnce(dedupeKey, route, text);
    }
    async deliverOnce(deliveryKey, route, text) {
        if (this.store.hasSent(deliveryKey))
            return;
        try {
            await this.delivery.send(route, text);
            this.store.markSent(deliveryKey);
            debugLog("feishu.bridge.delivered", { deliveryKey, jobId: route.jobId, sessionKey: route.sessionKey });
        }
        catch (error) {
            debugLog("feishu.bridge.deliver_failed", {
                deliveryKey,
                jobId: route.jobId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}
