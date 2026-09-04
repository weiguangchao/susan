# Session 持久化：OpenCode / Codex / Pi 实现对比

## 范围

本文回答 [决策：Session 持久化设计](https://github.com/weiguangchao/susan/issues/6) 的前置调研问题：OpenCode、Codex、Pi 当前如何持久化 Session，尤其是存储位置、文件格式、写入时机、Session 标识 / 命名、恢复入口、新开 Session 与删除语义。

调研只使用官方仓库源码与仓库内文档，不使用二手文章。固定提交如下（均为 2026-09-02 快照）：

- OpenCode：[`anomalyco/opencode@8e0f1c253b6b7292b419505af849d06747c0e049`](https://github.com/anomalyco/opencode/tree/8e0f1c253b6b7292b419505af849d06747c0e049)
- Codex：[`openai/codex@ddf8a67ab09cd76b8adc0969f11ee1271179aba7`](https://github.com/openai/codex/tree/ddf8a67ab09cd76b8adc0969f11ee1271179aba7)
- Pi：[`earendil-works/pi@b8b873b9872db04a938fb4357b5e8e824ddc051c`](https://github.com/earendil-works/pi/tree/b8b873b9872db04a938fb4357b5e8e824ddc051c)

## 结论速览

| 维度 | OpenCode | Codex | Pi |
| --- | --- | --- | --- |
| 存储形态 | 单个全局 SQLite DB（WAL） | 每个 Session 一个 JSONL rollout | 每个 Session 一个 JSONL 文件；新版 harness 设计同时规划 Memory / JSONL / SQLite backend |
| 默认位置 | XDG data 目录下的 `opencode.db`（channel 可能带后缀） | `~/.codex/sessions/YYYY/MM/DD/` | `~/.pi/agent/sessions/--<encoded-cwd>--/` |
| 写入时机 | durable event 与 projection 在同一 SQLite transaction 内提交 | 后台 writer 队列；`persist` / `flush` / `shutdown` 落盘并重试 | 每个稳定 entry 追加；但首个 assistant message 到达前不实际创建文件 |
| 记录单位 | event log + session / message 投影表 | SessionMeta、ResponseItem、EventMsg、Compacted、TokenUsage 等 rollout item | header + 带 `id` / `parentId` 的树形 entry |
| Session ID | `ses_` + 时间可排序随机 ID | UUID thread ID / rollout ID | UUIDv7 |
| 命名 | 初始时间标题，后续 LLM 生成 ≤50 chars 标题；TUI 可 rename | UUID 为主；支持显式 session name 与自动 title / preview | UUIDv7；支持 `/name`，否则用首条消息 |
| 恢复入口 | TUI `/sessions` / `/resume` / `/continue`，搜索、pin、rename、delete | `codex resume` picker、`codex resume <id|name>`、`--last`、`--all`；TUI `/resume` | `pi -c` 最近、`pi -r` picker、`pi --session <path|id>`；TUI `/resume` |
| 新开 Session | `/new` 与 `/clear` 都进入新 Session | `/new` 新开；`/clear` 清 UI 并新开，旧 Session 保持可恢复 | `/new` 调用 runtime 的 new session |
| 删除 | TUI session list 中两次确认删除 | `codex delete` / `archive` 子命令 | picker 中 Ctrl+D 确认，优先用 `trash`；也可删文件 |
| 独立 TUI transcript | 未见独立 transcript 文件；UI 从 session 数据渲染 | rollout 中保存可回放 item；未见单独 transcript 文件 | session entry 即渲染与上下文来源；未见单独 transcript 文件 |

## OpenCode

### 存储位置与格式

OpenCode 使用单个全局 SQLite 数据库。全局路径来自 XDG data 目录：`xdgData/opencode`；默认数据库是 `opencode.db`，非默认 installation channel 可能使用带 channel 后缀的文件名。来源：[`global.ts#L12-L21`](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/core/src/global.ts#L12-L21)、[`database.ts#L35-L55`](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/core/src/database/database.ts#L35-L55)。

数据库打开时设置 `journal_mode = WAL`、`synchronous = NORMAL`、`busy_timeout = 5000`、`foreign_keys = ON`，再执行 migration。来源：[`database.ts#L19-L34`](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/core/src/database/database.ts#L19-L34)。

Session 不是每个文件一个，而是数据库中的表：`session` 表保存 ID、project、workspace、parent、slug、title、version、model、token / cost、时间戳等；`session_message` 表按 `(session_id, seq)` 唯一索引保存消息投影。来源：[`session/sql.ts#L15-L70`](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/core/src/session/sql.ts#L15-L70)、[`session/sql.ts#L133-L159`](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/core/src/session/sql.ts#L133-L159)。

### 写入时机与事件模型

OpenCode 的核心不是直接“写 chat log”，而是 durable event + projector。每个 durable event 在一个 SQLite immediate transaction 中：分配 aggregate seq、执行 projector、更新 event sequence、插入 event row。来源：[`event.ts#L205-L355`](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/core/src/event.ts#L205-L355)。

`event` 表保存 `aggregate_id`、`seq`、`type`、`data`，并有 `(aggregate_id, seq)` 唯一索引。来源：[`event/sql.ts#L5-L25`](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/core/src/event/sql.ts#L5-L25)。

Session 创建时生成 `SessionSchema.ID`、随机 slug、初始标题 `New session - <ISO time>`、project / workspace / model / token 统计等字段，并通过 `SessionV1.Event.Created` 进入事件流。来源：[`session.ts#L208-L253`](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/core/src/session.ts#L208-L253)。

### 标识与命名

Session ID 是 `ses_` 前缀的 26 字符随机 ID。生成方式把时间戳、counter 与随机 bytes 编在一起，并使用 descending 形式让新 ID 在字典序上更靠前。来源：[`session-id.ts#L1-L15`](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/schema/src/session-id.ts#L1-L15)、[`identifier.ts#L1-L31`](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/schema/src/identifier.ts#L1-L31)。

标题初始为 `New session - <ISO time>`；内置 `title` agent 使用首条用户消息生成不超过 50 chars、同语言、便于检索的标题。来源：[`agent.ts#L40-L67`](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/core/src/plugin/agent.ts#L40-L67)。

### 恢复、新开与删除

TUI 有 session list picker：支持搜索、按更新时间排序、pin、rename、delete（delete 需第二次确认）。来源：[`dialog-session-list.tsx#L45-L95`](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/tui/src/component/dialog-session-list.tsx#L45-L95)、[`dialog-session-list.tsx#L240-L350`](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/tui/src/component/dialog-session-list.tsx#L240-L350)。

命令入口注册为 `session.list`，slash 名 `/sessions`，别名 `/resume`、`/continue`。来源：[`app.tsx#L570-L581`](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/tui/src/app.tsx#L570-L581)。

`/new` 与 `/clear` 是同一个 `session.new` 命令的 slash 名和别名，执行时离开当前 session route 回到 home，等价于开启新 Session。来源：[`app.tsx#L582-L593`](https://github.com/anomalyco/opencode/blob/8e0f1c253b6b7292b419505af849d06747c0e049/packages/tui/src/app.tsx#L582-L593)。

## Codex

### 存储位置与文件名

Codex 的配置根目录默认是 `~/.codex`，可用 `CODEX_HOME` 覆盖；`CODEX_HOME` 必须是已存在的目录。来源：[`home-dir/src/lib.rs#L7-L53`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/utils/home-dir/src/lib.rs#L7-L53)。

Session rollout 是 JSONL。普通文件名为 `rollout-<timestamp>-<thread_id>.jsonl`；revert 会保持 thread ID 稳定，但追加不同的 rollout ID。来源：[`rollout_file_name.rs#L5-L60`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/rollout/src/rollout_file_name.rs#L5-L60)。

实际路径按本地日期分区：`~/.codex/sessions/YYYY/MM/DD/`。来源：[`recorder.rs#L1633-L1659`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/rollout/src/recorder.rs#L1633-L1659)。

### 写入时机与记录单位

Rollout recorder 是后台 writer：`record_canonical_items()` 先入队；`persist()`、`flush()`、`shutdown()` 才等待写入完成。I/O 失败会保留未写后缀，重新打开文件并重试。来源：[`recorder.rs#L970-L1018`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/rollout/src/recorder.rs#L970-L1018)、[`recorder.rs#L1670-L1842`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/rollout/src/recorder.rs#L1670-L1842)。

每条 JSONL line 包含 timestamp、可选 ordinal，以及 flattened rollout item。写入时序列化为 JSON、追加换行、`write_all` 后 `flush`。来源：[`recorder.rs#L1961-L2005`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/rollout/src/recorder.rs#L1961-L2005)。

持久化 item 不只有消息，还包括 `SessionMeta`、`ResponseItem`、inter-agent communication、`Compacted`、`TurnContext`、`TokenUsageRecord`、`EventMsg`、`RealtimeItem` 等。来源：[`history/src/lib.rs#L101-L117`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/history/src/lib.rs#L101-L117)。

### 标识与命名

Thread / rollout ID 是 UUID。CLI resume 支持 session ID 或 session name，UUID 优先。来源：[`cli/src/main.rs#L342-L365`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/cli/src/main.rs#L342-L365)。

显式名称保存在 `~/.codex/session_index.jsonl`，每行 `{id, thread_name, updated_at}`，append-only，解析时最新 entry 生效。来源：[`session_index.rs#L20-L67`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/rollout/src/session_index.rs#L20-L67)。

SQLite thread metadata 还保存 best-effort title、显式 name、preview、first user message。来源：[`thread_metadata.rs#L130-L175`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/state/src/model/thread_metadata.rs#L130-L175)。

### 恢复、新开与删除

`codex resume` 的行为是：不带 ID 时默认打开 picker；`--last` 直接恢复最近；`--all` 关闭 cwd 过滤；`--include-non-interactive` 包含非交互 session。来源：[`cli/src/main.rs#L342-L365`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/cli/src/main.rs#L342-L365)。

CLI 将这些参数转成 `resume_picker`、`resume_last`、`resume_session_id` 等 TUI 状态。来源：[`cli/src/main.rs#L2722-L2751`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/cli/src/main.rs#L2722-L2751)。

TUI `/resume` 打开 picker；`/clear` 的说明是“clear the terminal and start a new chat”，事件定义为清空 screen / scrollback、开启 fresh session，并保持旧 chat 可恢复。来源：[`slash_command.rs#L95-L103`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/tui/src/slash_command.rs#L95-L103)、[`app_event.rs#L400-L424`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/tui/src/app_event.rs#L400-L424)。

CLI 另有 `archive` 与 `delete` 子命令，用于归档或永久删除 saved session。来源：[`cli/src/main.rs#L194-L204`](https://github.com/openai/codex/blob/ddf8a67ab09cd76b8adc0969f11ee1271179aba7/codex-rs/cli/src/main.rs#L194-L204)。

## Pi

### 当前 coding-agent 格式

Pi 当前把 Session 保存为 JSONL 文件，路径为 `~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl`，其中 `<path>` 是编码后的工作目录。官方文档明确该格式是树形结构，每行一个 JSON object，entry 通过 `id` / `parentId` 连接。来源：[`session-format.md#L1-L28`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/docs/session-format.md#L1-L28)。

`getAgentDir()` 默认是 `~/.pi/agent`，可用环境变量覆盖；`getSessionsDir()` 是其下的 `sessions`。来源：[`config.ts#L527-L571`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/config.ts#L527-L571)。

Session ID 使用 UUIDv7；entry ID 使用 8 位随机 hex，冲突时重试。来源：[`session-manager.ts#L208-L229`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/session-manager.ts#L208-L229)。

默认 session 目录按 cwd 编码：把绝对路径转换成 `--<safe-path>--` 后放在 `~/.pi/agent/sessions/` 下。来源：[`session-manager.ts#L476-L491`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/session-manager.ts#L476-L491)。

### 写入时机

`newSession()` 只在内存中生成 header 并计算目标文件名，不立即写文件。`_persist()` 在还没有 assistant message 时不落盘；第一个 assistant message 到达后才以 `wx` 创建文件并写入全部已积累 entry，之后每个 entry 用 `appendFileSync` 追加。来源：[`session-manager.ts#L931-L948`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/session-manager.ts#L931-L948)、[`session-manager.ts#L1012-L1045`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/session-manager.ts#L1012-L1045)。

因此 Pi 的当前行为会避免产生“只有用户输入、没有模型响应”的空 session 文件，但代价是首个 assistant response 前 crash 会丢失尚未落盘的用户消息。

读取时逐行解析，跳过 malformed line；如果文件尾部缺换行，会补一个换行。来源：[`session-manager.ts#L503-L562`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/session-manager.ts#L503-L562)。

### 记录单位

Entry 类型包括 message、thinking level change、model change、compaction、branch summary、custom、label、session info、custom message。message entry 保存完整 `AgentMessage`。来源：[`session-manager.ts#L36-L185`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/session-manager.ts#L36-L185)。

这使 Pi 能在同一文件内保留树形分支、当前 leaf、compaction checkpoint、模型切换和用户命名，而不仅是一个线性 `messages` 数组。

### 恢复、新开与删除

官方 CLI / TUI 提供多入口：

- `pi -c`：继续最近 session；
- `pi -r`：打开过去 session picker；
- `pi --session <path|id>`：使用指定 session；
- `pi --no-session`：ephemeral；
- `pi --name`：启动时设置显示名；
- `/resume`：TUI 内 picker；
- `/new`：新 session；
- `/name`：设置当前显示名；
- `/session`：查看当前 session 信息。

来源：[`sessions.md#L3-L34`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/docs/sessions.md#L3-L34)。

Picker 支持搜索、切换路径显示、切换排序、过滤命名 session、rename、delete；可用时优先使用 `trash` CLI，避免永久删除。来源：[`sessions.md#L39-L52`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/docs/sessions.md#L39-L52)。

`/new` 调用 `handleClearCommand()`，后者通过 runtime host 创建新 session。来源：[`interactive-mode.ts#L3072-L3082`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L3072-L3082)、[`interactive-mode.ts#L6384-L6398`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L6384-L6398)。

### 新版 harness 方向

同一 Pi 仓库中的新版 harness 设计文档规划了 Memory、JSONL、SQLite 三种 backend，并要求通过同一 conformance suite；JSONL header 或 SQLite catalog 都保存 `storageVersion`。来源：[`harness.md#L468-L500`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/agent/docs/harness.md#L468-L500)。

该设计仍坚持“一个文件一个 session”作为 JSONL / SQLite 的组织方式，并把 corruption、删除和单 writer 隔离在一个 session 内。来源：[`harness.md#L515-L546`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/agent/docs/harness.md#L515-L546)、[`harness.md#L823-L870`](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/agent/docs/harness.md#L823-L870)。

这尚未等同当前 coding-agent v3 默认行为，但对 Susan 有参考价值：格式版本、事件 / entry replay、崩溃边界和迁移策略应从第一天进入 schema 设计。

## 主流共识与分歧

### 共识

1. **都不是退出时一次性保存。** OpenCode 用 SQLite transaction 保存 durable event；Codex 用后台 JSONL writer 和显式 barrier；Pi 在稳定 entry 上 append（虽然首个 assistant 前延迟建文件）。
2. **持久化单位大于 provider messages。** 三者都保存 session metadata、模型 / 上下文 / compaction 或展示回放信息。仅保存 provider wire response 不足以恢复 TUI 和上下文。
3. **都有稳定 Session ID。** OpenCode 用时间可排序 `ses_` ID；Codex 用 UUID；Pi 用 UUIDv7。
4. **都支持从历史 Session 恢复，且普遍提供 picker 与直接 ID 两条路径。**
5. **`/new` / `/clear` 的主流语义是新开 Session，旧 Session 保留可恢复，不是删除当前历史。**
6. **未见单独的 TUI transcript 文件。** UI 展示从 session 记录或可回放事件推导。

### 分歧

1. **单库 vs 单文件。** OpenCode 用一个全局 SQLite DB；Codex 与 Pi 都是每个 Session 一个 JSONL 文件。SQLite 更适合复杂查询与并发，JSONL 更简单、可 `jq`、单 session 损坏隔离更好。
2. **目录组织。** Codex 按日期分区；Pi 按 cwd 分区；OpenCode 靠 DB 表中的 project / workspace 字段组织。
3. **首个 assistant 前是否落盘。** Pi 延迟；OpenCode / Codex 的模型更接近稳定事件即时持久化。若 Susan 重视“用户输入 crash 后可恢复”，应避免 Pi 的这个延迟。
4. **是否保存树形分支。** Pi 当前 v3 将树和 leaf 存在同一个文件；Codex 通过 fork / revert 产生新 rollout；OpenCode 有 parent 字段与更复杂的 session / workspace 模型。Susan v1 如果没有分支需求，不需要引入树。
5. **显式命名。** Pi 与 Codex 都支持用户命名；OpenCode 主要靠 LLM 自动标题。Susan v1 可以先用首条用户消息作为标题，之后再加命名。

## 对 Susan 的启示

1. **单 Session 单 JSONL 最贴合 v1。** Codex / Pi 都证明该形态足够支撑恢复；它比全局 SQLite 简单，且损坏与删除边界清晰。OpenCode 的全局 SQLite 是为复杂 server / 多前端 / 事件投影服务的，超出 Susan v1。
2. **路径可以比两者更简单：`~/.susan/sessions/<sessionId>.jsonl`。** 日期分区对个人使用收益有限；按 cwd 分区会引入“从其他目录恢复”的复杂度。列表排序可依赖 metadata / mtime。
3. **格式应有 header 与版本号。** 只写 `messages` 数组会让 title、cwd、model、schema version、后续 compaction 记录无处安放。建议首行是 `{type:"session", version:1, id, createdAt, cwd, title}`，后续是 append-only records。
4. **落盘对象仍可以是内部 Completion `messages`，但 record 需要包装。** 例如 `{type:"message", message}` 或 `{type:"session.updated", ...}`。这与 #7 的决定不冲突：Session 保存的 message payload 是内部 Completion 形态，持久化容器仍是事件 / entry。
5. **写入时机应在稳定边界立即 append。** 用户消息、最终 assistant message、tool call、tool result、session metadata 更新都应各自成为稳定 record；不要保存 streaming delta，也不要等退出。
6. **crash 策略要明确。** 最简单是：读取时逐行 JSON parse，最后一行不完整则丢弃；后续 append 前先确保文件以换行结尾。Pi 新版设计明确“torn final line discarded whole”；Codex / Pi 当前代码都有 newline 修复逻辑。
7. **恢复入口建议至少提供 picker + ID。** 主流工具都提供 picker；若坚持极简，可先做 `susan --resume` picker 与 `susan --resume <id>`，暂缓 `/resume`。
8. **`/clear` 应新开 Session，旧 Session 不删除。** 这是 OpenCode 与 Codex 的一致语义，Pi `/new` 也等价。
9. **不需要单独 TUI transcript。** 主流实现均从持久化 session / rollout 记录渲染；Susan 的 TUI 只应消费同一份 Session 数据。
