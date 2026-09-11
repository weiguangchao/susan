# cwd 是可见执行边界而非 sandbox

> 部分已取代：[决策：read、write、edit 的 Tool 文案](https://github.com/weiguangchao/susan/issues/91#issuecomment-5628278674) 确立 Pi 对齐；write/edit 跟随最终 symlink，使用共享文件写入队列与直接写盘，移除临时文件替换和冲突复检。以下保留原决策历史。

Built-in Tool Set 以 Session Header 中稳定的 Session cwd 解析相对路径，并以 canonical Session cwd 与 Real Target Path 判定 cwd 内外；cwd 外路径仍按 Yolo 执行，但 Tool Result 与 TUI 必须如实标记，且 `bash` 的规则只约束 `bash.cwd`、不约束 command 内的访问。显式只读入口可跟随 symlink，递归遍历不解引用 symlink，`write` 与 `edit` 拒绝最终 symlink；无法确定真实目标时停止执行。该边界只提供稳定语义与清晰呈现，接受路径检查和操作之间的 TOCTOU，不宣称 OS sandbox 或安全隔离。
