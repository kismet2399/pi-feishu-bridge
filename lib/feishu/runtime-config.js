import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parseGroupKeywords } from "./group-trigger.js";
/** 运行时可改配置白名单（不含密钥/连接通道） */
export const RUNTIME_CONFIG_KEYS = [
    "groupPolicy",
    "groupKeywords",
    "groupAlsoOnReply",
    "ignoreBotMessages",
    "reactEmoji",
    "language",
    "streamingReply",
    "streamPrintFrequencyMs",
    "streamPrintStep",
    "streamPushIntervalMs",
];
const FEISHU_ROOT = join(homedir(), ".pi", "agent", "feishu");
export const RUNTIME_OVERRIDES_PATH = join(FEISHU_ROOT, "runtime-overrides.json");
/** 当前 runtime 的 overrides 落盘路径；默认 Pi，由 setRuntimeOverridesPath 切换 */
let currentOverridesPath = RUNTIME_OVERRIDES_PATH;
export function setRuntimeOverridesPath(path) {
    currentOverridesPath = path;
}
export function runtimeOverridesPath() {
    return currentOverridesPath;
}
export function isRuntimeConfigKey(key) {
    return RUNTIME_CONFIG_KEYS.includes(key);
}
export function parseRuntimeConfigValue(key, raw) {
    if (!isRuntimeConfigKey(key)) {
        return { ok: false, error: `不允许修改配置项: ${key}` };
    }
    const text = raw.trim();
    switch (key) {
        case "groupKeywords":
            return { ok: true, value: parseGroupKeywords(text) };
        case "groupPolicy": {
            if (text !== "open" && text !== "mention") {
                return { ok: false, error: "groupPolicy 仅支持 open | mention" };
            }
            return { ok: true, value: text };
        }
        case "language": {
            if (text !== "zh" && text !== "en") {
                return { ok: false, error: "language 仅支持 zh | en" };
            }
            return { ok: true, value: text };
        }
        case "groupAlsoOnReply":
        case "ignoreBotMessages":
        case "streamingReply": {
            const b = parseBoolStrict(text);
            if (b === undefined)
                return { ok: false, error: `${key} 请使用 true/false/1/0` };
            return { ok: true, value: b };
        }
        case "reactEmoji": {
            if (!text)
                return { ok: false, error: "reactEmoji 不能为空" };
            return { ok: true, value: text };
        }
        case "streamPrintFrequencyMs":
        case "streamPrintStep":
        case "streamPushIntervalMs": {
            const n = Number.parseInt(text, 10);
            if (!Number.isFinite(n) || n <= 0) {
                return { ok: false, error: `${key} 必须是正整数` };
            }
            return { ok: true, value: n };
        }
        default:
            return { ok: false, error: `不允许修改配置项: ${key}` };
    }
}
function parseBoolStrict(value) {
    const v = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(v))
        return true;
    if (["0", "false", "no", "off"].includes(v))
        return false;
    return undefined;
}
function readOverridesFile(path) {
    if (!existsSync(path))
        return {};
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return {};
    }
}
function writeOverridesFile(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try {
        chmodSync(path, 0o600);
    }
    catch {
        // ignore chmod failures on non-posix volumes
    }
}
/** 将 overrides 合并进 base；忽略非白名单字段 */
export function applyRuntimeOverrides(base, overrides) {
    const next = { ...base };
    for (const key of RUNTIME_CONFIG_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(overrides, key))
            continue;
        const value = overrides[key];
        if (value === undefined)
            continue;
        if (key === "groupKeywords") {
            next.groupKeywords = parseGroupKeywords(value);
        }
        else {
            next[key] = value;
        }
    }
    return next;
}
export function getRuntimeOverrides(path = runtimeOverridesPath()) {
    const raw = readOverridesFile(path);
    const out = {};
    for (const key of RUNTIME_CONFIG_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(raw, key))
            continue;
        const value = raw[key];
        if (value === undefined)
            continue;
        if (key === "groupKeywords") {
            out.groupKeywords = parseGroupKeywords(value);
        }
        else {
            out[key] = value;
        }
    }
    return out;
}
export function setRuntimeConfig(key, rawValue, options) {
    const parsed = parseRuntimeConfigValue(key, rawValue);
    if (parsed.ok === false)
        return { ok: false, error: parsed.error };
    const path = options?.path ?? runtimeOverridesPath();
    const current = getRuntimeOverrides(path);
    const next = {
        ...current,
        [key]: parsed.value,
    };
    writeOverridesFile(path, next);
    return { ok: true, key: key, value: parsed.value, overrides: next };
}
export function clearRuntimeOverrides(keyOrAll, path = runtimeOverridesPath()) {
    if (keyOrAll === "all") {
        writeOverridesFile(path, {});
        return { ok: true, overrides: {} };
    }
    if (!isRuntimeConfigKey(keyOrAll)) {
        return { ok: false, error: `不允许清除配置项: ${keyOrAll}` };
    }
    const current = { ...getRuntimeOverrides(path) };
    delete current[keyOrAll];
    writeOverridesFile(path, current);
    return { ok: true, overrides: current };
}
export function formatRuntimeConfig(cfg, overrides) {
    const ov = overrides ?? {};
    const mark = (key) => Object.prototype.hasOwnProperty.call(ov, key) ? " (override)" : "";
    const kw = (cfg.groupKeywords || []).join(", ") || "(空)";
    return [
        "⚙️ 飞书运行时配置（白名单）",
        "",
        `groupPolicy: ${cfg.groupPolicy}${mark("groupPolicy")}`,
        `groupKeywords: ${kw}${mark("groupKeywords")}`,
        `groupAlsoOnReply: ${Boolean(cfg.groupAlsoOnReply)}${mark("groupAlsoOnReply")}`,
        `ignoreBotMessages: ${cfg.ignoreBotMessages !== false}${mark("ignoreBotMessages")}`,
        `reactEmoji: ${cfg.reactEmoji || ""}${mark("reactEmoji")}`,
        `language: ${cfg.language || "zh"}${mark("language")}`,
        `streamingReply: ${cfg.streamingReply !== false}${mark("streamingReply")}`,
        `streamPrintFrequencyMs: ${cfg.streamPrintFrequencyMs ?? ""}${mark("streamPrintFrequencyMs")}`,
        `streamPrintStep: ${cfg.streamPrintStep ?? ""}${mark("streamPrintStep")}`,
        `streamPushIntervalMs: ${cfg.streamPushIntervalMs ?? ""}${mark("streamPushIntervalMs")}`,
        "",
        "修改: /config <key> <value>",
        "清除: /config clear <key|all>",
        `可改项: ${RUNTIME_CONFIG_KEYS.join(", ")}`,
    ].join("\n");
}
