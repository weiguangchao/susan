# 0.0.1 只注册 openai-completion 并调用 Chat Completions

susan 0.0.1 的 Agent 内部统一采用 Completion `messages` 形态，Provider 层只注册 `openai-completion` adapter，线上经 DeepSeek `/chat/completions` 调用。表面上这是“只接 OpenAI 协议”，实际是把 openai-compatible wire protocol 作为唯一 0.0.1 落地路径；相比 Responses 或 Anthropic，它更贴合当前上游能力，也让未来新增其他 wire protocol 不必重写 Agent Loop。代价是 0.0.1 放弃 hosted web search 与服务端会话，必须自管 messages、Tool loop 与上下文恢复。
