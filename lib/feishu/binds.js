/**
 * [patch:binds] 群 ↔ 会话固定绑定（反向绑定：从 pi-web-ui 会话侧绑定到飞书群）。
 *
 * 唯一数据源：`~/.pi/agent/feishu/binds.pi.json`（独立于 state.pi.json，
 * 避免与本适配器的整对象回写互相覆盖）。写入方是 pi-web 插件 `feishu-bind`，
 * 本适配器**只读**，并按 mtime/size 变化热加载 —— 绑定/解绑后无需重启 daemon。
 *
 * 文件形状：
 * {
 *   "version": 1,
 *   "binds": {
 *     "group:oc_xxx": {
 *       "sessionFile": "/abs/path/xxx.jsonl",
 *       "workspace": "/abs/path/project",
 *       "chatName": "群名（仅展示用）",
 *       "boundAt": 1793774702909,
 *       "boundFrom": "pi-web"
 *     }
 *   }
 * }
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT_DIR } from "./config.js";
import { debugLog } from "./debug.js";
export const BINDS_PI_PATH = join(ROOT_DIR, "binds.pi.json");
/** 绑定存在、但指向的会话文件已丢失。 */
export class BindSessionMissingError extends Error {
    sessionKey;
    sessionFile;
    constructor(sessionKey, sessionFile) {
        super(`绑定的会话文件已丢失：${sessionFile}（键 ${sessionKey}）。请在 pi-web-ui 里解绑或重新绑定。`);
        this.name = "BindSessionMissingError";
        this.sessionKey = sessionKey;
        this.sessionFile = sessionFile;
    }
}
let cache;
/** 读绑定表（带 mtime/size 缓存；文件不存在 = 无绑定）。 */
export function loadBinds() {
    if (!existsSync(BINDS_PI_PATH)) {
        cache = undefined;
        return {};
    }
    let st;
    try {
        st = statSync(BINDS_PI_PATH);
    }
    catch {
        cache = undefined;
        return {};
    }
    if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size)
        return cache.map;
    try {
        const raw = JSON.parse(readFileSync(BINDS_PI_PATH, "utf8"));
        const binds = raw?.binds;
        const map = {};
        if (binds && typeof binds === "object") {
            for (const [key, entry] of Object.entries(binds)) {
                if (entry && typeof entry.sessionFile === "string" && entry.sessionFile.trim()) {
                    map[key] = entry;
                }
            }
        }
        cache = { mtimeMs: st.mtimeMs, size: st.size, map };
        debugLog("feishu.binds.loaded", { count: Object.keys(map).length, keys: Object.keys(map) });
        return map;
    }
    catch (error) {
        // 文件损坏：记日志后按"无绑定"处理（不阻塞群消息）；修好文件即刻生效（mtime 变化）
        debugLog("feishu.binds.parse_failed", {
            error: error instanceof Error ? error.message : String(error),
        });
        cache = undefined;
        return {};
    }
}
/** 单个会话键的绑定。绑定存在但会话文件已丢失 → 抛 BindSessionMissingError（不静默回落）。 */
export function getBind(key) {
    const bind = loadBinds()[key];
    if (!bind)
        return undefined;
    if (!existsSync(bind.sessionFile)) {
        throw new BindSessionMissingError(key, bind.sessionFile);
    }
    return bind;
}
