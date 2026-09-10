---
status: accepted
supersedes: ADR-0001
---

# Agent Loop 取消 Tool Batch 上限与 Tool Round 预算

Agent Loop 不再对单个 Tool Batch 的 Tool Call 数量设 8 个上限，也不再对一次用户输入设 20 个 Tool Round 预算及触顶后的无 Tool 收尾请求；终止条件只剩三条——模型停止调用 Tool、用户 interrupt、Provider Failure。调研确认 Pi 主线对这两处都不设任何上限，也显式不启用别的 runaway guardrail（见 `docs/research/2026-09-09-pi-agent-loop-limits.md`），Susan 对齐该现状，唯一逃生口是用户 interrupt——这是 Yolo 哲学的延伸：宁可信任模型并暴露中断手段，也不在 Harness 层预判失控。串行执行的决策保持不变（理由见 ADR-0001，仍生效）：Tool Result 顺序与 Session Transcript 保持确定。`ETOOL_BATCH_LIMIT` 从共享错误码中删除；若未来出现失控循环，其实际下场与 Pi 一致——token 成本累积，直至 context overflow 恢复失败报错终止。
