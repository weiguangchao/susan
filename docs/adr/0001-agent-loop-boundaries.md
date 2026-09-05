# Agent Loop 串行执行 Tool Batch 并设置双重预算

susan 接受模型在一次输出中请求多个 Tool Call，但按出现顺序串行执行；相比并发执行，这让 Tool Result 顺序与 Session Transcript 保持确定。所有 Tool Call 按 Yolo 直接放行，不存在逐次审批。每个 Tool Batch 最多 8 个 Tool Call，每次用户输入最多 20 个 Tool Round，触顶后只允许一次关闭 Tool 的收尾请求，以同时限制失控循环和单批资源消耗。

Tool 的业务错误、意外异常与超时都转换为带稳定 code 的 Tool Result，让模型有机会解释或修正；Provider、持久化或内部状态故障仍终止 Agent Loop。此边界刻意区分“Tool 执行失败”与“Harness 无法继续”，避免局部失败破坏整个 Session。
