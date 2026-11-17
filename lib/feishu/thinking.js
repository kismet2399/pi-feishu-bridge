/**
 * 只做结构清理：保留 Runtime 返回的每个非空字符串，不维护任何固定档位名单。
 * 这样模型或 Runtime 新增档位时，飞书无需同步发布也不会漏掉它。
 */
export function normalizeThinkingLevels(value) {
    if (!Array.isArray(value))
        return [];
    const seen = new Set();
    const levels = [];
    for (const item of value) {
        if (typeof item !== "string" || !item.trim() || seen.has(item))
            continue;
        seen.add(item);
        levels.push(item);
    }
    return levels;
}
