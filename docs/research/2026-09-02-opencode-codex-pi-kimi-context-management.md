# 主流 CLI agent 的上下文压缩与截断策略：OpenCode / Codex / Pi / Kimi Code

## 范围与证据

本文回答 [调研：主流 CLI agent 的上下文压缩与截断策略](https://github.com/weiguangchao/susan/issues/20)：四个 CLI agent 如何判断上下文接近或超过上限、如何压缩或截断历史、如何保持 Tool call / Tool result 结构、如何影响 Session 持久化，以及如何向用户呈现压缩事件。

只使用官方仓库源码和仓库内官方文档，不使用二手文章。固定快照如下（均于 2026-09-02 检出）：

- OpenCode：[`anomalyco/opencode@69c172e8a7c0086887b1f93ed5a162f14b6aa0c5`](https://github.com/anomalyco/opencode/tree/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5)
- Codex：[`openai/codex@eb10d91e48ccbd0930427461fb392337addb1ac0`](https://github.com/openai/codex/tree/eb10d91e48ccbd0930427461fb392337addb1ac0)
- Pi：[`badlogic/pi-mono@b8b873b9872db04a938fb4357b5e8e824ddc051c`](https://github.com/badlogic/pi-mono/tree/b8b873b9872db04a938fb4357b5e8e824ddc051c)
- Kimi Code CLI：[`MoonshotAI/kimi-cli@86f136422a0aae6b217ea49e7ea1d2e8a1defcd2`](https://github.com/MoonshotAI/kimi-cli/tree/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2)（仓库版本 `1.50.0`）

除明确标为“推断”的段落外，下文均为上述快照可直接验证的行为。四个项目都在快速演进；尤其 Codex 同时存在 local、remote、remote v2 与实验性 token-budget compaction 路径，本文以公开源码中的默认能力路由为准，不推断服务端未公开算法。

## 结论速览

| 维度 | OpenCode | Codex | Pi | Kimi Code |
| --- | --- | --- | --- | --- |
| 自动触发 | 上次 assistant 的 provider usage 达到可用预算；也识别 provider overflow | pre-turn / mid-turn 检查活动上下文 usage 是否达到 auto-compact 或有效 context-window 上限 | provider usage + 尾部消息估算；`context > window - reserve`；也识别 overflow / 提前结束 | provider usage + 待发送文本估算；达到 ratio 或保留输出空间任一阈值 |
| 默认余量 | 输出上限，最多按 20k buffer；可配 `reserved` | model 元数据的 auto-compact limit；硬上限默认按 context window 的 95% 计算 | `reserveTokens=16384` | `reserved_context_size=50000`，同时 `trigger_ratio=0.85` |
| 压缩结果 | rolling summary + 最近约 25%（2k–15k）verbatim tail | local：最近 user 文本（最多 20k）+ summary；remote：provider 返回 replacement history | rolling structured summary + 最近 20k tail；超大单回合可切在 assistant 边界 | summary + 最近两个 user/assistant role 消息及其后全部消息 |
| Tool 配对 | Tool call/result 同在 assistant part；tail 可从 assistant message 开始，不拆 part | remote 预处理只改 output payload、保留 call id；local replacement 不保留旧 tool pair，只保留其 summary | 明确禁止在 `toolResult` 处切；可从含 tool call 的 assistant 开始，后续 result 同留 | tail 起点只可能是 user/assistant；从 assistant tool-call 起保留后续 tool result |
| 原历史持久化 | 完整 DB 历史保留；活动投影从 checkpoint + tail 重建 | append-only rollout 保留旧 item，并追加带 replacement history 的 `CompactedItem` | JSONL 追加 `CompactionEntry`，旧 entry 保留 | 当前 context 文件轮转留档，随后重写为 system prompt + summary + tail |
| overflow 恢复 | compact 后重放导致 overflow 的 user turn；compaction 本身仍 overflow 则终止 | 普通 sampling overflow 在该请求内不 compact-and-retry；下次 pre-turn 会看到“已满”；local compaction 请求过大时逐个删最旧 item 重试 | 删除失败/length assistant 的活动副本，compact 后只重试一次；持久记录仍保留失败响应 | context overflow 400 不在重试表内，也没有错误后自动 compact-and-retry |
| 用户提示 | transcript 中显示 `Compaction` 分隔线 | `ContextCompaction` lifecycle / “Compacted context”，local 路径另发长线程准确性 warning | compaction 状态、可展开 summary、压缩前 token 数、失败原因 | `Compacting...` spinner；状态栏持续显示 context token / 百分比 |
| 主要可配置项 | auto、prune、tail turns、tail token、reserved、prompt/plugin | context window、auto-compact token limit/scope、compact prompt、hooks/feature route | enabled、reserve、keep-recent；extension 可取消或替换结果 | ratio、reserved、retry；manual prompt；tail 数量当前硬编码为 2 |

共同点不是“从前面静默删除消息”，而是：**在模型请求之外保留可恢复的 Session 轨迹，用一个显式 compaction checkpoint 改写后续模型所见上下文**。四者还都把 producer/tool-output 限制与 conversation compaction 当作不同层次的问题。

## OpenCode

### 触发与预算

OpenCode 的活动实现根据最近一次完成的 assistant usage 判断是否需要自动压缩。token 数优先取 provider 的 `total`，否则相加 input、output、cache read/write；当其达到 `usable()` 即触发。若配置 `compaction.auto=false` 或模型没有 context limit，则不自动触发。[`overflow.ts#L8-L34`](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/session/overflow.ts#L8-L34) [`prompt.ts#L1161-L1167`](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/session/prompt.ts#L1161-L1167)

`usable()` 的规则是：若模型另有 input limit，使用 `input - reserved`；否则使用 `context - maxOutputTokens`。默认 `reserved` 是模型输出上限与 20,000 的较小值；但在没有独立 input limit 的分支，直接扣完整的 max output。这个判断不是“发送前精确 tokenize 完整请求”，而是依赖上一响应的真实 usage。[`overflow.ts#L8-L20`](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/session/overflow.ts#L8-L20)

provider 明确返回 context overflow 时，processor 也会转入 compaction；若关闭 auto，则把 overflow 作为终止错误。普通 transient error 使用另一套 retry policy，不与 overflow recovery 混为一谈。[`processor.ts#L613-L639`](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/session/processor.ts#L613-L639) [`processor.ts#L641-L695`](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/session/processor.ts#L641-L695)

### 压缩与保留算法

OpenCode 不是只生成一个 summary。它先按 user message 划分 turn，再从新到旧选取 verbatim tail。默认 tail token budget 是可用上下文的 25%，下限 2,000、上限 15,000；也可用 `preserve_recent_tokens` 覆盖，并可用 `tail_turns` 限制最多保留多少个最近 turn。[`compaction.ts#L105-L126`](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/session/compaction.ts#L105-L126) [`compaction.ts#L223-L268`](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/session/compaction.ts#L223-L268)

若一个 turn 超过 tail budget，它可以从该 turn 内后续的完整 message 开始保留，而不是硬截字符串；估算方式是先转换成 provider messages，再对 JSON 做近似 token estimate。[`compaction.ts#L128-L162`](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/session/compaction.ts#L128-L162) [`compaction.ts#L215-L220`](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/session/compaction.ts#L215-L220)

被压缩的 head 会序列化成带 `[User]`、`[Assistant]`、`[Assistant reasoning]`、`[Assistant tool call]`、`[Tool result]` 标签的文本，再交给 compaction agent 生成结构化 rolling summary；已有 summary 会作为 previous summary 更新。为控制 summarization request，单个旧 tool output 在此序列化中最多 2,000 字符。[`compaction.ts#L42-L87`](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/session/compaction.ts#L42-L87) [`compaction.ts#L358-L447`](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/session/compaction.ts#L358-L447)

Tool call 与 result 在 OpenCode 的内部模型里属于同一 assistant message 的 tool part/state；即使 tail 从 assistant message 开始，也不会把一个 part 从中间切开。压缩完成后，活动顺序被重建为 compaction user marker、summary assistant、retained tail、后续消息。[`message-v2.ts#L521-L571`](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/session/message-v2.ts#L521-L571)

### overflow recovery、持久化与提示

当 provider overflow 发生在待处理 user turn 上，OpenCode 从 compaction 输入中移出该 turn，先压缩更早历史，随后新建一个 user message 重放该 turn；media attachment 会降级成文本占位。若 compaction request 自己仍 overflow，则记录明确的 `ContextOverflowError` 并停止。[`compaction.ts#L319-L356`](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/session/compaction.ts#L319-L356) [`compaction.ts#L450-L495`](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/session/compaction.ts#L450-L495)

压缩记录和 summary 是新 message/part；旧消息没有被从数据库删除。后续仅通过 `filterCompacted()` 选择 checkpoint、summary 和 tail 给模型，因此“完整审计历史”和“活动模型历史”是分开的。[`compaction.ts#L559-L581`](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/session/compaction.ts#L559-L581) [`message-v2.ts#L521-L571`](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/session/message-v2.ts#L521-L571)

TUI 在 transcript 中为 compaction part 显示一个标题为 `Compaction` 的分隔线；完成时还有 `session.compacted` event。[`routes/session/index.tsx#L1392-L1464`](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/tui/src/routes/session/index.tsx#L1392-L1464) [`session-compaction-event.ts#L6-L11`](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/schema/src/session-compaction-event.ts#L6-L11)

可配置项包括 `auto`、旧 tool-output `prune`、`tail_turns`、`preserve_recent_tokens`、`reserved`；plugin 还可替换 compaction prompt、注入额外 context 或控制自动继续。[`config.ts#L149-L168`](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/core/src/v1/config/config.ts#L149-L168) [`compaction.ts#L372-L391`](https://github.com/anomalyco/opencode/blob/69c172e8a7c0086887b1f93ed5a162f14b6aa0c5/packages/opencode/src/session/compaction.ts#L372-L391)

## Codex

### 触发与预算

Codex 的活动上下文 token 状态优先使用 Session 已记录的 server usage。auto-compact threshold 可作用于完整活动上下文，或仅作用于当前 compaction window 的 initial prefix 之后；硬 context 上限独立存在。有效硬上限是 model context window 乘 `effective_context_window_percent`，fallback model 默认值为 95%。[`context_window.rs#L52-L109`](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/session/context_window.rs#L52-L109) [`model_info.rs#L168-L178`](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/models-manager/src/model_info.rs#L168-L178)

每个新 turn 在 sampling 前检查一次；多步 agent turn 在一次 sampling / tools 完成后、确实还需要 follow-up 时再次检查，因此既支持 pre-turn 也支持 mid-turn compaction。[`turn.rs#L1052-L1081`](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/session/turn.rs#L1052-L1081) [`turn.rs#L422-L509`](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/session/turn.rs#L422-L509)

用户可覆盖 `model_context_window`、`model_auto_compact_token_limit` 和 limit scope；模型自身也可下发 auto-compact limit。`compact_prompt` 可定制 local summary prompt。[`config/mod.rs#L625-L634`](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/config/mod.rs#L625-L634) [`tasks/compact.rs#L66-L76`](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/tasks/compact.rs#L66-L76)

### local 与 remote compaction

Codex 按 provider capability 选择 remote v2、remote `/responses/compact` 或 local LLM summary，手动 `/compact` 与自动 compaction 共用这套路由。[`tasks/compact.rs#L28-L77`](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/tasks/compact.rs#L28-L77) [`turn.rs#L1219-L1298`](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/session/turn.rs#L1219-L1298)

local compaction 把当前 history 加上 synthetic summarization prompt 发给模型。完成后，它从原历史抽取 real user messages，从新到旧保留最多 20,000 近似 token；跨界的最老一条 user text 可做 token truncation，然后附加 model 生成的 summary。旧 assistant/reasoning/tool transcript 不以原结构进入 replacement history，而是依赖 summary 表达。[`compact.rs#L245-L293`](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/compact.rs#L245-L293) [`compact.rs#L352-L390`](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/compact.rs#L352-L390) [`compact.rs#L645-L733`](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/compact.rs#L645-L733)

system/base instructions 不作为普通 user history 永久复制。pre-turn/manual compaction 清掉旧 reference-context pointer，使下一次普通 turn 重新注入完整 canonical initial context；mid-turn 则把它插到最后一个真实 user message 前，以满足模型训练所需的 summary 位置。[`compact.rs#L63-L78`](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/compact.rs#L63-L78) [`compact.rs#L367-L388`](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/compact.rs#L367-L388)

remote 路径把完整 structured history 与 tool specs 交给 provider compact endpoint，安装其返回的 replacement history。发送前若 request 太大，它只重写较旧的 function/custom-tool output payload，保留原 `call_id`、名称和配对结构；重写按 history item group 进行，不删除孤立一边。[`compact_remote_request.rs#L23-L102`](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/compact_remote_request.rs#L23-L102) [`compact_remote.rs#L402-L490`](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/compact_remote.rs#L402-L490)

remote output 安装前会删除远端可能返回的 stale developer/prefix wrappers，再从本地 canonical state 重新注入 context。legacy remote compact 不保留 harness metadata sidecar，remote v2 才保留；这是当前可见实现的明确限制。[`compact_remote.rs#L335-L399`](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/compact_remote.rs#L335-L399) [`compact_remote.rs#L266-L299`](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/compact_remote.rs#L266-L299)

### overflow、持久化与提示

普通 sampling 遇到 `ContextWindowExceeded` 时，Codex 把 Session token state 标为 full 并返回错误；源码中没有在同一失败请求内直接 compact-and-retry。若用户继续，下一次 pre-turn 检查会先 compact。此结论只针对本快照公开 client 路径。[`turn.rs#L1415-L1450`](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/session/turn.rs#L1415-L1450) [`turn.rs#L1052-L1081`](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/session/turn.rs#L1052-L1081)

local compaction request 自己若 overflow，会从开头移除一个 history item、重新尝试，直到只剩一个 item；其他 retryable stream error 使用 provider 的 `stream_max_retries` 和 backoff。[`compact.rs#L263-L348`](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/compact.rs#L263-L348)

成功 compaction 会原子替换内存活动历史，并把一个 `CompactedItem` 追加到 rollout。该 item 自身保存 replacement history、window IDs、compaction response ID 和最新 token usage；append-only rollout 中更早的原始 item 仍在，因此恢复时可从最新 checkpoint 重建，而不是物理删除原 transcript。[`session/mod.rs#L3750-L3807`](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/session/mod.rs#L3750-L3807) [`history/src/lib.rs#L156-L173`](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/history/src/lib.rs#L156-L173)

UI 收到独立 `ContextCompaction` turn item；agent status 显示 `Compacted context`。local 成功后还显示 warning：长线程和多次 compaction 可能降低准确度，建议尽量新开线程。[`agent_status_feed.rs#L190-L196`](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/tui/src/app/agent_status_feed.rs#L190-L196) [`compact.rs#L393-L399`](https://github.com/openai/codex/blob/eb10d91e48ccbd0930427461fb392337addb1ac0/codex-rs/core/src/compact.rs#L393-L399)

## Pi

### 触发与 token 估算

Pi 的规则最直接：`contextTokens > contextWindow - reserveTokens`。默认 `reserveTokens=16384`，auto enabled；最近 verbatim tail 默认 `keepRecentTokens=20000`。三项都可在 global/project settings 配置。[`compaction.ts#L126-L136`](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/compaction/compaction.ts#L126-L136) [`compaction.ts#L232-L238`](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/compaction/compaction.ts#L232-L238) [`settings.md#L116-L130`](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/docs/settings.md#L116-L130)

估算优先采用最后一个有效 assistant 的 provider usage，再给它后面的 user/tool 消息加 `chars/4` 估算；无有效 usage 时全部估算。图片按 4,800 chars 估算，assistant thinking 与 tool arguments 也计入。[`compaction.ts#L142-L229`](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/compaction/compaction.ts#L142-L229) [`compaction.ts#L244-L303`](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/compaction/compaction.ts#L244-L303)

检查发生在新 user prompt 前、一次 agent run 后，以及 multi-step agent run 中 tool results 已加入但下一次 assistant 尚未开始的边界。后一处会直接在同一个 run 内 compact 后继续。[`compaction.md#L27-L39`](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/docs/compaction.md#L27-L39) [`agent-session.ts#L543-L559`](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/agent-session.ts#L543-L559)

### cut point、Tool 完整性与 rolling summary

Pi 从尾部向前累计估算 token，选择接近 `keepRecentTokens` 的合法 cut point。合法点包括 user、assistant、bash execution 与 custom/summary message，**明确排除 tool result**；从带 tool call 的 assistant 开始保留时，其后 results 也一并保留。[`compaction.ts#L308-L363`](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/compaction/compaction.ts#L308-L363) [`compaction.ts#L387-L460`](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/compaction/compaction.ts#L387-L460)

通常在完整 user turn 边界切。若单个 turn 自身超过 keep budget，Pi 允许在 assistant 边界切开，并分别总结更早 history 与该超大 turn 的 prefix，再合并成一个 summary。这是四者中对“单个 agent turn 本身巨大”的公开设计最明确者。[`compaction.md#L83-L119`](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/docs/compaction.md#L83-L119) [`compaction.ts#L750-L828`](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/compaction/compaction.ts#L750-L828)

summary 有固定的 Goal、Constraints、Progress、Key Decisions、Next Steps、Critical Context 结构，并累计 read/modified file lists。重复 compaction 会把 previous summary 与此前保留、现在要压缩的 tail 一起更新，避免只压缩“上次 checkpoint 之后”而漏掉先前 tail。[`compaction.md#L217-L271`](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/docs/compaction.md#L217-L271) [`compaction.ts#L766-L810`](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/compaction/compaction.ts#L766-L810)

### overflow recovery、持久化与提示

Pi 明确区分三类自动压缩：provider context overflow / recoverable length 且需要 retry、成功响应但 usage 已 overflow、普通 threshold。第一类先从活动 agent state 移除失败 assistant，compact，再 `continue()` 一次；失败响应仍留在 Session JSONL。第二次再 overflow 时终止并给出明确错误，避免无限副作用重放。[`agent-session.ts#L2105-L2196`](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/agent-session.ts#L2105-L2196) [`agent-session.ts#L2381-L2391`](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/agent-session.ts#L2381-L2391)

成功后 Pi 追加 `CompactionEntry { summary, firstKeptEntryId, tokensBefore, usage, details }`，然后从 entry tree 重建活动 context 为 compaction summary + `firstKeptEntryId` 起的 entry；旧 entries 不删除。[`session-manager.ts#L430-L469`](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/session-manager.ts#L430-L469) [`session-manager.ts#L1100-L1119`](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/session-manager.ts#L1100-L1119)

TUI 显示 compaction progress；成功后重绘活动 transcript，增加可展开的 `[compaction] Compacted from N tokens` 卡片，失败/取消也显式显示。summary generation 的 transient error 使用和 agent turn 相同的 retry budget/backoff。[`interactive-mode.ts#L3399-L3457`](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L3399-L3457) [`compaction-summary-message.ts#L32-L57`](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/modes/interactive/components/compaction-summary-message.ts#L32-L57) [`agent-session.ts#L2842-L2869`](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/agent-session.ts#L2842-L2869)

extension 可在 `session_before_compact` 取消或提供自定义 summary/cut point/details；这给高级用户很大自由，也意味着 extension 必须自行维护结构与 token 不变量。[`compaction.md#L273-L311`](https://github.com/badlogic/pi-mono/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/docs/compaction.md#L273-L311)

## Kimi Code CLI

### 触发与预算

Kimi 同时使用两个阈值，任一先到就自动 compact：

```text
context_tokens >= max_context_size * compaction_trigger_ratio
OR
context_tokens + reserved_context_size >= max_context_size
```

默认 ratio 为 0.85、reserved 为 50,000；对 200k 模型通常 reserved 条件先在 150k 触发，对 1M 模型则 ratio 先在 850k 触发。[`compaction.py#L60-L76`](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/src/kimi_cli/soul/compaction.py#L60-L76) [`config-files.md#L150-L160`](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/docs/en/configuration/config-files.md#L150-L160)

token count 在有 provider usage 时更新为 input/total；新加但尚无 usage 的 user/tool text 用 `chars/4` 暂估。该估算明确可能低估 CJK，下一次真实 usage 才校正。检查位于每个 agent step 调 provider 前。[`context.py#L67-L77`](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/src/kimi_cli/soul/context.py#L67-L77) [`compaction.py#L48-L57`](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/src/kimi_cli/soul/compaction.py#L48-L57) [`kimisoul.py#L1014-L1032`](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/src/kimi_cli/soul/kimisoul.py#L1014-L1032)

另外，Kimi provider 的 `max_completion_tokens` 会按完整 request estimate 和剩余 context 动态收窄。这是“输出预算”保护，不等同于 history compaction，但能减少固定大 output allowance 造成的溢出。[`kimisoul.py#L1350-L1387`](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/src/kimi_cli/soul/kimisoul.py#L1350-L1387)

### 压缩算法与结构

当前 `SimpleCompaction` 的保留策略不是 token tail，而是从后向前数 user/assistant role message，默认保留最近 2 条，并保留起点后的全部 tool 等消息。更早消息只抽取 `TextPart`，按 role 标注后作为单个 user message 交给 compaction LLM；summary 中的 thinking 会被丢弃，结果包装成一个带 `Previous context has been compacted` system marker 的 user message。[`compaction.py#L110-L148`](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/src/kimi_cli/soul/compaction.py#L110-L148) [`compaction.py#L154-L198`](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/src/kimi_cli/soul/compaction.py#L154-L198)

因此 tail 起点不会落在 tool result：若起点是发出 tool call 的 assistant，后面的 tool results 全部保留；若起点是 user，也保留该 turn 的全部后续消息。发送普通请求前的 normalization 也明确只合并相邻 user messages，从不合并 assistant/tool，理由正是二者的 `tool_calls` / `tool_call_id` 必须保持配对。[`dynamic_injection.py#L58-L84`](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/src/kimi_cli/soul/dynamic_injection.py#L58-L84)

限制是：被压缩 head 中的非文本 media、thinking 和 tool-call 结构不会原样进入 summarization input；它们只能通过可提取的文本和模型 summary 保留语义。`max_preserved_messages=2` 当前在构造 `SimpleCompaction()` 时硬编码，旁边仍有 `TODO: maybe configurable`，不能由现有 `loop_control` 配置。[`kimisoul.py#L244-L251`](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/src/kimi_cli/soul/kimisoul.py#L244-L251)

### overflow、持久化与提示

成功生成 summary 后，Kimi 调用 `Context.clear()`：先把当前 context 文件移动到 rotation 路径，再创建新的活动文件，重写当前 system prompt、checkpoint、summary + tail 和新 usage estimate。也就是说，原始历史不会留在“当前活动 context”的同一 append-only 日志中，但会作为 rotated file 留档。[`context.py#L202-L230`](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/src/kimi_cli/soul/context.py#L202-L230) [`kimisoul.py#L1573-L1598`](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/src/kimi_cli/soul/kimisoul.py#L1573-L1598)

compaction LLM call 对 network、timeout、empty response、429、5xx 做最多 `max_retries_per_step` 次带 jitter 的 retry。context-length 400 虽会在 telemetry 中分类为 `context_overflow`，但不在 `_is_retryable_error` 的 retry 表内；普通 step 失败后也没有观察到自动 compact-and-retry。因此若本地估算（尤其 CJK 或非文本 payload）漏判，当前 turn 会终止，用户需再次提交或手工 `/compact`。这是由公开 control flow 得出的结论，不推断 provider 层是否另有行为。[`kimisoul.py#L114-L156`](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/src/kimi_cli/soul/kimisoul.py#L114-L156) [`kimisoul.py#L1502-L1519`](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/src/kimi_cli/soul/kimisoul.py#L1502-L1519) [`kimisoul.py#L1646-L1658`](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/src/kimi_cli/soul/kimisoul.py#L1646-L1658)

UI 会消费 `CompactionBegin/End`，在执行中显示 `Compacting...` spinner；这两个 event 没有 summary、token before/after 等展示 payload。另有常驻状态栏显示 `context: used/max` 和百分比。官方文档提供 `/compact [custom instruction]`。[`_live_view.py#L451-L458`](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/src/kimi_cli/ui/shell/visualize/_live_view.py#L451-L458) [`wire/types.py#L99-L116`](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/src/kimi_cli/wire/types.py#L99-L116) [`sessions.md#L125-L140`](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/docs/en/guides/sessions.md#L125-L140)

## 横向结论

### 1. 主流方案是“两层历史”，不是 destructive truncation

OpenCode、Codex、Pi 都把完整 Session 轨迹与活动 model context 分开：原始 message/item/entry 持久保留，compaction checkpoint 决定后续模型读哪些内容。Kimi 的数据布局不同，但也先轮转旧文件再重写活动文件，而不是无备份覆盖。

因此应避免把 Susan 的领域对象都叫 `history`。至少区分：

- **Session Transcript**：持久、可恢复、可审计的真实事件；
- **Model Context**：某次 provider request 的派生输入；
- **Compaction Checkpoint**：把 transcript 的一段映射成 summary + retained tail 的持久决策点。

### 2. 触发应结合真实 usage、尾部估算与 provider error

四者都接受 token count 不是始终精确的现实：优先用 provider usage；tool result / queued message 再做本地估算。OpenCode 与 Pi 还把 provider overflow 当作 compaction signal；Pi 将 recovery 限为一次。Kimi 展示了仅靠 `chars/4` 的已知 CJK 误差，Codex 则用 effective context percent 留硬余量。

对 Susan 0.0.1，最稳妥的最小策略不是接 tokenizer，而是：

1. 用最近 provider usage 作为已确认 baseline；
2. 对 baseline 后新增的完整 message/tool result 做可解释的近似估算；
3. 在 context window 前保留固定 output/safety headroom；
4. 对可识别的 provider context-overflow 做**至多一次** compact-and-retry；
5. retry 前确认尚未产生不可重放的 tool side effect。

第 4–5 点是研究启示，不是四者的一致实现。

### 3. 保留边界必须落在内部结构边界

主流实现并不要求永远保留完整 user turn：OpenCode 与 Pi 都允许在超大 turn 内从 assistant message 切，Codex local 甚至只保留 user text + summary。真正不可破坏的是 provider 需要的结构不变量：

- 不从 tool result 起切；
- 不保留无 call 的 result 或无 result 的已完成 call；
- 若要缩小 tool output，保留 call/result envelope、call ID 和错误状态，仅替换 output payload；
- 未完成、有副作用的当前 step 不应被静默 replay。

Pi 的 cut-point 规则与 Codex remote 的 output rewrite 是最直接的可复用样板。

### 4. Summary 应是 rolling checkpoint，并保留 recent verbatim tail

OpenCode 与 Pi 都把 previous summary 和新近被压缩内容合并更新，且另留 recent tail。这样既避免无限累积多个 summary，也减少模型仅凭摘要继续当前代码工作的失真。Kimi 的“固定两条 role message”简单但与 token 大小无关；Codex local 的“20k user text + summary”更偏向保护用户原始意图。

Susan 需要在 grilling 中决定的不是“summary 还是 truncation”二选一，而是：

- tail 按完整 user turn、完整 message，还是 token budget；
- 单个 turn 大于 tail budget 时是否允许从 assistant/tool batch 边界切；
- previous summary 是迭代更新，还是每次从完整 transcript 重算；
- 是否原样保留所有历史 user 指令，还是只依赖 summary。

### 5. Tool-output bounding 是独立层

OpenCode 的 compaction summarization input 会把旧 tool output 限为 2,000 chars，并另有可选 old-output pruning；Codex remote 在 compact request 太大时改写 output payload；Pi 只在 summary serialization 中把 tool result 限为 2,000 chars；Kimi 另在 MCP tool boundary 做 100k chars producer cap。它们都没有把“单次 tool 输出过大”和“整个会话太长”视为同一算法。

Susan 0.0.1 若已有 Tool output 截断，应保留两层：Tool settle 时的单输出上限，以及 turn 之间的 conversation compaction。前者必须告诉模型内容被截断，并最好提供完整输出的可读取路径；后者才决定历史留存。

## 建议用于下一轮 grilling 的问题

1. Susan 的 destination 是“保证请求不被 provider 拒绝”，还是还包括“长会话中尽量不丢执行状态”？后者需要 rolling structured summary，而非仅删除最旧 turn。
2. v0.0.1 是否接受主流的三层对象：完整 Session Transcript、派生 Model Context、持久 Compaction Checkpoint？
3. 自动触发是采用固定 absolute reserve，还是 `min(fixed reserve, model max output)`；是否另加 context 百分比硬阈值？
4. recent tail 选择完整 user turn，还是像 Pi/OpenCode 一样允许在超大 turn 的 assistant message 边界切？
5. provider overflow 后是否允许 compact-and-retry 一次？只有“尚无 tool side effect / 未产生 durable assistant content”时才重试，是否可接受？
6. v0.0.1 summary 是否固定结构（Goal、Constraints、Progress、Decisions、Next Steps、Critical Context、Files），并在重复 compaction 时滚动更新？
7. compaction 成功、失败、取消分别在 TUI 如何显示：只显示一条 marker，还是像 Pi 一样可展开 summary 与 token before/after？
8. 哪些配置属于用户产品面：只开放 auto on/off，还是同时开放 reserve、tail budget 与 summary prompt？

## 研究边界

- 本报告比较的是指定 commit 的公开 client 实现，不代表托管服务内部策略，也不保证未来版本不变。
- Codex remote compaction 的 summary/selection 算法在服务端，公开 client 只能验证请求、返回 replacement history 的安装与结构修复；不能声称其具体摘要算法。
- “保持 Tool call/result 完整”是指 retained structured tail 的协议配对。已被 summary 覆盖的旧 tool execution 不再以原结构发送给模型，但仍应在持久 transcript 中可审计。
- token estimate 都有误差；provider usage 也通常只描述上一次成功请求，不能直接等同下一次完整 request 的精确大小。
