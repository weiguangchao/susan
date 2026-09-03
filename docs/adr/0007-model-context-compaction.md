# Model Context 采用 Compaction 而非删除旧消息

susan 0.0.1 不用“丢最旧消息”的 destructive truncation，而是把 Session Transcript 与 Model Context 分层，并在接近 provider context window 时用 rolling structured summary + recent tail 生成 Compaction Checkpoint。这个策略以 best-effort 换取长 Session 连续性，同时明确摘要不承诺无损；相比简单截断，它增加估算、summary 请求与失败恢复复杂度。0.0.1 选择这条路线，是因为保持用户意图与关键决策的连续性，比机械保留最近几条消息更重要。
