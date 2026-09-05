# Tool 完成态只保留有界的 Canonical Tool Result

Susan 的每个 Tool 以统一成功/失败 envelope 返回 Tool 专属数据、稳定错误与共享 truncation metadata，并对所有可变长模型输出共同执行 50 KiB JSON-byte budget。模型、Session Transcript 与 TUI 完成态消费同一份 Canonical Tool Result，不在内存、Session、临时文件或 UI 中另存未截断副本；相比保留完整原始输出，这牺牲了完成后的任意回看，只在能够准确续读时提供 `nextArguments`，换来持久化规模、恢复语义和模型实际所见内容始终一致。
