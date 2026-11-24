/**
 * 会话 jsonl 分叉合并。
 *
 * 保护点：同一会话文件被飞书 bridge 与 pi-web-ui 两个进程写时会分成两条链，
 * 客户端只渲染 leaf 所在主链 → 群里问过的那几轮整支不可见。
 * mergeBranches 负责把分叉收敛成单链。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeBranches } from "../src/feishu/branch-merge.ts";

const ts = (sec) => `2026-11-17T0${sec}:00:00.000Z`;

/** 写一个会话文件；把 mtime 提前，绕过 mergeBranches 的 QUIET_MS(2s) 保护 */
function writeSession(rows) {
  const dir = mkdtempSync(join(tmpdir(), "pi-feishu-merge-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
  const past = new Date(Date.now() - 60_000);
  utimesSync(file, past, past);
  return file;
}

/** 统计分叉（同一 parentId 下有多个 child）与 leaf */
function analyze(file) {
  const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const children = new Map();
  for (const r of rows) {
    const list = children.get(r.parentId) ?? [];
    list.push(r.id);
    children.set(r.parentId, list);
  }
  const forks = [...children.entries()].filter(([parent, kids]) => parent !== null && kids.length > 1);
  const parents = new Set([...children.keys()].filter((k) => k !== null));
  const leaves = rows.filter((r) => r.id && !parents.has(r.id) && r.type !== "session").map((r) => r.id);
  return { rows, forks, leaves };
}

test("单链会话 → skipped: clean，不做任何写盘", () => {
  const file = writeSession([
    { type: "session", id: "root", parentId: null, timestamp: ts(1) },
    { type: "message", id: "a1", parentId: "root", timestamp: ts(2) },
    { type: "message", id: "a2", parentId: "a1", timestamp: ts(3) },
  ]);
  const before = readFileSync(file, "utf8");
  const result = mergeBranches(file);
  assert.equal(result.merged, false);
  assert.equal(result.skipped, "clean");
  assert.equal(readFileSync(file, "utf8"), before, "无分叉时不应改动文件");
});

test("两叉 → 收敛成单链，且不丢任何行", () => {
  const file = writeSession([
    { type: "session", id: "root", parentId: null, timestamp: ts(1) },
    { type: "message", id: "a1", parentId: "root", timestamp: ts(2) },
    { type: "message", id: "a2", parentId: "a1", timestamp: ts(3) },
    // 分叉：与 a1 同为 root 的孩子，时间更晚
    { type: "message", id: "b1", parentId: "root", timestamp: ts(4) },
    { type: "message", id: "b2", parentId: "b1", timestamp: ts(5) },
  ]);

  const before = analyze(file);
  assert.equal(before.forks.length, 1, "构造的样本应恰好有 1 处分叉");

  const result = mergeBranches(file);
  assert.equal(result.merged, true);
  assert.equal(result.rewired, 1);

  const after = analyze(file);
  assert.equal(after.forks.length, 0, "合并后不应再有分叉");
  assert.equal(after.leaves.length, 1, "合并后应只剩一个 leaf");
  assert.equal(after.rows.length, before.rows.length, "合并只改 parentId，不得增删行");
});

test("文件不存在 → skipped: missing", () => {
  const result = mergeBranches(join(tmpdir(), "pi-feishu-not-exist", "nope.jsonl"));
  assert.equal(result.merged, false);
  assert.equal(result.skipped, "missing");
});

test("文件刚被写过（mtime 太新）→ skipped: busy，不动文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-feishu-busy-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, `${JSON.stringify({ type: "session", id: "root", parentId: null, timestamp: ts(1) })}\n`, "utf8");
  const before = readFileSync(file, "utf8");
  const result = mergeBranches(file);
  assert.equal(result.merged, false);
  assert.equal(result.skipped, "busy");
  assert.equal(readFileSync(file, "utf8"), before);
});
