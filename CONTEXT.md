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

**Config**:
`~/.susan/config.json` 中的用户配置，优先级低于环境变量与 CLI flag。
_Avoid_: settings, preferences
