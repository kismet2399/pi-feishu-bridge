/**
 * 回复呈现：
 * - 默认 CardKit streaming_mode：客户端逐字打印（print_step=1）
 * - 关闭流式时：先「回复中」卡，结束一次写入全文
 * - 不展示工具/阶段过程
 */
import { randomUUID } from "node:crypto";
import { buildReplyCard, defaultFinalNote, } from "./card-builder.js";
import { CardKitStream } from "./cardkit-stream.js";
import { loadConfig, runtimeEnv } from "./config.js";
import { debugLog } from "./debug.js";
export { buildReplyCard, parseStopTaskActionValue, STOP_ACTION, } from "./card-builder.js";
function resolveStreamOptions(override) {
    const cfg = loadConfig();
    return {
        enabled: override?.enabled ?? cfg?.streamingReply !== false,
        printFrequencyMs: Math.max(20, override?.printFrequencyMs
            ?? parseEnvInt("FEISHU_STREAM_PRINT_FREQUENCY_MS")
            ?? cfg?.streamPrintFrequencyMs
            ?? 50),
        printStep: Math.max(1, override?.printStep
            ?? parseEnvInt("FEISHU_STREAM_PRINT_STEP")
            ?? cfg?.streamPrintStep
            ?? 1),
        pushIntervalMs: Math.max(50, override?.pushIntervalMs
            ?? parseEnvInt("FEISHU_STREAM_PUSH_INTERVAL_MS")
            ?? cfg?.streamPushIntervalMs
            ?? 120),
    };
}
function parseEnvInt(name) {
    const v = runtimeEnv(name)?.trim();
    if (!v)
        return undefined;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
}
export class ReplyCard {
    runId = randomUUID();
    status = "running";
    body = "";
    note;
    get bodyText() { return this.body; }
    cardkit;
    fallbackCardId;
    // [patch:quoted-card-recall] CardKit 流式卡片的出站消息 id（被引用时用它回填正文）
    cardkitMessageId;
    streamOpts;
    key;
    replyToMessageId;
    transport;
    constructor(key, replyToMessageId, transport, streamOptions) {
        this.key = key;
        this.replyToMessageId = replyToMessageId;
        this.transport = transport;
        this.streamOpts = resolveStreamOptions(streamOptions);
    }
    get messageId() {
        // [patch:quoted-card-recall] 流式路径下没有 fallbackCardId，必须回落到 CardKit 的回传 id
        return this.cardkitMessageId ?? this.fallbackCardId;
    }
    async start() {
        const cfg = loadConfig();
        if (this.streamOpts.enabled && cfg?.appId && cfg?.appSecret) {
            this.cardkit = new CardKitStream(cfg.appId, cfg.appSecret, cfg.domain === "lark" ? "lark" : "feishu", this.replyToMessageId, async (text) => {
                // CardKit 失败：回落为普通最终卡片
                const id = await this.transport.replyCard(this.replyToMessageId, buildReplyCard({
                    key: this.key,
                    runId: this.runId,
                    status: "done",
                    body: text,
                }));
                this.fallbackCardId = id;
            }, {
                printFrequencyMs: this.streamOpts.printFrequencyMs,
                printStep: this.streamOpts.printStep,
                pushIntervalMs: this.streamOpts.pushIntervalMs,
                conversationKey: this.key,
                runId: this.runId,
                // [patch:quoted-card-recall] 记下出站卡片 id：引用回填与 groupAlsoOnReply 都要用
                onOutboundMessageId: (id) => {
                    this.cardkitMessageId = id;
                    this.transport.rememberOutboundMessageId?.(id);
                },
            });
            debugLog("feishu.reply_card.cardkit_ready", {
                key: this.key,
                runId: this.runId,
                ...this.streamOpts,
            });
            // 先让飞书看到「回复中」，不等待 Pi 产出第一段正文；失败仍会在结束时回落为普通回复卡。
            void this.cardkit.startImmediately();
            return;
        }
        // 非流式：先出「回复中」占位卡
        this.fallbackCardId = await this.transport.replyCard(this.replyToMessageId, buildReplyCard({
            key: this.key,
            runId: this.runId,
            status: "running",
            body: "",
        }));
        debugLog("feishu.reply_card.started_static", {
            key: this.key,
            runId: this.runId,
            cardMessageId: this.fallbackCardId,
        });
    }
    updateFromEvent(_event) {
        // 不展示过程
    }
    append(delta) {
        if (this.status !== "running" || !delta)
            return;
        this.body += delta;
        this.cardkit?.append(delta);
    }
    ensureFinal(text) {
        if (!text)
            return;
        if (!this.body.trim() || text.length >= this.body.length)
            this.body = text;
        this.cardkit?.ensureFinal(text);
    }
    async stopImmediately(note = "已停止") {
        await this.finishFinal("stopped", note);
    }
    async finish(status, note) {
        await this.finishFinal(status, note);
    }
    async completeWithAnswer(answer) {
        this.ensureFinal(answer || "（无内容）");
        await this.finishFinal("done", undefined);
    }
    async finishFinal(status, note) {
        if (this.status !== "running")
            return;
        this.status = status;
        this.note = note ?? defaultFinalNote(status);
        if (this.cardkit) {
            // 同一张 CardKit 卡上关闭流式并更新 header（回复/已停止/出错了）
            await this.cardkit.close(this.body, status === "failed" ? "failed" : status === "stopped" ? "stopped" : "done");
            return;
        }
        // 静态卡路径
        if (this.fallbackCardId) {
            try {
                await this.transport.updateCard(this.fallbackCardId, buildReplyCard({
                    key: this.key,
                    runId: this.runId,
                    status,
                    note: status === "done" ? undefined : this.note,
                    body: this.body,
                }));
            }
            catch (error) {
                debugLog("feishu.reply_card.static_final_error", {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }
}
