# Harness 统一控制 Provider 重试

susan 0.0.1 关闭 SDK 的隐式重试，由 Harness 对网络错误、请求超时、HTTP 408 / 409 / 429 / 5xx 最多重试两次，并显式限制 timeout 与退避；其他 4xx、Provider protocol error 和用户中断不重试。这样 TUI 能呈现每次重试，所有 Provider adapter 共享确定的行为，也避免 SDK 默认的十分钟 timeout 或过长 `Retry-After` 让交互失去响应。

自动重试只发生在尚未产生语义输出时；streaming 已产生 text、reasoning 或 Tool Call 后发生故障，结果成为 Interrupted Response，由用户决定是否重试。这接受极少数请求可能重复计费的风险，但避免自动重放造成重复内容或 Tool Call。

Provider Failure 或 Interrupted Response 后，Session Transcript 保留到最后一个稳定边界，Agent Loop 成为 Pending Agent Loop。恢复 Session 时不自动请求 Provider，只向用户提供显式重试；重试继续原 Agent Loop，不重复追加已经持久化的 user message、Tool Call 或 Tool Result。
