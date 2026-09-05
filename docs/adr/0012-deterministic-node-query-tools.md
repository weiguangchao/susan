# 查询 Tool 采用确定性的 Node 遍历契约

Susan 的 Grep Tool、Find Tool 与 Ls Tool 使用 Node/TypeScript 原生文件系统遍历，不调用或下载宿主机的 `grep`、`rg`、`find`、`fd` 或 `ls`；三者共享严格、平台无关的 regex/glob、`.gitignore`、symlink、ordinal 排序、Traversal Diagnostic 与 50 KiB Tool Result 语义。查询先在 100,000 个条目和 10 秒工作预算内建立完整候选集，再排序、应用 offset/limit 并生成 continuation，因而预算或 timeout 中断整个查询而不返回可能误称为全局前 N 项的部分结果。该选择牺牲宿主原生命令的特性与潜在性能，以换取模型侧契约、Session Transcript、TUI 完成态以及 Ubuntu、macOS、Windows Node 22 验收结果的一致性。
