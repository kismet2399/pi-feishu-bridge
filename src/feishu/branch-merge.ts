/**
 * [patch:branch-merge] 会话 jsonl 分叉合并。
 *
 * 背景：同一个会话文件可能被两个进程写（飞书 bridge 的 pi 进程 + pi-web-ui 的常驻会话）。
 * pi 的新消息总是接在「本地内存的 leaf」后面，两边互不知情时同一个 parent 会出现两个孩子，
 * 形成树形分叉。pi-web-ui 只渲染 leaf 所在的那条主链，另一支（往往就是群消息）整支不可见。
 *
 * 这里做的事只有一件：把分叉重挂成单链 —— 每个分叉点的子链按「子树最早 timestamp」排序，
 * 前一条链里时间最晚的节点挂到后一条链的根上。
 *
 * 实现约束（都很重要）：
 *   1. 只做 `"parentId"` 的**文本替换**，不重新序列化整行、不改内容、不删行 → 回滚容易、diff 最小
 *   2. 替换后**断言**解析出的 parentId 确实变了（防止正则命中行内其它 parentId）
 *   3. 只在文件「已静止 ≥ QUIET_MS」时才动手，压掉与另一侧写入竞争的窗口
 *   4. 读后复查 mtime/size，写前不再复查（rename 是原子的，撞上则下一次群消息再收敛）
 *   5. 全程不抛异常给调用方：失败只记 debugLog，绝不阻断消息处理
 */
import { chmodSync, copyFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { debugLog } from "./debug.ts";

/** 文件需静止多久才允许合并（毫秒）。 */
const QUIET_MS = 2000;
/** 超过这个体积就不合并（避免异常文件拖慢每条群消息）。 */
const MAX_BYTES = 50 * 1024 * 1024;
/** 同目录保留多少个 .bak-branches 备份。 */
const KEEP_BACKUPS = 2;

export type MergeResult = {
  merged: boolean;
  rewired: number;
  /** 未合并原因：clean（无分叉）/ busy（文件刚被写）/ toobig / unparsable */
  skipped?: string;
  backup?: string;
};

type Row = Record<string, any>;

function parseRows(lines: string[]): Row[] | null {
  const rows: Row[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      rows.push(null as unknown as Row);
      continue;
    }
    try {
      rows.push(JSON.parse(line) as Row);
    } catch {
      return null; // 有半行/坏行 → 放弃本轮，绝不落盘
    }
  }
  return rows;
}

function buildIndex(rows: Row[]) {
  const nodes = new Map<string, Row>();
  const children = new Map<string | null, string[]>();
  for (const row of rows) {
    if (!row) continue;
    const id = row.id;
    if (typeof id !== "string") continue;
    nodes.set(id, row);
    const parent = (row.parentId ?? null) as string | null;
    const list = children.get(parent);
    if (list) list.push(id);
    else children.set(parent, [id]);
  }
  return { nodes, children };
}

/** 子树内的所有 id（带 visited 防环：文件若有环也不会死循环）。 */
function subtreeIds(root: string, children: Map<string | null, string[]>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    const kids = children.get(id);
    if (kids) stack.push(...kids);
  }
  return out;
}

/** 计划：返回 { 节点 id → 新 parentId }。一轮即可收敛（已验证），分叉只改子节点的父，不会产生新分叉。 */
function planRewires(rows: Row[]): Record<string, string> {
  const { nodes, children } = buildIndex(rows);
  const forks: Array<[string | null, string[]]> = [];
  for (const [parent, kids] of children) {
    if (parent !== null && kids.length > 1) forks.push([parent, kids]);
  }
  if (!forks.length) return {};

  const ts = (id: string) => String(nodes.get(id)?.timestamp ?? "");
  const firstTs = (id: string) => {
    let min = "";
    for (const x of subtreeIds(id, children)) {
      const t = ts(x);
      if (!min || (t && t < min)) min = t;
    }
    return min;
  };

  const rewires: Record<string, string> = {};
  for (const [, kids] of forks) {
    const ordered = [...kids].sort((a, b) => (firstTs(a) < firstTs(b) ? -1 : firstTs(a) > firstTs(b) ? 1 : 0));
    for (let i = 1; i < ordered.length; i += 1) {
      const prevIds = subtreeIds(ordered[i - 1], children);
      let leaf = prevIds[0];
      for (const x of prevIds) if (ts(x) >= ts(leaf)) leaf = x;
      rewires[ordered[i]] = leaf;
    }
  }
  return rewires;
}

function pruneBackups(filePath: string, keep = KEEP_BACKUPS) {
  try {
    const dir = dirname(filePath);
    const prefix = `${basename(filePath)}.bak-branches-`;
    const backups = readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort()
      .reverse();
    for (const stale of backups.slice(keep)) {
      try {
        unlinkSync(join(dir, stale));
      } catch {}
    }
  } catch {}
}

/**
 * 合并分叉。同步实现（调用点在 async 函数里，读一个 MB 级文件也就几十毫秒）。
 * 任何异常都吞掉并记 debugLog —— 分叉合并失败不能影响群消息投递。
 */
export function mergeBranches(sessionFile: string): MergeResult {
  try {
    if (!sessionFile || !existsSync(sessionFile)) return { merged: false, rewired: 0, skipped: "missing" };

    const before = statSync(sessionFile);
    if (before.size > MAX_BYTES) return { merged: false, rewired: 0, skipped: "toobig" };
    if (Date.now() - before.mtimeMs < QUIET_MS) return { merged: false, rewired: 0, skipped: "busy" };

    const raw = readFileSync(sessionFile, "utf8");
    const lines = raw.split("\n");
    // 末尾换行会split 出一个空串，保留它以便写回时保持原样
    const rows = parseRows(lines);
    if (!rows) return { merged: false, rewired: 0, skipped: "unparsable" };

    const rewires = planRewires(rows);
    const targets = Object.keys(rewires);
    if (!targets.length) return { merged: false, rewired: 0, skipped: "clean" };

    // 读后复查：期间被写过就放弃（下一次群消息再来收敛）
    const recheck = statSync(sessionFile);
    if (recheck.mtimeMs !== before.mtimeMs || recheck.size !== before.size) {
      return { merged: false, rewired: 0, skipped: "busy" };
    }

    const out: string[] = [];
    let touched = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const row = rows[i];
      const line = lines[i];
      if (!row || typeof row.id !== "string" || !(row.id in rewires)) {
        out.push(line);
        continue;
      }
      const newParent = rewires[row.id];
      const next = line.replace(/"parentId"\s*:\s*"[^"]*"/, `"parentId":${JSON.stringify(newParent)}`);
      if (next === line) {
        debugLog("feishu.branch_merge.abort", { sessionFile, reason: "parentId-not-matched", id: row.id });
        return { merged: false, rewired: 0, skipped: "unparsable" };
      }
      let parsed: Row;
      try {
        parsed = JSON.parse(next) as Row;
      } catch {
        debugLog("feishu.branch_merge.abort", { sessionFile, reason: "invalid-json-after-replace", id: row.id });
        return { merged: false, rewired: 0, skipped: "unparsable" };
      }
      // P0：必须确认替换命中的是顶层 parentId
      if (parsed.parentId !== newParent) {
        debugLog("feishu.branch_merge.abort", { sessionFile, reason: "parentId-mismatch", id: row.id });
        return { merged: false, rewired: 0, skipped: "unparsable" };
      }
      out.push(next);
      touched += 1;
    }

    const tmp = `${sessionFile}.merge-tmp`;
    writeFileSync(tmp, out.join("\n"), "utf8");
    // P1-1 沿用原文件权限：会话记录通常是 600，直接 rename 会把它放宽成默认的 644
    try {
      chmodSync(tmp, before.mode);
    } catch {}

    // P1-2 rename 前最后一次复查：写 tmp 的这几十毫秒里若被另一侧写入，宁可放弃也不能覆盖掉
    const finalCheck = statSync(sessionFile);
    if (finalCheck.mtimeMs !== before.mtimeMs || finalCheck.size !== before.size) {
      try {
        unlinkSync(tmp);
      } catch {}
      return { merged: false, rewired: 0, skipped: "busy" };
    }

    // 只在确定要落地时才留备份（省掉被 finalCheck 拒掉那次的 2 MB 垃圾）
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const backup = `${sessionFile}.bak-branches-${stamp}`;
    copyFileSync(sessionFile, backup);

    renameSync(tmp, sessionFile);
    pruneBackups(sessionFile);

    debugLog("feishu.branch_merge.merged", { sessionFile, rewired: touched, backup: basename(backup) });
    return { merged: true, rewired: touched, backup };
  } catch (error) {
    debugLog("feishu.branch_merge.error", {
      sessionFile,
      error: error instanceof Error ? error.message : String(error),
    });
    return { merged: false, rewired: 0, skipped: "error" };
  }
}
