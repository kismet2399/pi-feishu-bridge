#!/usr/bin/env node
/**
 * 类型检查封装。
 *
 * 宿主模块（`@earendil-works/pi-coding-agent`、`typebox`、`@deepseek-ai/dsh-*`）
 * 由 Pi / DeepSeek Harness 在运行时通过虚拟模块注入，刻意不放进 dependencies
 * （打成实体副本会绕过扩展加载器、产生重复的类与注册表）。
 *
 * 因此 tsc 必然对它们报 TS2307「找不到模块」。这里只忽略这一类错误，
 * 其余任何类型错误都会让命令失败 —— 避免"红灯常亮导致真错误被淹没"。
 */
import { spawnSync } from "node:child_process";

const result = spawnSync("npx", ["tsc", "--noEmit", "-p", "tsconfig.json"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});

const output = `${result.stdout || ""}${result.stderr || ""}`;
const allErrors = output.split("\n").filter((line) => /error TS\d+/.test(line));
const realErrors = allErrors.filter((line) => !/error TS2307/.test(line));
const suppressed = allErrors.length - realErrors.length;

if (realErrors.length > 0) {
  console.error(realErrors.join("\n"));
  console.error(`\n❌ 类型检查失败：${realErrors.length} 个错误（另有 ${suppressed} 条 TS2307 已忽略）`);
  process.exit(1);
}

console.log(`✅ 类型检查通过（忽略 ${suppressed} 条 TS2307：宿主模块由运行时注入）`);
