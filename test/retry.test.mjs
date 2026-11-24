/**
 * withRetry 的重试语义。
 *
 * 核心保护：飞书 im.message.create/reply 没有幂等键，请求超时后服务端
 * 可能已经写入，再重试就会在群里发第二遍（分片循环里表现为"部分内容重复"）。
 * 因此发消息路径传 retryAmbiguous: false —— 超时类错误直接抛出，
 * 而 429/5xx（明确未写入）仍然重试。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetry } from "../src/feishu/retry.ts";

/** 构造一个同步抛错的函数 */
const failWith = (shape) => () => {
  throw Object.assign(new Error(shape.msg || "boom"), shape);
};

/** 记录实际调用次数（期望最终 reject） */
async function countCalls(fn, options) {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      fn();
    }, { maxRetries: 2, baseDelayMs: 1, ...options }),
  );
  return calls;
}

test("超时类错误 + retryAmbiguous:false → 只调用 1 次（不重发）", async () => {
  const cases = [
    { code: "ETIMEDOUT" },
    { code: "ECONNRESET" },
    { code: "EPIPE" },
    { msg: "timeout of 15000ms exceeded" },
  ];
  for (const shape of cases) {
    assert.equal(await countCalls(failWith(shape), { retryAmbiguous: false }), 1,
      `应不重试: ${JSON.stringify(shape)}`);
  }
});

test("超时类错误 + 不传开关 → 保持老行为，重试 3 次", async () => {
  assert.equal(await countCalls(failWith({ code: "ETIMEDOUT" }), {}), 3);
});

test("429 限流 + retryAmbiguous:false → 仍然重试（服务端明确未写入）", async () => {
  assert.equal(await countCalls(failWith({ status: 429 }), { retryAmbiguous: false }), 3);
});

test("5xx + retryAmbiguous:false → 仍然重试", async () => {
  assert.equal(await countCalls(failWith({ status: 503 }), { retryAmbiguous: false }), 3);
});

test("非重试错误（400）+ retryAmbiguous:false → 只调用 1 次", async () => {
  assert.equal(await countCalls(failWith({ status: 400 }), { retryAmbiguous: false }), 1);
});

test("成功路径 → 只调用 1 次", async () => {
  let calls = 0;
  const value = await withRetry(async () => {
    calls += 1;
    return "ok";
  }, { retryAmbiguous: false });
  assert.equal(value, "ok");
  assert.equal(calls, 1);
});

test("最终成功后不再重试", async () => {
  let calls = 0;
  const value = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error("boom"), { status: 503 });
    return "recovered";
  }, { maxRetries: 3, baseDelayMs: 1, retryAmbiguous: false });
  assert.equal(value, "recovered");
  assert.equal(calls, 3);
});
