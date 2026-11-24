/**
 * 测试预加载：把 HOME 指到临时沙箱目录。
 *
 * 被测模块（debug.ts / config.ts / dedupe-store.ts）会把日志和状态写到
 * `~/.pi/agent/feishu/`。若直接用真实 HOME，跑一次测试就会污染线上
 * debug.pi.log 与 dedupe.pi.json。这里在测试文件加载前重定向 HOME，
 * os.homedir() 随之指向沙箱。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "pi-feishu-test-"));
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox; // Windows
