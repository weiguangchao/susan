# Susan

个人使用的最小化 harness agent，以 TUI 形态运行，TypeScript 实现，以 npm 包 `@weiguangchao/susan` 分发，命令为 `susan`。

## Language

**Harness**:
围绕 LLM 的运行外壳：把用户消息、Tool 调用、Tool 结果、Approval Policy、上下文管理串成一个循环。TUI 只是它的一个前端。
_Avoid_: framework, runtime, engine

**Agent Loop**:
Harness 的核心循环：一次用户输入触发的「模型输出 → Tool 调用 → Tool 结果回填 → 再次模型输出」直到模型不再请求 Tool。
_Avoid_: turn loop, chat loop

**Tool**:
Harness 暴露给模型、可由模型请求调用的一项能力（v1：网络搜索、读文件）。
_Avoid_: function, plugin, skill

**Approval Policy**:
决定一次 Tool 调用是否需要用户确认的规则。v1 有两种：逐次审批（默认）与 yolo。
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
Session JSONL 中 append-only 的事件行；0.0.1 包含 message 与 compaction。
_Avoid_: row, entry

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
`~/.susan/config.json` 中的用户配置，优先级低于环境变量与 CLI flag。
_Avoid_: settings, preferences
