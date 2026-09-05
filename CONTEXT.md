# Susan

个人使用的最小化 harness agent，以 TUI 形态运行，TypeScript 实现，以 npm 包 `@weiguangchao/susan` 分发，命令为 `susan`。

## Language

**Harness**:
围绕 LLM 的运行外壳：把用户消息、Tool 调用、Tool 结果、Approval Policy、上下文管理串成一个循环。TUI 只是它的一个前端。
_Avoid_: framework, runtime, engine

**Provider Type**:
Config entry 中的 wire protocol 标识。0.0.1 只注册 `openai-completion`，其他合法但未注册的值 fail-fast。
_Avoid_: provider alias, backend name

**Model Catalog**:
单个 provider entry 中可选静态声明的模型集合；省略时 `/model` 对该 provider 显示空目录，该 provider 不可被应用，根节点 `defaultModel` 也不能激活它。模型默认参数在代码中定义，需要定制时由具体模型条目覆盖 context window 与最大输出 tokens，Reasoning Effort 由代码中的 Provider Type 常量提供。
_Avoid_: model registry, model discovery result

**Agent Loop**:
Harness 的核心循环：一次用户输入触发的「模型输出 → Tool 调用 → Tool 结果回填 → 再次模型输出」直到模型不再请求 Tool。
_Avoid_: turn loop, chat loop

**Tool Round**:
Agent Loop 中从模型发出一个 Tool Batch，到该批全部 Tool Result 回填完成的一轮。
_Avoid_: iteration, step

**Tool Batch**:
模型在同一条 assistant 输出中请求的一组 Tool Call；单个 Tool Call 也构成一个 Tool Batch。
_Avoid_: parallel tools, tool group

**Tool**:
Harness 暴露给模型、可由模型请求调用的一项能力（v0.0.1：读文件）。
_Avoid_: function, plugin, skill

**Read File Tool**:
0.0.1 唯一的 Tool，按 `path + offset + limit` 读取 UTF-8 文本，并返回结构化分页与截断信息。
_Avoid_: file reader, cat tool

**Tool Result**:
Harness 回填给模型的一次 Tool Call 结果，可以成功，也可以携带可供模型处理的失败信息。
_Avoid_: tool response, tool output

**LLM Provider**:
向 Harness 提供模型推理能力的上游服务，例如 DeepSeek、OpenAI 或 Anthropic。
_Avoid_: search provider, backend

**Provider Adapter**:
把 Harness 的 provider-neutral Completion 请求翻译为某个 LLM Provider wire protocol 的边界组件；0.0.1 只注册 `openai-completion`。
_Avoid_: SDK, API client, provider plugin

**Reasoning Effort**:
Provider-neutral 的离散模型推理投入档位；集合与顺序由 Provider Type 的代码常量定义，Config 可省略默认档位，但缺失时没有隐式 fallback，需要用户重新选择 model 并显式设置；TUI 启动时提示配置未完成，不强制打开选择器。
_Avoid_: thinking level, reasoning budget, extended thinking

**Provider Stream Event**:
Provider Adapter 归一化后的 streaming 进度事件；它以完成或失败作为唯一 terminal event，Agent Loop 不直接消费上游 chunk。
_Avoid_: provider chunk, raw delta

**Provider Failure**:
LLM Provider 未能返回完整有效响应的 Harness 级故障；不可重试或耗尽重试预算后，它终止当前 Agent Loop，不会转换成 Tool Result。
_Avoid_: tool error, model error, provider exception

**Interrupted Response**:
已产生语义输出但未成功结束的 streaming 响应。它可以在 TUI 中保留为中断状态，但不作为完整 assistant message 写入 Session Transcript。
_Avoid_: partial response, failed message

**Pending Agent Loop**:
因 Provider Failure、Interrupted Response 或进程退出而停在稳定边界、尚未得到完整最终响应的 Agent Loop。恢复 Session 时只能由用户显式重试，不自动请求 LLM Provider。
_Avoid_: unfinished session, pending message, auto-resume

**Approval Policy**:
决定一次 Tool 调用是否需要用户确认的规则。v0.0.1 有两种：逐次审批（默认）与 yolo。
_Avoid_: permission mode, auto-approve flag

**Yolo**:
一种 Approval Policy：所有 Tool 调用自动放行，不弹确认。
_Avoid_: auto mode, unattended mode

**Session**:
一次连续的对话及其完整消息历史，可落盘并在下次启动时恢复。
_Avoid_: conversation, thread, chat

**Session Store**:
持久化 Session Transcript 的无 UI adapter，负责 append-only JSONL 的写入与恢复。
_Avoid_: database, session service

**Session Header**:
Session JSONL 首行的 metadata，包括 version、id、createdAt 与 cwd。
_Avoid_: front matter, metadata block

**Session Record**:
Session JSONL 中 append-only 的事件行；0.0.1 包含 message、usage 与 compaction。
_Avoid_: row, entry

**Session Token Usage**:
一个 Session 内所有已完成 Provider 请求的 input + output token 累计值；每条 usage record 保存一次请求的上游 usage，用于恢复状态栏统计。
_Avoid_: model context, context estimation

**Session Transcript**:
Session 中持久保留、可恢复与审计的完整事件记录。Compaction 不会删除其中的早期内容。
_Avoid_: history, log

**Model Context**:
Harness 为某次模型请求从 Session Transcript 派生的活动上下文，可由早期内容的摘要与近期原文组成。
_Avoid_: history, messages

**Context Estimation**:
基于 provider usage baseline 与 UTF-8 byte / 3 的保守增量估算，用于判断 Model Context 是否接近窗口上限。
_Avoid_: token count, tokenizer

**System Prompt**:
Harness 为每次模型请求注入的 canonical 行为指令，用于定义 Agent 身份与基础约束；不作为用户消息或 Session Transcript 的一部分。
_Avoid_: user instructions, project rules, custom prompt

**Compaction**:
为延续长 Session，用 rolling structured summary 替代 Model Context 中的早期内容，同时保留近期原文的过程。
_Avoid_: truncation, deletion

**Compaction Checkpoint**:
一次 Compaction 的持久结果，记录 rolling structured summary 与 recent tail 的保留边界，用于恢复 Model Context。
_Avoid_: snapshot, truncated history

**Config**:
`~/.susan/config.json` 中的用户配置；v0.0.1 仅允许 CLI flag 覆盖，不支持环境变量覆盖。
_Avoid_: settings, preferences

**Resolved Config**:
用户 Config 加上内存默认值与 CLI flag 覆盖后形成的运行时配置。`defaultProvider`、`defaultModel` 与 `defaultReasoningEffort` 均可省略；三者省略时均没有隐式 fallback，需要用户手动选择后由 `/model` 回写。`defaultProvider` 省略时，`defaultModel` 与 `defaultReasoningEffort` 可以成对出现或同时省略；成对出现时它们只是 `/model` 的偏好值，不是 Active Model Configuration，`/model` 仅以 Config JSON 中的第一个 provider 作为浏览起点。
_Avoid_: effective config, merged config

**Active Model Configuration**:
当前 Harness 请求使用的 provider、model 与 Reasoning Effort；三者完整时才可发起请求，提交或重试时若任一项缺失则打开 `/model` 选择器。`/model` 只在 Agent Loop 空闲或 Pending 时切换。
_Avoid_: session model, transient model, per-message model

**Config Error**:
Config 读取 / 解析 / strict schema / 权限 / provider 选择失败时产生的结构化错误，带 code 与字段 path。
_Avoid_: validation exception, config warning
