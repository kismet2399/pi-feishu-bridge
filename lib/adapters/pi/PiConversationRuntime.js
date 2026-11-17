import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import * as PiSdk from "@earendil-works/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, } from "@earendil-works/pi-coding-agent";
import { CHILD_SESSION_ENV, ensureRoot, readJson, STATE_PATH, writeJson } from "../../feishu/config.js";
import { debugLog } from "../../feishu/debug.js";
import { waitForPrompt } from "../../feishu/prompt-timeout.js";
import { normalizeThinkingLevels } from "../../feishu/thinking.js";
import { ensureWorkspaceExists, resolveWorkspacePath } from "../../feishu/workspace.js";
const RESUME_PAGE_SIZE = 10;
export class PiConversationRuntime {
    sessions = new Map();
    sessionFileStats = new Map();
    queues = new Map();
    activeRuns = new Map();
    modelRuntimePromise;
    defaultProvider;
    defaultModelId;
    state;
    cwd;
    bridge;
    timeouts;
    constructor(cwd, bridge, timeouts = {}) {
        this.cwd = cwd;
        this.bridge = bridge;
        this.timeouts = timeouts;
        ensureRoot();
        this.state = readJson(STATE_PATH, { sessions: {} });
        this.state.sessions ||= {};
        this.state.models ||= {};
        this.state.workspaces ||= {};
        this.loadSettingsDefault();
    }
    /** Read global settings default model for fallback in getSelectedModel. */
    loadSettingsDefault() {
        try {
            const settingsPath = join(getAgentDir(), "settings.json");
            const raw = readFileSync(settingsPath, "utf-8");
            const settings = JSON.parse(raw);
            if (settings.defaultProvider && settings.defaultModel) {
                this.defaultProvider = settings.defaultProvider;
                this.defaultModelId = settings.defaultModel;
            }
        }
        catch { }
    }
    async prompt(key, userText, onReply, onDelta) {
        return this.promptWithImages(key, userText, [], onReply, undefined, onDelta);
    }
    async promptWithImages(key, userText, images, onReply, status, onDelta) {
        const previous = this.previousTurn(key);
        const next = previous.then(async () => {
            debugLog("feishu.prompt.start", { key, textLength: userText.length, imageCount: images.length });
            const session = await this.ensureSessionFresh(key);
            const run = { session, runId: status?.runId, stopped: false, status, onDelta };
            this.activeRuns.set(key, run);
            this.bridge?.beginFeishuInput(session.sessionId);
            // 流式走 session 级订阅（createSession 里）→ run.onDelta，避免漏事件
            let unsub;
            let deltaCount = 0;
            let deltaChars = 0;
            if (onDelta) {
                const userOnDelta = onDelta;
                run.onDelta = (delta) => {
                    deltaCount += 1;
                    deltaChars += delta.length;
                    userOnDelta(delta);
                };
            }
            try {
                try {
                    await this.runPromptWithTimeouts(session, userText, images, key, onReply, status);
                }
                catch (error) {
                    if (run.stopped) {
                        debugLog("feishu.prompt.stopped", { key });
                        return;
                    }
                    throw error;
                }
            }
            finally {
                try {
                    unsub?.();
                }
                catch { }
                run.onDelta = undefined;
                if (this.activeRuns.get(key) === run)
                    this.activeRuns.delete(key);
                this.bridge?.endFeishuInput(session.sessionId);
                this.recordSessionFileStat(key, session.sessionFile);
            }
            if (run.stopped)
                return;
            const answer = extractLastAssistantText(session);
            debugLog("feishu.prompt.done", {
                key,
                answerLength: answer.length,
                deltaCount,
                deltaChars,
            });
            await onReply(answer || "No response.");
            // onReply（ReplyCard.completeWithAnswer）已切到 done；此处仅兜底
            await status?.finish("done");
        }).catch(async (error) => {
            const message = error instanceof Error ? error.message : String(error);
            debugLog("feishu.prompt.error", { key, error: message });
            // 错误也写进同一张卡；onReply 若已是 completeWithAnswer 会 no-op（status 非 running）
            if (status && "ensureFinal" in status && typeof status.ensureFinal === "function") {
                status.ensureFinal(`出错了：${message}`);
                await status.finish("failed", message);
            }
            else {
                await status?.finish("failed", message);
                await onReply(`Pi error: ${message}`);
            }
        });
        this.queues.set(key, next);
        await next;
    }
    /** 供 /status 使用 */
    getStatus(key) {
        const active = this.activeRuns.get(key);
        return {
            cwd: this.getWorkspace(key),
            hasActiveRun: Boolean(active),
            activeStopped: Boolean(active?.stopped),
        };
    }
    async getActualModel(key) {
        const model = await this.getSelectedModel(key);
        if (!model)
            return "默认模型";
        return `${model.provider}/${model.id}`;
    }
    /** 当前 Pi 会话的思考强度和该模型可用的档位。 */
    async getThinkingStatus(key) {
        const session = await this.getSession(key);
        return this.getThinkingStatusForSession(session);
    }
    async getContextStatus(key) {
        try {
            const session = await this.getSession(key);
            const anySession = session;
            const tokens = anySession.contextTokens ?? anySession.tokenCount ?? null;
            const contextWindow = anySession.contextWindow ?? anySession.model?.contextWindow ?? null;
            const percent = tokens != null && contextWindow ? (Number(tokens) / Number(contextWindow)) * 100 : null;
            return { tokens: tokens != null ? Number(tokens) : null, contextWindow: contextWindow != null ? Number(contextWindow) : null, percent };
        }
        catch {
            return null;
        }
    }
    async stopConversation(key, onReply, runId) {
        const active = this.activeRuns.get(key);
        if (!active) {
            const message = "当前没有进行中的处理。";
            await onReply(message);
            return { status: "not_running", message };
        }
        if (runId && active.runId && active.runId !== runId) {
            const message = "这张任务卡片已不是当前进行中的任务。";
            await onReply(message);
            debugLog("feishu.prompt.stop_stale", { key, runId, activeRunId: active.runId });
            return { status: "stale", message };
        }
        active.stopped = true;
        const body = active.status?.bodyText || "";
        await active.status?.stopImmediately("已停止");
        try {
            await active.session.abort();
            debugLog("feishu.prompt.abort", { key });
            const message = "已停止";
            await onReply(message);
            return { status: "stopped", message, body };
        }
        catch (error) {
            active.stopped = false;
            debugLog("feishu.prompt.abort_error", { key, error: error instanceof Error ? error.message : String(error) });
            const message = "停止失败，请重试。";
            await onReply(message);
            return { status: "failed", message };
        }
    }
    async newConversation(key, onReply) {
        const previous = this.previousTurn(key);
        const next = previous.then(async () => {
            const cached = this.sessions.get(key);
            if (cached) {
                try {
                    (await cached).dispose();
                }
                catch { }
            }
            this.sessions.delete(key);
            this.sessionFileStats.delete(key);
            delete this.state.sessions[key];
            writeJson(STATE_PATH, this.state);
            await onReply("已创建新会话。旧会话历史已保留，下一条消息会从新上下文开始。");
        }).catch(async (error) => {
            await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
        });
        this.queues.set(key, next);
        await next;
    }
    async listResumeSessions(key, scope, page) {
        const sessions = await this.getResumeSessions(key, scope);
        const normalizedPage = Math.max(0, Math.floor(page));
        const total = sessions.length;
        const totalPages = Math.max(1, Math.ceil(total / RESUME_PAGE_SIZE));
        const clampedPage = Math.min(normalizedPage, totalPages - 1);
        const currentSessionPath = this.normalizeSessionPath(this.state.sessions[key]);
        const start = clampedPage * RESUME_PAGE_SIZE;
        const items = sessions.slice(start, start + RESUME_PAGE_SIZE).map((session) => {
            const sessionPath = this.normalizeSessionPath(session.path) || session.path;
            return {
                path: session.path,
                title: session.name?.trim() || summarizeFirstMessage(session.firstMessage),
                subtitle: session.name?.trim()
                    ? summarizeFirstMessage(session.firstMessage)
                    : `消息数：${session.messageCount}`,
                modifiedLabel: formatModifiedLabel(session.modified),
                workspaceLabel: scope === "all" ? formatWorkspaceLabel(session.cwd) : undefined,
                isCurrent: Boolean(currentSessionPath && sessionPath && currentSessionPath === sessionPath),
            };
        });
        return {
            key,
            workspacePath: this.getWorkspace(key),
            scope,
            page: clampedPage,
            total,
            totalPages,
            items,
        };
    }
    async resumeConversation(key, sessionPathInput, onReply) {
        if (this.activeRuns.has(key)) {
            await onReply("当前还有进行中的处理，请先发送 /stop，再切换历史会话。");
            return;
        }
        const previous = this.previousTurn(key);
        const next = previous.then(async () => {
            const sessionPath = this.normalizeExistingSessionPath(sessionPathInput);
            const sessionInfo = await this.findSessionInfo(sessionPath);
            if (!sessionInfo) {
                await onReply("这条历史会话不存在，可能已经被删除。请重新打开 /resume 选择。");
                return;
            }
            const currentPath = this.normalizeSessionPath(this.state.sessions[key]);
            if (currentPath === sessionPath) {
                this.state.workspaces[key] = sessionInfo.cwd || this.getWorkspace(key);
                writeJson(STATE_PATH, this.state);
                this.recordSessionFileStat(key, sessionPath);
                await onReply(`你已经在这个历史会话里了。\n当前工作区：${this.state.workspaces[key]}`);
                return;
            }
            const cached = this.sessions.get(key);
            if (cached) {
                try {
                    (await cached).dispose();
                }
                catch { }
            }
            this.sessions.delete(key);
            this.sessionFileStats.delete(key);
            this.state.sessions[key] = sessionPath;
            this.state.workspaces[key] = sessionInfo.cwd || this.cwd;
            writeJson(STATE_PATH, this.state);
            this.recordSessionFileStat(key, sessionPath);
            await onReply([
                `已切换到历史会话：${sessionInfo.name?.trim() || summarizeFirstMessage(sessionInfo.firstMessage)}`,
                `工作区：${this.state.workspaces[key]}`,
                "下一条消息会继续接着这个会话往下聊。",
            ].join("\n"));
        }).catch(async (error) => {
            await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
        });
        this.queues.set(key, next);
        await next;
    }
    async selectModel(key, provider, modelId, onReply) {
        const previous = this.previousTurn(key);
        const next = previous.then(async () => {
            const modelRuntime = await this.getModelRuntime();
            const model = modelRuntime.getModel(provider, modelId);
            if (!model || !modelRuntime.hasConfiguredAuth(model)) {
                await onReply(`这个模型当前不可用：${provider}/${modelId}。请发送 /model 重新选择。`);
                return;
            }
            const existing = this.state.models?.[key];
            this.state.models[key] = { provider, id: modelId, thinkingLevel: existing?.thinkingLevel };
            writeJson(STATE_PATH, this.state);
            const cached = this.sessions.get(key);
            if (cached) {
                try {
                    (await cached).dispose();
                }
                catch { }
            }
            this.sessions.delete(key);
            this.sessionFileStats.delete(key);
            await onReply(`已切换到 ${provider}/${modelId}。当前飞书会话后续都会使用这个模型。`);
        }).catch(async (error) => {
            await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
        });
        this.queues.set(key, next);
        await next;
    }
    async selectThinkingLevel(key, level, onReply) {
        if (this.activeRuns.has(key)) {
            await onReply("当前正在生成回复，请等待完成后再调整思考强度。");
            return;
        }
        const previous = this.previousTurn(key);
        const next = previous.then(async () => {
            const session = await this.getSession(key);
            const status = this.getThinkingStatusForSession(session);
            if (!status.available) {
                await onReply("无法从 Pi 读取当前模型可用的 thinking levels，未做任何修改。请稍后重试。");
                return;
            }
            if (!status.availableLevels.includes(level)) {
                await onReply(`Pi 当前模型不支持 thinking level \`${level}\`。请重新发送 /thinking 选择。`);
                return;
            }
            const sessionApi = session;
            if (typeof sessionApi.setThinkingLevel !== "function") {
                await onReply("当前 Pi 版本不支持从飞书调整思考强度。请升级 Pi 后重试。");
                return;
            }
            sessionApi.setThinkingLevel(level);
            const existing = this.state.models?.[key];
            if (existing) {
                this.state.models[key] = { ...existing, thinkingLevel: level };
                writeJson(STATE_PATH, this.state);
            }
            const effective = this.getThinkingStatusForSession(session).currentLevel || level;
            await onReply(`Thinking level set to: ${effective}`);
        }).catch(async (error) => {
            await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
        });
        this.queues.set(key, next);
        await next;
    }
    getWorkspace(key) {
        return this.state.workspaces?.[key] || this.cwd;
    }
    async switchWorkspace(key, workspaceInput, onReply) {
        if (!workspaceInput) {
            const current = this.getWorkspace(key);
            await onReply([
                `当前工作区：${current}`,
                "用法：/workspace /绝对路径",
                "也支持：/workspace ~/your/project",
            ].join("\n"));
            return;
        }
        const previous = this.previousTurn(key);
        const next = previous.then(async () => {
            const workspace = resolveWorkspacePath(workspaceInput);
            const cached = this.sessions.get(key);
            if (cached) {
                try {
                    (await cached).dispose();
                }
                catch { }
            }
            this.sessions.delete(key);
            this.sessionFileStats.delete(key);
            delete this.state.sessions[key];
            this.state.workspaces[key] = workspace;
            writeJson(STATE_PATH, this.state);
            await onReply(`已切换到工作区：${workspace}\n下一条消息会在这个目录里创建新的 Pi 会话。`);
        }).catch(async (error) => {
            await onReply(error instanceof Error ? error.message : `Pi error: ${String(error)}`);
        });
        this.queues.set(key, next);
        await next;
    }
    async getAvailableModels() {
        const modelRuntime = await this.getModelRuntime();
        const available = await modelRuntime.getAvailable();
        return [...available]
            .map(toRuntimeModel)
            .sort((a, b) => {
            const providerCmp = a.provider.localeCompare(b.provider);
            if (providerCmp !== 0)
                return providerCmp;
            return a.id.localeCompare(b.id);
        });
    }
    async getSelectedModel(key) {
        const native = await this.getSelectedNativeModel(key);
        return native ? toRuntimeModel(native) : undefined;
    }
    /** 内部使用的原生 Pi 模型（不跨出本适配器）。 */
    async getSelectedNativeModel(key) {
        const modelRuntime = await this.getModelRuntime();
        const selected = this.state.models?.[key];
        if (selected) {
            const model = modelRuntime.getModel(selected.provider, selected.id);
            if (model && modelRuntime.hasConfiguredAuth(model))
                return model;
        }
        const cached = this.sessions.get(key);
        if (cached) {
            return (await cached).model;
        }
        // Check settings default model before falling back to first available
        if (this.defaultProvider && this.defaultModelId) {
            const defaultModel = modelRuntime.getModel(this.defaultProvider, this.defaultModelId);
            if (defaultModel && modelRuntime.hasConfiguredAuth(defaultModel)) {
                return defaultModel;
            }
        }
        const available = await this.getAvailableModels();
        const first = available[0];
        return first ? modelRuntime.getModel(first.provider, first.id) : undefined;
    }
    getModelRuntime() {
        this.modelRuntimePromise ||= createModelRuntimeAdapter();
        return this.modelRuntimePromise;
    }
    resetMemory() {
        for (const session of this.sessions.values()) {
            void session.then((s) => s.dispose()).catch(() => undefined);
        }
        this.sessions.clear();
        this.sessionFileStats.clear();
        this.queues.clear();
        this.state = { sessions: {}, models: {}, workspaces: {} };
    }
    recordSessionFileStat(key, sessionFile) {
        const filePath = sessionFile || this.state.sessions[key];
        if (!filePath) {
            this.sessionFileStats.delete(key);
            return;
        }
        try {
            if (existsSync(filePath)) {
                const stat = statSync(filePath);
                this.sessionFileStats.set(key, {
                    mtimeMs: stat.mtimeMs,
                    size: stat.size,
                });
            }
        }
        catch { }
    }
    async ensureSessionFresh(key) {
        const cachedPromise = this.sessions.get(key);
        if (!cachedPromise) {
            return this.getSession(key);
        }
        const sessionFile = this.state.sessions[key];
        const recorded = this.sessionFileStats.get(key);
        if (sessionFile && existsSync(sessionFile)) {
            try {
                const currentStat = statSync(sessionFile);
                const isModified = recorded
                    ? currentStat.mtimeMs > recorded.mtimeMs || currentStat.size !== recorded.size
                    : false;
                if (isModified) {
                    debugLog("feishu.pi.session_hot_reload", {
                        key,
                        sessionFile,
                        recordedMtime: recorded?.mtimeMs,
                        currentMtime: currentStat.mtimeMs,
                        recordedSize: recorded?.size,
                        currentSize: currentStat.size,
                    });
                    try {
                        const oldSession = await cachedPromise;
                        oldSession.dispose();
                    }
                    catch { }
                    this.sessions.delete(key);
                    const refreshed = this.createSession(key);
                    this.sessions.set(key, refreshed);
                    return refreshed;
                }
                if (!recorded) {
                    this.sessionFileStats.set(key, {
                        mtimeMs: currentStat.mtimeMs,
                        size: currentStat.size,
                    });
                }
            }
            catch { }
        }
        return cachedPromise;
    }
    getSession(key) {
        const cached = this.sessions.get(key);
        if (cached)
            return cached;
        const created = this.createSession(key);
        this.sessions.set(key, created);
        return created;
    }
    getThinkingStatusForSession(session) {
        const sessionApi = session;
        const currentLevel = typeof sessionApi.thinkingLevel === "string" && sessionApi.thinkingLevel.trim()
            ? sessionApi.thinkingLevel
            : undefined;
        if (typeof sessionApi.getAvailableThinkingLevels !== "function") {
            return { currentLevel, availableLevels: [], available: false };
        }
        try {
            return {
                currentLevel,
                availableLevels: normalizeThinkingLevels(sessionApi.getAvailableThinkingLevels()),
                available: true,
            };
        }
        catch {
            return { currentLevel, availableLevels: [], available: false };
        }
    }
    previousTurn(key) {
        // Keep a conversation serial for as long as Pi needs. A bridge-side queue
        // timeout can start a second turn while the first is still streaming.
        return this.queues.get(key) || Promise.resolve();
    }
    notifyMs() {
        const sec = this.timeouts.promptNotifySec;
        return typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
    }
    hardTimeoutMs() {
        const sec = this.timeouts.promptTimeoutSec;
        return typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
    }
    async runPromptWithTimeouts(session, userText, images, key, onReply, status) {
        const notifyMs = this.notifyMs();
        const hardMs = this.hardTimeoutMs();
        const hardSec = Math.round(hardMs / 1000);
        await waitForPrompt(session.prompt(userText, images.length ? { images } : undefined), {
            notifyMs,
            hardMs,
            hardTimeoutMessage: `Pi 模型处理超时（超过 ${hardSec} 秒）仍未完成，已中止处理。可调大 config.json 中的 promptTimeoutSec。`,
            onStillRunning: () => {
                debugLog("feishu.prompt.notify_still_running", { key, elapsedMs: notifyMs });
                // A ReplyCard stays visibly "replying"; sending this as a final answer
                // would prematurely close the same card, so only non-card callers get
                // the legacy notice.
                if (status)
                    return;
                void onReply("⏳ 仍在处理中，没有失败。请耐心等待，也可以点击「停止」中止。")
                    .catch(() => undefined);
            },
            onHardTimeout: async () => {
                debugLog("feishu.prompt.hard_timeout", { key, elapsedMs: hardMs });
                try {
                    await session.abort();
                }
                catch { }
            },
        });
    }
    async createSession(key) {
        const workspaceCwd = this.getWorkspace(key);
        ensureWorkspaceExists(workspaceCwd);
        const existingFile = this.state.sessions[key];
        const selected = this.state.models?.[key];
        const modelRuntime = await this.getModelRuntime();
        const model = selected ? modelRuntime.getModel(selected.provider, selected.id) : undefined;
        const sessionManager = existingFile && existsSync(existingFile)
            ? SessionManager.open(existingFile, undefined, workspaceCwd)
            : SessionManager.create(workspaceCwd);
        const loader = new DefaultResourceLoader({
            cwd: workspaceCwd,
            agentDir: getAgentDir(),
            systemPromptOverride: (base) => {
                const extra = "You are replying through Feishu/Lark. Keep answers concise and readable in chat. Do not use markdown tables.";
                return base?.trim() ? `${base}\n\n${extra}` : extra;
            },
        });
        const previousChildEnv = process.env[CHILD_SESSION_ENV];
        process.env[CHILD_SESSION_ENV] = "1";
        try {
            await loader.reload();
        }
        finally {
            if (previousChildEnv === undefined)
                delete process.env[CHILD_SESSION_ENV];
            else
                process.env[CHILD_SESSION_ENV] = previousChildEnv;
        }
        const { session } = await createAgentSession({
            cwd: workspaceCwd,
            agentDir: getAgentDir(),
            ...modelRuntime.sessionOptions,
            model,
            sessionManager,
            resourceLoader: loader,
        });
        await session.bindExtensions({});
        this.bridge?.attachSession(key, session.sessionId);
        // 会话级长期订阅：保证 text_delta 在 prompt 期间一定能收到
        session.subscribe((event) => {
            const run = this.activeRuns.get(key);
            run?.status?.updateFromEvent(event);
            const delta = extractAssistantTextDelta(event);
            if (delta && run && !run.stopped) {
                // 优先 onDelta（与 prompt 绑定）；否则直接 append 到 status 卡
                if (run.onDelta)
                    run.onDelta(delta);
                else if (run.status && typeof run.status.append === "function") {
                    run.status.append(delta);
                }
            }
            if (event.type === "message_end") {
                handlePiMessageEnd(this.bridge, session.sessionId, key, event.message);
            }
        });
        const desiredThinkingLevel = this.state.models?.[key]?.thinkingLevel;
        if (desiredThinkingLevel && typeof session.setThinkingLevel === "function") {
            try {
                session.setThinkingLevel(desiredThinkingLevel);
            }
            catch { }
        }
        if (session.sessionFile && this.state.sessions[key] !== session.sessionFile) {
            this.state.sessions[key] = session.sessionFile;
            writeJson(STATE_PATH, this.state);
        }
        this.recordSessionFileStat(key, session.sessionFile);
        return session;
    }
    async getResumeSessions(key, scope) {
        const base = scope === "all"
            ? await SessionManager.listAll()
            : await SessionManager.list(this.getWorkspace(key));
        return [...base].sort((a, b) => toTimeMs(b.modified) - toTimeMs(a.modified));
    }
    async findSessionInfo(sessionPath) {
        const currentWorkspace = this.getWorkspaceFromSessionFile(sessionPath);
        const localSessions = currentWorkspace ? await SessionManager.list(currentWorkspace) : [];
        const normalizedTarget = this.normalizeSessionPath(sessionPath);
        const fromLocal = localSessions.find((item) => this.normalizeSessionPath(item.path) === normalizedTarget);
        if (fromLocal)
            return fromLocal;
        const allSessions = await SessionManager.listAll();
        return allSessions.find((item) => this.normalizeSessionPath(item.path) === normalizedTarget);
    }
    getWorkspaceFromSessionFile(sessionPath) {
        try {
            return SessionManager.open(sessionPath).getCwd();
        }
        catch {
            return undefined;
        }
    }
    normalizeExistingSessionPath(path) {
        if (!path || !existsSync(path)) {
            throw new Error("历史会话不存在，可能已经被删除。");
        }
        return realpathSync(path);
    }
    normalizeSessionPath(path) {
        if (!path)
            return undefined;
        try {
            return existsSync(path) ? realpathSync(path) : path;
        }
        catch {
            return path;
        }
    }
}
/**
 * Pi changed its model-session API between releases. Keep the bridge usable
 * with both the AuthStorage/ModelRegistry API and the newer ModelRuntime API.
 */
async function createModelRuntimeAdapter() {
    const sdk = PiSdk;
    if (typeof sdk.ModelRuntime?.create === "function") {
        const runtime = await sdk.ModelRuntime.create();
        return {
            getModel: (provider, id) => runtime.getModel(provider, id),
            hasConfiguredAuth: (model) => runtime.hasConfiguredAuth(model.provider),
            getAvailable: async () => [...await runtime.getAvailable()],
            sessionOptions: { modelRuntime: runtime },
        };
    }
    if (typeof sdk.AuthStorage?.create === "function" && typeof sdk.ModelRegistry?.create === "function") {
        const authStorage = sdk.AuthStorage.create();
        const modelRegistry = sdk.ModelRegistry.create(authStorage);
        return {
            getModel: (provider, id) => modelRegistry.find(provider, id),
            hasConfiguredAuth: (model) => modelRegistry.hasConfiguredAuth(model),
            getAvailable: async () => [...await modelRegistry.getAvailable()],
            sessionOptions: { authStorage, modelRegistry },
        };
    }
    throw new Error("当前 Pi 版本不支持创建飞书会话所需的模型运行时。");
}
async function withTimeout(promise, timeoutMs, timeoutMessage) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
/** 从 Pi AgentSession 事件中提取 assistant 最终可见文本增量 */
function extractAssistantTextDelta(event) {
    if (!event || typeof event !== "object")
        return undefined;
    // 标准：message_update + assistantMessageEvent.text_delta
    if (event.type === "message_update") {
        const ame = event.assistantMessageEvent;
        if (ame?.type === "text_delta" && typeof ame.delta === "string" && ame.delta) {
            return ame.delta;
        }
        // 兼容：delta 挂在 event 上
        if (typeof event.delta === "string" && event.delta)
            return event.delta;
    }
    // 兼容：顶层 text_delta
    if (event.type === "text_delta" && typeof event.delta === "string" && event.delta) {
        return event.delta;
    }
    return undefined;
}
function extractLastAssistantText(session) {
    const messages = [...(session.messages || [])].reverse();
    for (const msg of messages) {
        if (msg.role !== "assistant")
            continue;
        const content = msg.content;
        if (typeof content === "string")
            return content.trim();
        if (Array.isArray(content)) {
            return content
                .map((p) => p?.type === "text" ? p.text : "")
                .join("")
                .trim();
        }
    }
    return "";
}
/** 把 Pi 原生模型对象转换成平台无关的 RuntimeModel（禁止原生对象泄漏到飞书层）。 */
function toRuntimeModel(model) {
    const input = Array.isArray(model?.input) ? model.input : [];
    return {
        provider: String(model?.provider ?? ""),
        id: String(model?.id ?? ""),
        name: typeof model?.name === "string" ? model.name : undefined,
        supportsImage: input.includes("image"),
    };
}
/**
 * 把 Pi 的 message_end 事件解析成平台无关的桥接事件（Pi 内部任务回传）。
 * 原 ConversationManager.handleMessageEnd 的等价逻辑。
 */
export function handlePiMessageEnd(bridge, sessionId, sessionKey, message) {
    if (!bridge || !sessionId || !message)
        return;
    if (message.role === "toolResult" && message.toolName === "schedule_prompt") {
        const details = message.details || {};
        if (details.action !== "add")
            return;
        const rawJobs = Array.isArray(details.jobs) ? details.jobs : [];
        const jobs = [];
        for (const job of rawJobs) {
            if (!job?.id)
                continue;
            jobs.push({
                id: String(job.id),
                name: typeof job.name === "string" ? job.name : undefined,
            });
        }
        if (jobs.length) {
            bridge.handleJobEvent({ kind: "created", sessionId, sessionKey, jobs });
        }
        return;
    }
    if (message.role === "custom" && message.customType === "scheduled_prompt") {
        const details = message.details || {};
        const jobId = typeof details.jobId === "string" ? details.jobId : "";
        if (!jobId)
            return;
        if (details.mode === "subagent_done" && typeof details.output === "string") {
            bridge.handleJobEvent({
                kind: "done",
                sessionId,
                jobId,
                text: details.output,
                dedupeKey: `subagent_done:${jobId}:${message.id || details.output}`,
            });
            return;
        }
        if (details.mode === "subagent_error" && typeof details.error === "string") {
            bridge.handleJobEvent({
                kind: "error",
                sessionId,
                jobId,
                error: details.error,
                dedupeKey: `subagent_error:${jobId}:${message.id || details.error}`,
            });
            return;
        }
        bridge.handleJobEvent({ kind: "marker", sessionId, jobId });
        return;
    }
    if (message.role === "assistant") {
        const text = extractMessageText(message);
        bridge.handleJobEvent({
            kind: "output",
            sessionId,
            text,
            messageId: message.id,
            timestamp: message.timestamp,
        });
    }
}
function extractMessageText(message) {
    const content = message.content;
    if (typeof content === "string")
        return content.trim();
    if (!Array.isArray(content))
        return "";
    return content
        .map((part) => part?.type === "text" ? part.text : "")
        .join("")
        .trim();
}
function summarizeFirstMessage(text) {
    const normalized = (text || "").replace(/\s+/g, " ").trim();
    if (!normalized)
        return "未命名会话";
    return normalized.length > 36 ? `${normalized.slice(0, 35)}...` : normalized;
}
function formatModifiedLabel(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime()))
        return "未知";
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const min = String(date.getMinutes()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}
function formatWorkspaceLabel(cwd) {
    if (!cwd)
        return "(unknown)";
    return `${basename(cwd)} · ${cwd}`;
}
function toTimeMs(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}
