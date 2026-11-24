/**
 * 消息去重的接管语义。
 *
 * 保护点：daemon 在 processing 期间崩溃后，该 messageId 原本会在 24h TTL 内
 * 被永久丢弃（飞书 WS 重连的重复投递也一并被吃掉）。现在持有 pid 已死时
 * 允许重新接管 —— 只按 pid 存活判断、不按耗时，因为一轮 prompt 可能跑几十分钟，
 * 按时间判死会误杀正常长任务。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { claimFeishuMessage, markFeishuMessage } from "../src/feishu/dedupe-store.ts";

// ─── 隔离守卫 ────────────────────────────────────────────────────────────
// 本测试会写入 ~/.pi/agent/feishu/ 下的真实数据文件。
// 安全性完全依赖 test/register.mjs 把 HOME 重定向到临时目录 ——
// 若有人直接 `node --test test/xxx.test.mjs`（漏了 --import），
// 就会污染线上去重记录与日志。这里做硬性拦截。
{
  const { homedir, tmpdir } = await import("node:os");
  const { realpathSync } = await import("node:fs");
  const home = realpathSync(homedir());
  const sandbox = realpathSync(tmpdir());
  if (!home.startsWith(sandbox)) {
    throw new Error(
      `测试未在沙箱中运行：当前 HOME=${home}\n` +
      `请用 \`npm test\` 运行（会通过 test/register.mjs 把 HOME 指向临时目录），\n` +
      `否则会污染真实的 ~/.pi/agent/feishu/ 数据。`
    );
  }
}
// ────────────────────────────────────────────────────────────────────────


const DEDUPE_PATH = join(homedir(), ".pi", "agent", "feishu", "dedupe.pi.json");

/** 把某条记录的持有 pid 改成一个必然不存在的值，模拟 daemon 崩溃 */
function killRecordPid(messageId, pid = 999999) {
  const store = JSON.parse(readFileSync(DEDUPE_PATH, "utf8"));
  store.messages[messageId].pid = pid;
  writeFileSync(DEDUPE_PATH, JSON.stringify(store));
}

test("首次 claim → true", async () => {
  assert.equal(await claimFeishuMessage("om_test_first"), true);
});

test("同进程重复投递 → false（防重复处理）", async () => {
  const id = "om_test_dup";
  assert.equal(await claimFeishuMessage(id), true);
  assert.equal(await claimFeishuMessage(id), false);
});

test("持有进程已死 → 允许重新接管", async () => {
  const id = "om_test_dead_pid";
  assert.equal(await claimFeishuMessage(id), true);
  killRecordPid(id);
  assert.equal(await claimFeishuMessage(id), true, "崩溃后应可重新接管");
  assert.equal(await claimFeishuMessage(id), false, "接管后同进程再投递仍应拒绝");
});

test("failed 状态不自动重试（避免模型错误反复重跑刷屏）", async () => {
  const id = "om_test_failed";
  await markFeishuMessage(id, "failed", "boom");
  assert.equal(await claimFeishuMessage(id), false);
});

test("replied 状态不重试", async () => {
  const id = "om_test_replied";
  assert.equal(await claimFeishuMessage(id), true);
  await markFeishuMessage(id, "replied");
  assert.equal(await claimFeishuMessage(id), false);
});

test("ignored 状态不重试", async () => {
  const id = "om_test_ignored";
  assert.equal(await claimFeishuMessage(id), true);
  await markFeishuMessage(id, "ignored");
  assert.equal(await claimFeishuMessage(id), false);
});

test("全新消息 → 可 claim", async () => {
  assert.equal(await claimFeishuMessage("om_test_brand_new"), true);
});

test("空 messageId → 放行（调用方未提供时不阻塞处理）", async () => {
  assert.equal(await claimFeishuMessage(""), true);
});
