import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ensureRoot, getRuntimeSource } from "./config.js";
import { debugLog } from "./debug.js";
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 5000;
const LOCK_RETRY_MS = 25;
const LOCK_ATTEMPTS = 40;
function dedupePath() {
    return getRuntimeSource().dedupePath;
}
export async function claimFeishuMessage(messageId) {
    if (!messageId)
        return true;
    return withStoreLock(() => {
        const now = Date.now();
        const store = readStore();
        const messages = store.messages || {};
        pruneExpired(messages, now);
        const existing = messages[messageId];
        if (existing) {
            existing.updatedAt = now;
            writeStore({ messages });
            debugLog("feishu.dedupe.ignored_message", {
                messageId,
                status: existing.status,
                firstSeenAt: new Date(existing.firstSeenAt).toISOString(),
                ownerPid: existing.pid,
                currentPid: process.pid,
            });
            return false;
        }
        messages[messageId] = {
            status: "processing",
            firstSeenAt: now,
            updatedAt: now,
            pid: process.pid,
        };
        writeStore({ messages });
        debugLog("feishu.dedupe.claimed_message", { messageId, pid: process.pid });
        return true;
    });
}
export async function markFeishuMessage(messageId, status, error) {
    if (!messageId)
        return;
    await withStoreLock(() => {
        const now = Date.now();
        const store = readStore();
        const messages = store.messages || {};
        pruneExpired(messages, now);
        const existing = messages[messageId] || {
            status,
            firstSeenAt: now,
            updatedAt: now,
            pid: process.pid,
        };
        messages[messageId] = {
            ...existing,
            status,
            updatedAt: now,
            error: error ? error.slice(0, 500) : undefined,
        };
        writeStore({ messages });
    });
}
function readStore() {
    try {
        const path = dedupePath();
        if (!existsSync(path))
            return {};
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return {};
    }
}
function writeStore(store) {
    ensureRoot();
    writeFileSync(dedupePath(), `${JSON.stringify(store, null, 2)}\n`, "utf8");
}
function pruneExpired(messages, now) {
    for (const [messageId, record] of Object.entries(messages)) {
        if (!record.updatedAt || now - record.updatedAt > MESSAGE_TTL_MS) {
            delete messages[messageId];
        }
    }
}
async function withStoreLock(fn) {
    ensureRoot();
    const lockPath = `${dedupePath()}.lock`;
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
        if (tryAcquireLock(lockPath)) {
            try {
                return await fn();
            }
            finally {
                try {
                    rmSync(lockPath, { recursive: true, force: true });
                }
                catch { }
            }
        }
        await sleep(LOCK_RETRY_MS);
    }
    debugLog("feishu.dedupe.lock_timeout", { lockPath });
    return await fn();
}
function tryAcquireLock(lockPath) {
    try {
        mkdirSync(dirname(lockPath), { recursive: true });
        mkdirSync(lockPath);
        return true;
    }
    catch {
        try {
            const age = Date.now() - statSync(lockPath).mtimeMs;
            if (age > LOCK_STALE_MS) {
                rmSync(lockPath, { recursive: true, force: true });
            }
        }
        catch { }
        return false;
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
