# Changelog

本 fork 基于 `ax-feishu-bridge@0.4.9`（上游 2026-08 后停止更新）。
以下改动在代码中以 `[patch:xxx]` 注释标注，可用同目录的补丁脚本重放。

## [1.0.0] - 2026-11-19

首个 1.0 版本。经过 0.5.0 → 0.5.2 的完善，三条核心链路已稳定：

- **消息投递**：发送超时不重发（`delivery-idempotent`）、崩溃后消息可重新接管（`dedupe-reclaim`）
- **会话一致性**：分叉自动收敛（`branch-merge-retry` / `branch-merge-sweep`）、群↔会话固定绑定（`binds`）
- **消息解析与路由**：引用消息/卡片正文回填、合并转发展开、`/stop` 卡死自救、群聊会话键不再分裂

无功能性代码变更，自 0.5.2 起仅版本号演进。

## [0.5.2] - 2026-11-17

### 文档

- **修正安装命令**：`npm:ax-feishu-bridge` → `npm:@kismet2496/pi-feishu-bridge`；
  Git 安装改为本 fork 仓库 `github.com/kismet2399/pi-feishu-bridge`；
  DSH 安装改为 `dsh plugin --profile web add @kismet2496/pi-feishu-bridge`
- **修正配置文件路径**：`.json` 后缀实为 `.pi.json` / `.harness.json`
  （`config.pi.json`、`state.pi.json`、`bridge.pi.json`、`debug.pi.log` 等）
- **补全「会保存哪些文件」**：新增 `binds.pi.json`（群↔会话绑定）、
  `dedupe.pi.json`（消息去重）、`daemon.log`（后台输出）
- 补回 `docs/images/1.jpeg`（README 里原本是坏链）

## [0.5.1] - 2026-11-17

### 元数据

- 补充 `repository` / `homepage` / `bugs`，指向本 fork 的源码仓库
  <https://github.com/kismet2399/pi-feishu-bridge>
- 便于安装前 review 源码（Pi 官方建议）

## [0.5.0] - 2026-11-17

### 修复：消息投递

- **delivery-idempotent** — 发送消息超时不再重发。飞书 `im.message.create/reply` 无幂等键，
  原实现把 `timeout`/`ETIMEDOUT`/`ECONNRESET` 判为可重试，服务端其实可能已写入 →
  群里出现重复消息（分片循环里每个分片独立重试，表现为部分内容重复）。
  现对 429/5xx（明确未写入）仍重试，超时类直接抛出。
- **dedupe-reclaim** — daemon 在 `processing` 期间崩溃后，该消息原本会在 24h TTL 内被永久丢弃。
  现在持有 pid 已死时允许重新接管（只按 pid 存活判断，不按耗时 —— 一轮 prompt 可能跑几十分钟）。

### 修复：会话一致性

- **branch-merge-retry** — 同一会话 jsonl 被飞书 bridge 与 pi-web-ui 两个进程写时会分成两条链，
  而客户端只渲染 leaf 所在主链 → 群里问过的那几轮整支不可见。现在每条消息落盘后 debounce 合并一次。
- **branch-merge-sweep** — 补上低频兜底：仅 daemon 进程每 90 秒扫一遍已接管会话，mtime 未变则跳过。
- **binds** — 群 ↔ 会话固定绑定，数据源 `~/.pi/agent/feishu/binds.pi.json`，避免与 state 整对象回写互相覆盖。

### 修复：消息解析与路由

- **quoted-post** — 引用消息只认 `zh_cn/en_us` 本地化包装，飞书对 `post` 返回扁平结构 → 引用内容被静默丢弃；
  同时修复引用附件被塞进 `parsed.attachments` 导致斜杠命令被误当 prompt、以及跨消息 file_key 下载返回 400。
- **quoted-card-recall** — 引用机器人卡片时回填正文（原来只能读到占位内容 → 答非所问）。
- **group-session-key** — 群聊会话键不再因「引用回复」分裂。
- **merge-forward-expand** — 合并转发展开子消息与附件（原来只看到 "Merged and Forwarded Message" 占位）。
- **stop-stale-takeover** — `/stop` 的 runId 不匹配时也中止当前任务（原来只回 stale，点停止无效、后续提问永久排队）。
- **shadow-report-visible** — 扩展注入的 `custom_message`（影子哨兵报告）在飞书可见。
  *依赖 `pi-shadow-mind` 的 `customType === "shadow-report"` 约定；未安装时该分支不会触发。*
- **default-workspace** — `defaultWorkspace` 配置未生效（`loadBaseConfig` 未拷出该字段）。

### 其它

- **enable-skills** — daemon 启动参数去掉 `--no-skills`，飞书会话恢复文件系统技能加载。
  *注意：这会改变默认行为，daemon 将加载全部技能。*
- 补齐 `tsconfig.json` / `tsconfig.build.json`（上游未提供，导致 `npm run build` 与 `npm run check` 不可用），重建 `lib/`。
