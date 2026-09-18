---
status: accepted
---

# Agent Loop 取消 Tool Batch 上限与 Tool Round 预算

Agent Loop 不限制单个 Tool Batch 的 Tool Call 数量，也不限制一次用户输入的 Tool Round 数量，并且不提供触顶后的无 Tool 收尾请求。终止条件只有模型停止调用 Tool、用户 interrupt 或 Provider Failure。调研确认 Pi 主线不设这两处上限，也不启用其他 runaway guardrail，见根目录 `docs/research/2026-09-09-pi-agent-loop-limits.md`。Susan 采用同一行为，由用户 interrupt 提供显式停止手段。失控循环会继续消耗 token，直到用户中断或 context overflow 等 Provider Failure 终止请求。

同一 Tool Batch 中的 Tool Call 按模型输出顺序串行执行。这使 Tool Result 顺序与 Session Transcript 保持确定。Tool 的业务失败、意外异常与超时作为 Tool Result 回填，让模型可以解释或修正；Provider、持久化或 Harness 内部状态故障终止 Agent Loop。局部 Tool 失败不会自动升级为 Harness 故障。
