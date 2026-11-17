import { debugLog } from "./debug.ts";

export type RetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  label?: string;
  /** [patch:delivery-idempotent] 请求可能已被服务端处理时是否仍重试（默认 true）。发消息类调用传 false 防重复投递。 */
  retryAmbiguous?: boolean;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    const msg = String(error || "").toLowerCase();
    return msg.includes("timeout") || msg.includes("econnreset") || msg.includes("socket");
  }
  const err = error as {
    code?: number | string;
    status?: number;
    message?: string;
    response?: { status?: number; data?: { code?: number; msg?: string } };
    cause?: unknown;
  };
  const status = err.status ?? err.response?.status;
  if (typeof status === "number" && (status === 429 || status >= 500)) return true;

  const code = err.code ?? err.response?.data?.code;
  if (code === 11310 || code === 99991400 || code === 99991429) return true;
  if (typeof code === "string") {
    const c = code.toUpperCase();
    if (["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "ENOTFOUND", "EPIPE"].includes(c)) return true;
  }

  const msg = `${err.message || ""} ${err.response?.data?.msg || ""}`.toLowerCase();
  if (msg.includes("timeout") || msg.includes("rate") || msg.includes("temporarily") || msg.includes("try again")) {
    return true;
  }
  if (err.cause && err.cause !== error) return isRetriableError(err.cause);
  return false;
}

/**
 * [patch:delivery-idempotent] 请求「可能已被服务端处理」的错误（超时 / 连接被掐断，响应没回来）。
 * 这类错误重发有重复副作用；429 与 5xx 属于明确未写入 / 限流，重发是安全的。
 */
function isAmbiguousError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    const msg = String(error || "").toLowerCase();
    return msg.includes("timeout") || msg.includes("socket");
  }
  const err = error as {
    code?: number | string;
    status?: number;
    message?: string;
    cause?: unknown;
  };
  if (typeof err.status === "number" && (err.status === 429 || err.status >= 500)) return false;
  const code = typeof err.code === "string" ? err.code.toUpperCase() : "";
  if (["ETIMEDOUT", "ECONNRESET", "EPIPE", "EAI_AGAIN"].includes(code)) return true;
  const msg = String(err.message || "").toLowerCase();
  if (msg.includes("timeout") || msg.includes("socket hang up") || msg.includes("econnreset")) return true;
  if (err.cause && err.cause !== error) return isAmbiguousError(err.cause);
  return false;
}

/** 带指数退避的重试；不可重试错误立即抛出 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = Math.max(0, options.maxRetries ?? 2);
  const baseDelayMs = options.baseDelayMs ?? 300;
  const label = options.label || "feishu.retry";
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retriable = isRetriableError(error);
      if (!retriable || attempt >= maxRetries) throw error;
      // 发消息类调用：请求可能已送达，重发会造出重复消息 → 直接抛出，交给调用方
      if (options.retryAmbiguous === false && isAmbiguousError(error)) {
        debugLog(label + ".ambiguous_no_retry", {
          attempt: attempt + 1,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      const delay = baseDelayMs * Math.pow(2, attempt);
      debugLog(label, {
        attempt: attempt + 1,
        maxRetries,
        delayMs: delay,
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(delay);
    }
  }
  throw lastError;
}

