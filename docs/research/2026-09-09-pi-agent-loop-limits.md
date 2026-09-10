# Pi Agent Loop 的工具批次上限与轮次预算调研

> 日期：2026-09-09  
> 范围：只验证 Pi（badlogic/pi-mono，现重定向为 earendil-works/pi）主线上 (1) 单个 assistant output 的 tool batch 是否有数量上限、(2) 每次 user input 是否有轮次/迭代预算、(3) agent loop 的终止条件清单；不替 Susan 做产品选择。  
> 证据快照：当前 main [`400d690`](https://github.com/earendil-works/pi/tree/400d6905ce46ec46e79da8a7701b1b48850192df)（2026-09-09）、旧快照 [`b8b873b`](https://github.com/earendil-works/pi/tree/b8b873b9872db04a938fb4357b5e8e824ddc051c)。事实只取自该仓库源码与文档；`github.com/badlogic/pi-mono` 现由 GitHub 301 重定向至 `github.com/earendil-works/pi`（`gh api repos/badlogic/pi-mono` 返回 `full_name: earendil-works/pi`），两 URL 指向同一仓库。

## 结论先行

对三条维护者断言的核验结果：

| # | 断言 | 结论 |
|---|---|---|
| 1 | 单个 tool batch 无数量上限 | **属实** |
| 2 | 无 per-user-input 轮次/迭代预算 | **属实** |
| 3 | 终止条件 = 模型不再调工具 / 用户中断 / provider 失败 | **基本属实但不完整**：还有 tool-result `terminate`、`shouldStopAfterTurn` hook、context overflow 一次性恢复后失败三条路径 |

同时核验：旧快照 `b8b873b` 对这三项事实**不 stale**——`packages/agent/src/agent-loop.ts` 在两个 commit 之间逐字节相同（diff 为空），且两个 commit 的生产代码中都不存在任何 `maxToolCalls`/`maxIterations`/`maxTurns` 类常量。变化仅是新增了 durable harness runtime（同样无上限）。

## 一、架构现状：两条 loop，都没有上限

当前 main 上 Pi 有两套 agent loop：

1. **生产路径（coding-agent CLI 实际使用）**：`main.ts` → `createAgentSessionRuntime` → `AgentSession` → `Agent.prompt()` → `runAgentLoop`，即 `packages/agent/src/agent-loop.ts`。[AgentSession 调用 agent.prompt](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/coding-agent/src/core/agent-session.ts#L1101-L1104) [Agent.prompt → runAgentLoop](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/src/agent.ts#L413-L422)
2. **新 durable harness runtime**（`packages/agent/src/harness/runtime/`，状态机驱动）：目前只在 `packages/coding-agent/src/experimental/`（session-worker、mini 等）接入；规范文档 [harness.md](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/docs/harness.md#L1230) 自己写明"legacy agent loop remains behavioral evidence"。

全仓 grep（`maxToolCalls|maxParallelTools|maxIterations|maxTurns|maxRounds|batchLimit|MAX_TOOL|MAX_ITER|MAX_TURN`，含 `packages/agent`、`packages/coding-agent`、`packages/ai`、`packages/server`、`packages/client`、`packages/chord`、`packages/protocol` 的生产 `.ts`）：**零命中**。唯一出现 `MAX_TURNS` 的是测试脚本 [`packages/coding-agent/test/sdk-codex-cache-probe-tool-loop.ts`](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/coding-agent/test/sdk-codex-cache-probe-tool-loop.ts#L67)（压测脚本自己的 `--turns` CLI 参数上限），不属于产品代码。

## 二、断言 1：tool batch 无数量上限 —— 属实

### 生产 loop（agent-loop.ts）

batch 就是 assistant message 里全部 `toolCall` 内容项，逐个全部执行，没有任何 slice/上限：

- [batch 提取：`message.content.filter((c) => c.type === "toolCall")`](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/src/agent-loop.ts#L222)
- [executeToolCalls：按 tool 定义分派 sequential 或 parallel，二者都处理完整数组](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/src/agent-loop.ts#L409-L424)
- [executeToolCallsParallel：`Promise.all(finalizedCalls.map(...))` 一次并发全部 sibling 调用](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/src/agent-loop.ts#L487-L561)

已知且确认的细节：`stopReason === "length"`（输出被 token 上限截断）时整批不执行、逐个转为 error tool result，[failToolCallsFromTruncatedMessage](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/src/agent-loop.ts#L227-L233)——这是安全性处理，不是批次上限。

### 新 harness runtime

- [publishResponse：把 response 中全部 toolCall 内容规划进同一个 `at: "tools"` batch](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/src/harness/runtime/drive/response.ts#L294-L308)
- [runParallel：遍历 `batch.calls` 全部启动，`Promise.all(jobs)` 等待](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/src/harness/runtime/drive/tools.ts#L611-L653)
- [harness.md §3.8 规定 parallel 模式为 source order 清理 + 并发执行整个 batch](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/docs/harness.md#L796)

一个容易误读的数字：sequential 模式下 [`for (let transition = 0; transition <= batch.calls.length * 2 + 1; ...)`](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/src/harness/runtime/drive/tools.ts#L557) 不是批次上限——它按"每个 call 需要 planned→effect_pending→outcome_ready→completed 的有限状态转移数"推导出的**不变量守护**，超界抛 `SessionInvariantError`（[tools.ts:608](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/src/harness/runtime/drive/tools.ts#L557-L609)），是防状态机 bug 的断言，不是 runtime guardrail。

边界说明：provider 侧对单条 assistant message 的 tool-call 数量可能有自己的 API 约束，但那在 pi-mono 之外；Pi core/pi-ai 层（含各 provider adapter）对数量不施加任何上限。

## 三、断言 2：无轮次/迭代预算 —— 属实

### 生产 loop

主循环是两层无计数器的 `while`：

- [外层 `while (true)`（follow-up 消息驱动续跑）与内层 `while (hasMoreToolCalls || pendingMessages.length > 0)`](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/src/agent-loop.ts#L170-L175)
- [AgentLoopConfig](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/src/types.ts#L149) 全部字段里没有 turn/iteration/round 预算；唯一与"提前停止"相关的是可选 hook `shouldStopAfterTurn`（下文断言 3 详述），而 coding-agent 并未设置它（grep `shouldStopAfterTurn` 在 `packages/coding-agent/src` 零命中，仅 `packages/agent/src/agent.ts` 定义/透传）。

### 新 harness runtime

- 驱动循环为 [`for (;;)` 状态机](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/src/harness/runtime/drive.ts#L48-L105)，每圈按 `state.at` 分派过程；没有任何 turn 计数器或预算字段（grep 零命中）。
- [harness.md §3.7 的 settlement 后继表](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/docs/harness.md#L744-L753)：有 tool calls → `tools`；stop/length → `checkpoint{may_finish}`；工具批结束后的分支见 [§3.8：全部 `terminate:true` → `checkpoint{may_finish}`，否则 `checkpoint{need_assistant}` 继续下一轮](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/docs/harness.md#L794)——继续与否完全由模型是否再发 tool calls 决定。
- auto-compaction 是 token 阈值触发（`reason: "threshold" | "overflow"`），不是轮次触发；文档里"a 30-turn run"只是举例性描述（[harness.md:425](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/docs/harness.md#L425)）。

## 四、断言 3：终止条件清单 —— 基本属实，但不完整

三条已列条件全部属实：

1. **模型不再调用工具**：无 toolCalls → `hasMoreToolCalls = false` → 内层循环退出（[agent-loop.ts:225-258](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/src/agent-loop.ts#L225-L258)）；harness 侧为 `stop` → `checkpoint{may_finish}` → finish（[classification order 第 6 条](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/docs/harness.md#L763-L772)）。
2. **用户中断**：TUI Escape → [`agent.abort()`](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2852-L2856) → AbortSignal 传进 loop → provider stream 与 tool 执行都收到 abort，最终 message `stopReason === "aborted"` → [loop 立即 `agent_end` 返回](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/src/agent-loop.ts#L215-L219)；harness 侧为 `requestAbort` → `cancel_requested` → [normalizeAborted → aborted 终局](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/src/harness/runtime/drive/response.ts#L212-L219)。
3. **provider 失败**：`stopReason === "error"`（重试耗尽后）同样 [立即终止](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/src/agent-loop.ts#L215-L219)；harness 侧 retryable error 先走 [`assistant.retry_wait`（受 `retryPolicy.maxAttempts` 约束）](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/src/harness/runtime/drive/response.ts#L276-L292)，耗尽后 terminal failed。

但完整清单还有三条（对 Susan 的 charting 有意义）：

4. **tool-result `terminate: true`**：batch 内**所有** tool result 都置 `terminate === true` 时，run 不再发下一次 LLM 请求直接结束（[shouldTerminateToolBatch](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/src/agent-loop.ts#L589-L591)、[agent-loop.ts:235](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/src/agent-loop.ts#L226-L241)）。harness.md 明说这是给"submit final result"型 tool 用的机制（[§3.8](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/docs/harness.md#L794)）。`beforeToolCall`/`afterToolCall` hook 也能置 `terminate`（[agent-loop.ts:643-653](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/src/agent-loop.ts#L643-L653)）。
5. **`shouldStopAfterTurn` hook**：每个 turn 结束后可选回调，返回 true 即优雅退出（[agent-loop.ts:252-255](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/src/agent-loop.ts#L252-L255)，CHANGELOG 记载其用途为"gracefully exiting after a completed turn"）。它是**扩展点而非默认预算**——Pi 自己不用它限制轮数，但外部嵌入方可以用它实现自己的 stop 条件。
6. **context overflow 的"一次性恢复"**：生产 loop 中 overflow/可恢复截断触发一次 compact-and-retry，第二次直接报错终止（[agent-session.ts:2179-2197，`_overflowRecoveryAttempted`](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/coding-agent/src/core/agent-session.ts#L2179-L2197)）；harness 侧同语义（[第二次 overflow → terminal failure](https://github.com/earendil-works/pi/blob/400d6905ce46ec46e79da8a7701b1b48850192df/packages/agent/docs/harness.md#L750-L753)）。这是**资源边界而不是轮次预算**：一个无限调工具的 run 最终会以"context overflow recovery failed"失败告终（伴随 token 成本），而不是被一个干净的 turn cap 拦截。

结论：断言 3 的三条是主要的正常路径，但作为"完整终止条件清单"不准确——至少漏了 `terminate` 标志与 `shouldStopAfterTurn` hook 这两个显式编程接口，以及 overflow 恢复失败这条实际兜底。

## 五、旧快照 b8b873b 是否 stale

就本调研的三个事实而言，**不 stale**：

1. [`packages/agent/src/agent-loop.ts` 在 b8b873b 与 400d690 之间逐字节相同](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/agent/src/agent-loop.ts#L171)（本地 diff 为空；两 commit 中该文件的 `while` 结构、终止分支、`terminate`/`shouldStopAfterTurn` 行号一致）。
2. b8b873b 时 coding-agent 就已经通过 [`@earendil-works/pi-agent-core` 的 `Agent` 驱动 loop](https://github.com/earendil-works/pi/blob/b8b873b9872db04a938fb4357b5e8e824ddc051c/packages/coding-agent/src/core/agent-session.ts#L18-L28)，不存在另一条带限制的"older coding-agent loop"；全仓 grep 同样零命中任何 max 常量。
3. 结构性变化只有一处：`packages/agent/src/harness/runtime/`（durable drive 状态机、deferred 轮询、overflow 恢复等）在 b8b873b 之后才加入，但核验后它同样没有批次上限与轮次预算（见第二、三节）。`harness.md` 从早期版本就存在并持续演进，但其 settlement/终止语义与本调研结论一致。

## 六、对 Susan 的含义（本报告不代答）

1. Pi 没有 shipping 任何 loop guardrail（无批次上限、无轮次预算、无 runaway 计数器），susan 若要做"runaway protection"，无法以"对齐 Pi"为由省略该决策——Pi 的现状是**显式不做**，而不是做了别的形式。
2. Pi 提供了三个可实现此类保护的扩展点，可作 Susan 设计参考：`shouldStopAfterTurn`（每 turn 后判定）、`beforeToolCall` block（逐 call 拦截）、tool result `terminate` 标志（工具侧主动收口）。
3. 一个无限循环的 Pi agent 的实际下场是：token 成本持续累积，直到 context overflow 的一次 compaction 恢复也失败后报错终止——若 Susan 想要更早、更可预测的熔断，需要自行引入。
4. sibling 工具并行（`Promise.all` 全量并发）确认与既有认知一致，且批次大小不设上限意味着"并行度 = 模型一次输出的 tool call 数"，这点在评估资源/限流时需注意。

## 研究边界

- "没有上限"指 pi-mono 两个 commit 的公开源码路径；provider API 对单条 message 的 tool-call 数量约束在 pi-mono 之外，本报告未核验外部 provider 文档。
- 生产路径（legacy `agent-loop.ts`）与实验 harness runtime 都已核验；harness.md 标注的 "specified but not implemented" 部分（§0.9）不影响本报告结论——其规范文本本身也未规定任何轮次/批次上限。
- 测试脚本（如 `sdk-codex-cache-probe-tool-loop.ts` 的 `MAX_TURNS = 50`）属于压测工具参数，不代表产品行为。
- 闭源的托管服务端行为（如 provider 侧 retry/限流）不在本报告范围内。
