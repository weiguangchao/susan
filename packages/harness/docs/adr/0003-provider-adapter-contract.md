# Provider Adapter 暴露 provider-neutral 契约

susan 0.0.1 把官方 SDK、wire type、`maxRetries: 0` 和 60 秒 request timeout 封闭在 `openai-completion` Provider Adapter 内，core 只依赖 provider-neutral 的 Provider Request、Provider Stream Event 与 typed Provider Failure。这使 Harness 能统一执行重试与稳定边界策略，也让未来 Anthropic / Responses adapter 不必改动 Agent Loop；未知上游字段被忽略，但已消费字段的 malformed shape fail closed 并终止 Agent Loop。
